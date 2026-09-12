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

const MODE = (process.env.ATTUNE_MODE ?? "demo") as "demo" | "real";

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

export type Config = typeof CONFIG;
