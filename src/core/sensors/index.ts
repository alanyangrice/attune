// Vitals factory, mirroring adapters/spotify/index.ts. CONFIG.vitals picks:
//   mock (default) — scripted body, responds to the pacer, hotkey stress
//   real           — SmartSpectra over the camera (PRESAGE_API_KEY in .env)

import { CONFIG } from "../config.js";
import type { VitalsProvider } from "../ports.js";
import { SmartSpectraProvider, type SmartSpectraOptions } from "./smartspectra.js";
import { MockVitalsProvider } from "./vitals-mock.js";

export function createVitals(
  mode: "mock" | "real" = CONFIG.vitals,
  opts: Partial<SmartSpectraOptions> = {},
): VitalsProvider {
  if (mode === "real") return new SmartSpectraProvider({ apiKey: CONFIG.presageApiKey, ...opts });
  return new MockVitalsProvider();
}

export { MockVitalsProvider } from "./vitals-mock.js";
export { SmartSpectraProvider } from "./smartspectra.js";
