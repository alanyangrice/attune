# Copilot instructions for this repository

The repository is being implemented as an Electron/Node app. The source of truth is the product design in `design.md`, the SmartSpectra integration notes in `presage-implementation.md`, and the installed `using-smartspectra` skill at `.agents/skills/using-smartspectra/SKILL.md`; use all three when deciding how a change should fit the project.

## Build, test, and lint commands

The current implementation has one checked-in validation command:

```bash
npm run typecheck
```

To test the laptop camera against the real SmartSpectra provider:

```powershell
$env:SMARTSPECTRA_API_KEY = "your-presage-api-key"
npm run camera:test
```

Use `SMARTSPECTRA_CAMERA_INDEX` to select a non-default camera and `SMARTSPECTRA_TEST_DURATION_MS` to change the test duration. There is no lint script yet.

The native Windows C++ camera test lives in `cpp/windows/`. From an x64 Native
Tools Command Prompt for Visual Studio, set `SMARTSPECTRA_SDK_PATH` to the
extracted Presage Windows SDK and validate with:

```bat
cd /d cpp\windows
set "SMARTSPECTRA_SDK_PATH=C:\SmartSpectra"
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

Run it with:

```bat
set "PATH=%SMARTSPECTRA_SDK_PATH%\bin;%PATH%"
set "SMARTSPECTRA_API_KEY=your-presage-api-key"
.\build\Release\attune_windows_vitals.exe
```

The Windows C++ SDK is experimental and requires a Windows 10/11 x64 machine
with the Desktop development with C++ workload.

The default `attention` camera profile requests breathing, cardio, and face metrics and reports only attention-relevant data. It requires enough upper-chest framing for breathing rate. The `face` profile requests cardio and face metrics without breathing. The `full` profile additionally requests EDA. To explicitly run the face/pulse smoke test, use:

```powershell
$env:SMARTSPECTRA_TEST_PROFILE = "face"
npm run camera:test
```

## High-level architecture

The project is a physiology-aware music intervention app built around a simple closed loop:

1. Measure the user through SmartSpectra.
2. Establish a baseline and infer calm/arousal state.
3. Choose a song or intervention based on that state.
4. Play the audio through Spotify.
5. Measure again and update the personalization profile.

The design documents define a layered architecture:

- SmartSpectra integration: `electron/vitals/provider.ts` defines the app-facing seam and `electron/vitals/smartspectra.ts` owns the real `@smartspectra/node-sdk` lifecycle and payload normalization.
- Physiological measurement layer: short measurement windows, aggregate metrics, and typed domain models should sit between SDK data and the rest of the app.
- Calmness engine: a deterministic baseline-vs-current scoring model is the MVP direction, not an ML-first approach.
- Spotify integration: the app uses Spotify Web API / playback control and PKCE OAuth. Use the minimum necessary scopes and keep secrets out of source control.
- Session controller: a central `CalmSessionController` / `DJSession` layer coordinates measurement, playback, and recommendation decisions.

This is a product with explicit modules, not a single-screen app. The main conceptual boundary is: physiological measurement data must be normalized into app-level models before anything else consumes it.

## Key conventions and repo-specific patterns

- Prefer stable domain models over raw SDK objects. The docs repeatedly say not to pass raw SmartSpectra or Spotify objects through the app; wrap them in dedicated model classes like `VitalsSample`, `MeasurementSession`, `CalmnessScore`, and `SpotifyTrack`.
- Keep the SmartSpectra dependency behind a manager/adapter boundary. The design explicitly expects a `SmartSpectraManager` or equivalent abstraction, with the SDK implementation isolated behind a single seam.
- Use the installed `using-smartspectra` skill for exact SDK signatures and current platform behavior. Prefer the official Node/Electron docs linked by that skill over memory or stale snippets.
- Request metric groups explicitly. The real provider requests breathing, cardio, face, and EDA, then treats missing/empty groups as unavailable data rather than fabricating values.
- Keep `SMARTSPECTRA_API_KEY` in the environment or another secret store; the provider fails clearly when the real adapter is started without it.
- Use short measurement windows instead of continuous monitoring. The design calls for focused sampling windows to reduce noise and keep the user experience comfortable.
- Treat the calmness algorithm as deterministic and tunable at first. The MVP is intentionally rules-based rather than ML-driven; thresholds should be validated experimentally, not treated as medical truth.
- Use PKCE for Spotify auth in the mobile app flow. Keep the API key / client secret outside the repo (`local.properties`, secure CI config, or equivalent). Do not commit secrets.
- Keep all personalization logic grounded in user-specific response data, not in training on Spotify catalog data. The docs specifically warn against using Spotify content to train a model.
- The repo is design-focused and does not yet contain implementation code. Future work should preserve these architecture boundaries rather than re-integrating raw SDK logic directly into UI or session code.

## Working style for future changes

- Start from the design docs before editing code.
- Preserve the separation between measurement, recommendation, and session orchestration.
- Prefer small, typed interfaces over ad hoc state passing.
- If a feature touches both physiology and playback, update the associated app model and controller flow together.

## Related files

- `design.md` — product-level vision and system architecture.
- `presage-implementation.md` — implementation-oriented technical architecture and MVP plan.
