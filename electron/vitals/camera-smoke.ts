import { SmartSpectraProvider } from "./smartspectra.js";
import type { VitalsProvider, VitalsStatus } from "./provider.js";
import {
  cardioMetrics,
  faceMetrics,
  breathingMetrics,
  edaMetrics,
} from "@smartspectra/node-sdk";
import { attentionFromFace } from "../attention/face.js";

const durationMs = Number(process.env.SMARTSPECTRA_TEST_DURATION_MS ?? 60_000);
const profile = process.env.SMARTSPECTRA_TEST_PROFILE ?? "face";
let provider: VitalsProvider | undefined;

let sampleCount = 0;
let faceSampleCount = 0;
let sawVitalSample = false;
let sawFaceSample = false;

function attachListeners(activeProvider: VitalsProvider): void {
  activeProvider.on("status", (status: VitalsStatus) => {
  if (status.kind === "validation") {
    console.log(`[validation] ${status.hint} (code ${status.code})`);
    return;
  }

  if (status.kind === "diagnostic") {
    console.log(`[diagnostic] ${status.message}`);
    return;
  }

  console.log(`[status] ${status.kind}`);
  });

  activeProvider.on("sample", (sample) => {
    sawVitalSample = true;
    sampleCount += 1;
    console.log(
      `[vitals #${sampleCount}] ` +
        `HR=${sample.hr ?? "n/a"} ` +
        `BR=${sample.br ?? "n/a"} ` +
        `HRV=${sample.hrv ?? "n/a"} ` +
          `confidence=${sample.confidence.toFixed(2)}`,
    );
  });

  activeProvider.on("face", (sample) => {
    sawFaceSample = true;
    faceSampleCount += 1;
    const attention = attentionFromFace(sample);
    console.log(
        `[attention] ` +
          `present=${attention.present} ` +
          `stable=${attention.stable} ` +
          `gaze=${attention.gaze} ` +
          `head=${attention.head} ` +
          `blinking=${attention.blinking} ` +
          `talking=${attention.talking}`,
    );
  });

  activeProvider.on("error", (error) => {
    console.error(`[error] ${error.message}`);
  });
}

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }

  stopping = true;
  if (provider) {
    await provider.stop();
  }
  console.log(
    `Camera test finished: ${sampleCount} vitals samples, ` +
      `${faceSampleCount} face samples.`,
  );
  if (sawFaceSample && !sawVitalSample) {
    console.error(
      "Face tracking worked, but no heart/breathing/HRV sample was returned. " +
        "Check the metric payload diagnostic above. If pulse and breathing " +
        "counts stay at 0, the key or plan may not authorize those metrics, " +
        "or the signal has not reached measurement quality.",
    );
  }
}

process.once("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});

try {
  provider = new SmartSpectraProvider({
    debug: true,
    requestedMetrics:
      profile === "attention"
        ? [...breathingMetrics, ...cardioMetrics, ...faceMetrics]
        : profile === "face"
          ? [...cardioMetrics, ...faceMetrics]
        : profile === "cardio"
          ? [...cardioMetrics]
          : [...breathingMetrics, ...cardioMetrics, ...faceMetrics, ...edaMetrics],
    deviceIndex: process.env.SMARTSPECTRA_CAMERA_INDEX
      ? Number(process.env.SMARTSPECTRA_CAMERA_INDEX)
      : undefined,
  });
  attachListeners(provider);
  await provider.start();
  console.log(
    `Camera test running for ${Math.round(durationMs / 1000)} seconds. ` +
      `Profile: ${profile}. Press Ctrl+C to stop.`,
  );
  setTimeout(() => {
    void stop().finally(() => process.exit(0));
  }, durationMs);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[startup error] ${message}`);
  if (message.includes("SMARTSPECTRA_API_KEY")) {
    console.error(
      "Set the key first: $env:SMARTSPECTRA_API_KEY = \"your-presage-api-key\"",
    );
  }
  await stop().catch((stopError) => {
    console.error(
      `[shutdown error] ${
        stopError instanceof Error ? stopError.message : String(stopError)
      }`,
    );
  });
  process.exitCode = 1;
}
