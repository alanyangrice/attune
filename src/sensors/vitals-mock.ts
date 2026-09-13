// Mock vitals provider (design.md §3): first-class, not a shim.
// Emits VitalsSample at 1 Hz; stress level is scriptable (auto mode) or
// hotkey-driven (manual). It also *responds to the breathing pacer* — BR
// drifts toward the paced rate and HR follows — so the closed loop is
// visible end-to-end before the Presage key exists.

import { EventEmitter } from "node:events";
import type { VitalsEvents, VitalsProvider } from "../ports.js";
import type { VitalsSample } from "../types.js";

export type StressLevel = "calm" | "rising" | "spike";

const TARGETS: Record<StressLevel, { hr: number; br: number }> = {
  calm: { hr: 70, br: 13 },
  rising: { hr: 80, br: 15.5 },
  spike: { hr: 88, br: 18 },
};

export class MockVitalsProvider extends EventEmitter<VitalsEvents> implements VitalsProvider {
  private hr = 70;
  private br = 13;
  private level: StressLevel = "calm";
  private pacerUntil = 0;
  private pacerBpm = 6;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    this.emit("status", "simulated");
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setStress(level: StressLevel): void {
    this.level = level;
  }

  /** called when the pacer overlay runs: physiology follows the pacer */
  paceBreathing(bpm: number, seconds: number): void {
    this.pacerBpm = bpm;
    this.pacerUntil = Date.now() + seconds * 1000;
    this.level = "calm"; // paced breathing pulls the whole system down
  }

  private tick(): void {
    const pacing = Date.now() < this.pacerUntil;
    const t = TARGETS[this.level];
    const targetBr = pacing ? this.pacerBpm + 1 : t.br;
    const targetHr = pacing ? t.hr - 4 : t.hr;

    // first-order drift + noise; BR converges faster than HR (as in life)
    this.hr += (targetHr - this.hr) * 0.10 + (Math.random() - 0.5) * 1.6;
    this.br += (targetBr - this.br) * (pacing ? 0.25 : 0.12) + (Math.random() - 0.5) * 0.5;

    this.emit("sample", {
      ts: Date.now(),
      hr: this.hr,
      br: Math.max(4, this.br),
      confidence: 0.95,
    } satisfies VitalsSample);
  }
}
