// Face → attention features (design.md §4b). Pure math over the 478
// MediaPipe landmarks; no state, no thresholds except in classify(), which
// reads them from config. fuse.ts (next) turns these per-frame features into
// the calibrated, hysteresis-smoothed AttentionState the agent consumes.

import { CONFIG } from "../../config.js";
import type { FaceSample } from "../../types.js";

type Pt = { x: number; y: number };

/** Continuous, uncalibrated per-frame features. Ratios are relative to the face box. */
export interface FaceFeatures {
  ts: number;
  present: boolean;
  stable: boolean;
  /** nose offset between the cheeks, −0.5 (fully left) … 0 (centred) … +0.5 */
  yaw?: number;
  /** nose position between the eye line (0) and the chin (1); larger = looking down */
  pitch?: number;
  /** mean iris x within the eye box, 0 (inner corner) … 1 (outer corner) */
  gazeX?: number;
  blinking: boolean;
  talking: boolean;
}

// MediaPipe indices (design.md §4b table)
const NOSE = 1;
const CHIN = 152;
const CHEEK_L = 234;
const CHEEK_R = 454;
const EYE_R_OUTER = 33; // subject's right eye
const EYE_R_INNER = 133;
const EYE_L_INNER = 362; // subject's left eye
const EYE_L_OUTER = 263;
const IRIS_R = [468, 473] as const; // start, end (exclusive)
const IRIS_L = [473, 478] as const;

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function irisMeanX(lm: Pt[], [start, end]: readonly [number, number]): number | undefined {
  let sum = 0;
  let n = 0;
  for (let i = start; i < end; i++) {
    const p = lm[i];
    if (!p) continue;
    sum += p.x;
    n += 1;
  }
  return n ? sum / n : undefined;
}

/** where the iris sits within the eye box: 0 at the inner corner, 1 at the outer */
function gazeRatio(irisX: number | undefined, inner: Pt | undefined, outer: Pt | undefined): number | undefined {
  if (irisX === undefined || !inner || !outer || outer.x === inner.x) return undefined;
  return (irisX - inner.x) / (outer.x - inner.x);
}

export function faceFeatures(sample: FaceSample): FaceFeatures {
  const lm = sample.landmarks;
  const base = { ts: sample.ts, stable: sample.stable, blinking: sample.blinking, talking: sample.talking };
  if (!lm?.length) return { ...base, present: false };

  const nose = lm[NOSE];
  const chin = lm[CHIN];
  const cheekL = lm[CHEEK_L];
  const cheekR = lm[CHEEK_R];
  const eyeROuter = lm[EYE_R_OUTER];
  const eyeLOuter = lm[EYE_L_OUTER];

  let yaw: number | undefined;
  if (nose && cheekL && cheekR && cheekR.x !== cheekL.x) yaw = (nose.x - cheekL.x) / (cheekR.x - cheekL.x) - 0.5;

  let pitch: number | undefined;
  if (nose && chin && eyeROuter && eyeLOuter) {
    const eyeLine = mid(eyeROuter, eyeLOuter);
    if (chin.y !== eyeLine.y) pitch = (nose.y - eyeLine.y) / (chin.y - eyeLine.y);
  }

  const gazeR = gazeRatio(irisMeanX(lm, IRIS_R), lm[EYE_R_INNER], eyeROuter);
  const gazeL = gazeRatio(irisMeanX(lm, IRIS_L), lm[EYE_L_INNER], eyeLOuter);
  const gazeX = gazeR !== undefined && gazeL !== undefined ? (gazeR + gazeL) / 2 : undefined;

  return { ...base, present: true, yaw, pitch, gazeX };
}

export type GazeClass = "left" | "center" | "right" | "unknown";
export type HeadClass = "center" | "away" | "down" | "unknown";

/** Coarse labels from the raw ratios, using the uncalibrated thresholds in config.
 *  Good enough for a smoke test; fuse.ts should classify against a per-session baseline. */
export function classify(f: FaceFeatures): { gaze: GazeClass; head: HeadClass } {
  const t = CONFIG.attention;
  const gaze: GazeClass =
    f.gazeX === undefined ? "unknown" : f.gazeX < t.gazeLeftBelow ? "left" : f.gazeX > t.gazeRightAbove ? "right" : "center";
  let head: HeadClass = "unknown";
  if (f.pitch !== undefined && f.pitch > t.headDownPitch) head = "down";
  else if (f.yaw !== undefined && Math.abs(f.yaw) > t.headAwayYaw) head = "away";
  else if (f.yaw !== undefined && f.pitch !== undefined) head = "center";
  return { gaze, head };
}
