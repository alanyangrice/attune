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
  /** mean iris x within the eye box, 0 (image left) … 1 (image right) — both eyes move together on a glance */
  gazeX?: number;
  /** mean iris y between the lids, 0 (upper lid) … 1 (lower lid); larger = looking down */
  gazeY?: number;
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
const LID_R = [159, 145] as const; // upper, lower
const LID_L = [386, 374] as const;

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function irisMean(lm: Pt[], [start, end]: readonly [number, number]): Pt | undefined {
  let x = 0;
  let y = 0;
  let n = 0;
  for (let i = start; i < end; i++) {
    const p = lm[i];
    if (!p) continue;
    x += p.x;
    y += p.y;
    n += 1;
  }
  return n ? { x: x / n, y: y / n } : undefined;
}

/** iris position within one eye: x across the corners in IMAGE order, y between the lids */
function eyeGaze(lm: Pt[], iris: readonly [number, number], cornerA: number, cornerB: number, lids: readonly [number, number]): Pt | undefined {
  const c = irisMean(lm, iris);
  const a = lm[cornerA];
  const b = lm[cornerB];
  const upper = lm[lids[0]];
  const lower = lm[lids[1]];
  if (!c || !a || !b || !upper || !lower) return undefined;
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  if (right === left || lower.y === upper.y) return undefined;
  return { x: (c.x - left) / (right - left), y: (c.y - upper.y) / (lower.y - upper.y) };
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

  const gazeR = eyeGaze(lm, IRIS_R, EYE_R_INNER, EYE_R_OUTER, LID_R);
  const gazeL = eyeGaze(lm, IRIS_L, EYE_L_INNER, EYE_L_OUTER, LID_L);
  const gazeX = gazeR && gazeL ? (gazeR.x + gazeL.x) / 2 : undefined;
  const gazeY = gazeR && gazeL ? (gazeR.y + gazeL.y) / 2 : undefined;

  return { ...base, present: true, yaw, pitch, gazeX, gazeY };
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
