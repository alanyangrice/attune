// Attention factory (design.md §4b). CONFIG.attentionMode picks:
//   fuse   — the real face + screen state machine (AttentionFuser)
//   hotkey — the demo-driven mock (HotkeyAttentionProvider)

import { CONFIG } from "../../config.js";
import type { AttentionProvider, VitalsProvider } from "../../ports.js";
import { AttentionFuser } from "./fuse.js";
import { HotkeyAttentionProvider } from "./hotkey.js";

export function createAttention(deps: { vitals: VitalsProvider }, mode = CONFIG.attentionMode): AttentionProvider {
  return mode === "fuse" ? new AttentionFuser(deps) : new HotkeyAttentionProvider();
}

export { AttentionFuser, type Baseline, type ScreenVerdict, type SecondFeatures } from "./fuse.js";
export { HotkeyAttentionProvider } from "./hotkey.js";
export { ScreenChecker } from "./screen.js";
