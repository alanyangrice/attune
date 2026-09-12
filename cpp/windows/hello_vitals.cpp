#include <smartspectra/messages/metrics.h>
#include <smartspectra/smartspectra.h>
#include <smartspectra/smartspectra_config.h>

#include <chrono>
#include <csignal>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

namespace spectra = presage::smartspectra;

namespace {

volatile std::sig_atomic_t stop_requested = 0;
std::mutex output_mutex;

void HandleSignal(int) {
    stop_requested = 1;
}

std::string GetApiKey(int argc, char** argv) {
    if (argc > 1 && argv[1] != nullptr) {
        return argv[1];
    }
    if (const char* value = std::getenv("SMARTSPECTRA_API_KEY")) {
        return value;
    }
    return {};
}

template <typename Value>
void PrintMetric(const char* name, const Value& value, const char* unit) {
    std::lock_guard lock(output_mutex);
    std::cout << std::fixed << std::setprecision(1)
              << name << ": " << value << " " << unit << "\n";
}

void PrintFaceStatus(const spectra::DetectionStatus& status,
                     const char* name) {
    PrintMetric(name, status.detected() ? "yes" : "no", "");
}

}  // namespace

int main(int argc, char** argv) {
    std::signal(SIGINT, HandleSignal);

    const std::string api_key = GetApiKey(argc, argv);
    if (api_key.empty()) {
        std::cerr
            << "Set SMARTSPECTRA_API_KEY or pass the key as the first argument.\n"
            << "Example: .\\build\\Release\\attune_windows_vitals.exe YOUR_KEY\n";
        return 1;
    }

    spectra::SmartSpectraConfig config;
    config.api_key = api_key;
    config.requested_metrics = spectra::SmartSpectraConfig::BreathingMetrics();
    config.AddMetrics(spectra::SmartSpectraConfig::CardioMetrics());
    config.AddMetrics(spectra::SmartSpectraConfig::FaceMetrics());

    spectra::SmartSpectra sdk(config);

    sdk.SetOnMetrics([](const spectra::Metrics& metrics, int64_t) {
        if (metrics.has_cardio()) {
            const auto& cardio = metrics.cardio();
            if (cardio.pulse_rate_size() > 0) {
                PrintMetric(
                    "Heart rate",
                    cardio.pulse_rate(cardio.pulse_rate_size() - 1).value(),
                    "bpm");
            }
            if (cardio.hrv_size() > 0) {
                PrintMetric(
                    "HRV RMSSD",
                    cardio.hrv(cardio.hrv_size() - 1).rmssd(),
                    "ms");
            }
        }

        if (metrics.has_breathing()) {
            const auto& breathing = metrics.breathing();
            if (breathing.rate_size() > 0) {
                PrintMetric(
                    "Breathing rate",
                    breathing.rate(breathing.rate_size() - 1).value(),
                    "bpm");
            }
        }

        if (metrics.has_face()) {
            const auto& face = metrics.face();
            bool face_present = false;
            bool blinking = false;

            if (face.blinking_size() > 0) {
                const auto& status = face.blinking(face.blinking_size() - 1);
                blinking = status.detected();
                PrintFaceStatus(status, "Blinking");
            }
            if (face.talking_size() > 0) {
                PrintFaceStatus(
                    face.talking(face.talking_size() - 1), "Talking");
            }
            if (face.landmarks_size() > 0) {
                face_present = true;
            }

            PrintMetric(
                "Engagement proxy",
                face_present && !blinking ? "present" : "uncertain",
                "");
        }
    });

    sdk.SetOnValidationStatusChanged(
        [](const spectra::ValidationStatus& status, int64_t) {
            std::lock_guard lock(output_mutex);
            std::cout << "Validation [" << static_cast<int>(status.code)
                      << "]: " << status.hint << "\n";
        });

    sdk.SetOnError([](const spectra::SmartSpectraError& error) {
        std::lock_guard lock(output_mutex);
        std::cerr << "SmartSpectra error ["
                  << static_cast<int>(error.code) << "]: "
                  << error.message << "\n";
    });

    if (const auto source_error =
            sdk.UseCamera().SetResolution(1280, 720).SetFps(30).Build();
        !source_error.ok()) {
        std::cerr << "Could not configure camera: "
                  << source_error.message << "\n";
        return 1;
    }

    if (const auto start_error = sdk.Start(); !start_error.ok()) {
        std::cerr << "Could not start SmartSpectra: "
                  << start_error.message << "\n";
        return 1;
    }

    std::cout << "Processing laptop camera. Press Ctrl+C to stop.\n";
    while (!stop_requested) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    if (const auto stop_error = sdk.Stop(); !stop_error.ok()) {
        std::cerr << "Could not stop SmartSpectra: "
                  << stop_error.message << "\n";
        return 1;
    }
    return 0;
}
