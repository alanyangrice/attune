// Central knobs. Two timing profiles: "real" (design.md numbers) and "demo"
// (compressed so the loop visibly cycles on stage / in the console harness).
// All thresholds live here on purpose — we tune them on humans at the venue.

import { readFileSync } from "node:fs";

// Tiny .env loader (no dep): KEY=VALUE lines, optional surrounding quotes,
// no expansion. Keys are upper-cased so `presage_api_key=…` in .env lands
// as PRESAGE_API_KEY (the SDKs only look at the upper-case names).
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || m[1].startsWith("#")) continue;
    const key = m[1].toUpperCase();
    const val = (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  /* no .env — fine */
}

const MODE = process.env.ATTUNE_MODE === "real" ? "real" : "demo";

const TIMINGS = {
  real: {
    baselineSec: 60,
    spikeSustainSec: 15,
    interruptCooldownSec: 90,
    pacerCooldownSec: 10 * 60,
    breakCooldownSec: 25 * 60,
    trackEndLeadSec: 25, // deliberate at T−25s (design.md §5)
    trackSecondsCap: Number.POSITIVE_INFINITY,
  },
  demo: {
    baselineSec: 12,
    spikeSustainSec: 6,
    interruptCooldownSec: 20,
    pacerCooldownSec: 45,
    breakCooldownSec: 60,
    trackEndLeadSec: 15, // real deliberations take 7–10 s; 10 s was too tight
    trackSecondsCap: 40, // stub tracks "play" at most 40s so the loop cycles
  },
}[MODE];

export const CONFIG = {
  mode: MODE,
  model: process.env.ATTUNE_MODEL ?? "claude-opus-5",
  fakeLlm: process.env.ATTUNE_FAKE_LLM === "1",
  sayEnabled: process.env.ATTUNE_SAY === "1", // voice nudges default OFF (§5)
  /** stub = canned catalog; real = desktop Spotify Web API (SPOTIFY=real) */
  spotify: (process.env.SPOTIFY ?? "stub").toLowerCase() === "real" ? "real" : "stub",
  /** mock = scripted body; real = SmartSpectra camera (VITALS=real) */
  vitals: (process.env.VITALS ?? "mock").toLowerCase() === "real" ? "real" : "mock",
  /** fuse = camera-driven state machine (§4b); hotkey = demo-driven mock. Defaults to fuse on real vitals. */
  attentionMode: ((process.env.ATTENTION ?? (process.env.VITALS === "real" ? "fuse" : "hotkey")).toLowerCase() === "fuse"
    ? "fuse"
    : "hotkey") as "fuse" | "hotkey",
  /** console = printed effects; macos = osascript / shortcuts / say (ACTUATORS=macos) */
  actuators: (process.env.ACTUATORS ?? "console").toLowerCase() === "macos" ? "macos" : "console",
  /** Presage SmartSpectra key (their docs call it SMARTSPECTRA_API_KEY; either name works) */
  presageApiKey: process.env.PRESAGE_API_KEY ?? process.env.SMARTSPECTRA_API_KEY ?? "",
  /** ElevenLabs TTS for spoken nudges; empty = fall back to macOS `say` */
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? "",
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb", // "George" — calm, neutral
    modelId: process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2",
  },

  // camera → attention (design.md §4b). Ratios are relative to the face box.
  // The plain cut-offs are uncalibrated (face.ts classify(), and fuse.ts until
  // its 60 s calibration lands); the *Delta / margin ones are vs. that baseline.
  attention: {
    faceHz: 10, // face samples per second delivered to attention
    gazeLeftBelow: 0.35, // iris x within the eye box
    gazeRightAbove: 0.65,
    headAwayYaw: 0.2, // |nose offset between cheeks − 0.5|
    headDownPitch: 0.65, // nose position between eye line and chin
    headDownDelta: 0.08, // pitch this far above the calibrated median = looking down
    gazeBoxMargin: 0.05, // slack around the calibrated 5th–95th percentile iris box
    gazeDownMargin: 0.08, // iris this far below the box = gaze down (phone signature with pitch)
    calibrationMinFrames: 100, // keep calibrating until this many focused-looking frames
    blinkBaselineFloorPerMin: 6, // never normalise against a near-zero baseline
    blinkHighFactor: 2, // rate above factor × baseline reads as fatigue (§4b)
    eyeClosureSec: 1, // `blinking` held this long = micro-sleep
    drowsyClosures: 2, // closures within drowsyWindowSec → DROWSY
    stillnessVarMax: 0.02, // centroid variance (inter-ocular units²) that reads as full fidgeting
    talkingFractionHigh: 0.3, // conversation / call
    screenMinConfidence: "medium", // verdicts below this never flip state
    scoreWindowSec: 30, // rolling window of the fused score
    scoreMinSec: 5, // no enter/leave decisions on thinner data than this
    weights: { onScreen: 0.4, stillness: 0.2, blink: 0.15, screen: 0.15, notTalking: 0.1 },
    distractedBelow: 0.4,
    focusedAbove: 0.6,
    // state-machine durations (§4b table); demo compressed like TIMINGS above
    ...{
      real: {
        calibrationSec: 60, // piggybacks on the arousal calibration
        recalibrateAfterFocusedSec: 5 * 60, // silent drift correction
        awayAfterSec: 10, // no face → AWAY
        backAfterSec: 3, // face stable → leave AWAY
        lowScoreSec: 20, // score < distractedBelow → DISTRACTED
        phoneSec: 8, // gaze down + pitch down held → DISTRACTED
        refocusSec: 15, // score > focusedAbove → leave DISTRACTED
        drowsyWindowSec: 60, // closures counted within this
        blinkHighSustainSec: 2 * 60, // high blink rate → DROWSY
        drowsyClearSec: 60, // back under thresholds → leave DROWSY
        focusedAfterSec: 15, // clean data before the first FOCUSED
      },
      demo: {
        calibrationSec: 12,
        recalibrateAfterFocusedSec: 2 * 60,
        awayAfterSec: 4,
        backAfterSec: 2,
        lowScoreSec: 8,
        phoneSec: 4,
        refocusSec: 6,
        drowsyWindowSec: 30,
        blinkHighSustainSec: 30,
        drowsyClearSec: 15,
        focusedAfterSec: 5,
      },
    }[MODE],
  },

  // screen on-task checker (design.md §4b "Screen channel"); SCREEN=0 disables it
  screen: {
    enabled: process.env.SCREEN === "1", // opt-in: every check is a Claude call with a screenshot
    intervalSec: 30, // periodic Claude check
    titlePollSec: 3, // cheap frontmost-app/window poll; a change triggers an immediate check
    maxWidth: 1024, // downscale before the thumbnail leaves the laptop
  },

  // arousal math (design.md §4)
  arousal: {
    hrWeight: 0.7,
    brWeight: 0.3,
    emaAlpha: 0.15, // per 1 Hz sample ≈ ~20 s window
    calmBelow: 0.05,
    highAtOrAbove: 0.15,
  },

  // deliberation
  softSearchBudget: 3, // searches past this get a nudge in the tool result, never a refusal
  maxIterationsPerPing: 10, // hard stop on model↔tool round-trips per ping
  deliberationTimeoutMs: 30_000,

  ...TIMINGS,
} as const;
