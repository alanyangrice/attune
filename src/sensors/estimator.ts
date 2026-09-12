// Arousal estimator (design.md §4). Deliberately dumb math:
// baseline = median of the calibration window; arousal = weighted %-delta
// vs. baseline, EMA-smoothed; SPIKE = sustained high band.
// Attention (§4b) is NOT here — it arrives from fuse.ts later (hotkeys today).

import { EventEmitter } from "node:events";
import { CONFIG } from "../config.js";
import type { ArousalSnapshot, VitalsSample } from "../types.js";

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export declare interface Estimator {
  on(event: "state", listener: (s: ArousalSnapshot) => void): this;
  on(event: "spike", listener: (detail: string) => void): this;
  on(event: "calibrated", listener: (baselineHr: number, baselineBr: number) => void): this;
}

export class Estimator extends EventEmitter {
  private calWindow: VitalsSample[] = [];
  private baselineHr = 0;
  private baselineBr = 0;
  private calibrated = false;
  private startedAt = 0;

  private ema = 0;
  private highSince: number | null = null;
  private spikeArmed = true; // re-arms after arousal falls back under "elevated"
  private spikeSustainedFor = 0;

  latest: ArousalSnapshot | null = null;

  feed(s: VitalsSample): void {
    if (s.confidence < 0.6) return; // gate junk frames; UI shows low-confidence separately
    if (!this.startedAt) this.startedAt = s.ts;

    if (!this.calibrated) {
      this.calWindow.push(s);
      if ((s.ts - this.startedAt) / 1000 >= CONFIG.baselineSec && this.calWindow.length >= 5) {
        this.baselineHr = median(this.calWindow.map((x) => x.hr));
        this.baselineBr = median(this.calWindow.map((x) => x.br));
        this.calibrated = true;
        this.emit("calibrated", this.baselineHr, this.baselineBr);
      }
      this.push(s, 0);
      return;
    }

    const { hrWeight, brWeight, emaAlpha, highAtOrAbove, calmBelow } = CONFIG.arousal;
    const raw =
      hrWeight * ((s.hr - this.baselineHr) / this.baselineHr) +
      brWeight * ((s.br - this.baselineBr) / this.baselineBr);
    this.ema = this.ema + emaAlpha * (raw - this.ema);
    this.push(s, this.ema);

    // spike detection: high band sustained, one shot until it calms down
    if (this.ema >= highAtOrAbove) {
      this.highSince ??= s.ts;
      this.spikeSustainedFor = (s.ts - this.highSince) / 1000;
      if (this.spikeArmed && this.spikeSustainedFor >= CONFIG.spikeSustainSec) {
        this.spikeArmed = false;
        this.emit(
          "spike",
          `HR ${Math.round(s.hr)} vs baseline ${Math.round(this.baselineHr)}, ` +
            `arousal ${this.ema.toFixed(2)} sustained ${Math.round(this.spikeSustainedFor)}s`,
        );
      }
    } else {
      this.highSince = null;
      this.spikeSustainedFor = 0;
      if (this.ema < calmBelow + 0.03) this.spikeArmed = true;
    }
  }

  private push(s: VitalsSample, arousal: number): void {
    const { calmBelow, highAtOrAbove } = CONFIG.arousal;
    const band = arousal < calmBelow ? "calm" : arousal < highAtOrAbove ? "elevated" : "high";
    this.latest = {
      ts: s.ts,
      arousal,
      band,
      hr: s.hr,
      br: s.br,
      baselineHr: this.baselineHr,
      baselineBr: this.baselineBr,
      calibrated: this.calibrated,
    };
    this.emit("state", this.latest);
  }
}
