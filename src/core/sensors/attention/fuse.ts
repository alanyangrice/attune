// Attention fusion (design.md §4b "Fusion"). Consumes ~10 Hz FaceSamples from
// the VitalsProvider plus screen verdicts pushed by the screen checker, keeps
// per-second features in a 30 s window, and runs the hysteresis state machine.
// All decisions happen on a 1 Hz tick; tick(now) is public so a harness can
// drive it with a synthetic clock instead of waiting in real time.
//
// Honesty note (§4b): heuristics, listener-relative, tuned on us at the venue.

import { EventEmitter } from "node:events";
import { CONFIG } from "../../config.js";
import type { AttentionEvents, AttentionProvider, VitalsProvider } from "../../ports.js";
import type { AttentionState, FaceSample, PingEvent } from "../../types.js";
import { classify, faceFeatures, type FaceFeatures } from "./face.js";

const A = CONFIG.attention;
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

export interface ScreenVerdict {
  onTask: boolean;
  activity: string;
  confidence: "low" | "medium" | "high";
  ts: number;
}

/** what "looking at the work" is for this listener, this sitting (§4b calibration) */
export interface Baseline {
  yaw: number;
  pitch: number;
  gaze: { xLo: number; xHi: number; yLo: number; yHi: number };
  blinkPerMin: number;
}

/** one second of features — the unit the rolling score averages over */
export interface SecondFeatures {
  ts: number;
  onScreen: number; // fraction of frames with head centred and iris in the box
  down: number; // fraction of frames with the phone signature (gaze down + pitch down)
  stillness: number; // 1 − normalised centroid variance over the last 5 s
  blinkNorm: number; // 1 at/below baseline blink rate → 0 at blinkHighFactor × baseline
  blinkPerMin: number;
  screenOnTask: number; // last usable verdict, 1 until one arrives
  talking: number; // fraction of frames with talking
}

type Pt = { x: number; y: number };
type Gaze = { x: number; y: number };
type Pose = { yaw: number; pitch: number; gaze: Gaze };

// Iris offsets in *image* order (left corner → right corner, upper lid → lower
// lid) so both eyes move the same way and a lateral glance survives averaging.
// face.ts's gazeX orders the corners inner→outer, which makes the two eyes
// cancel; it also has no vertical offset, which the phone signature needs.
const EYES = [
  { corners: [33, 133], lids: [159, 145], iris: [468, 473] },
  { corners: [362, 263], lids: [386, 374], iris: [473, 478] },
] as const;
const IOD = [33, 263] as const; // outer eye corners → scale for stillness

function eyeGaze(lm: Pt[], eye: (typeof EYES)[number]): Gaze | undefined {
  const a = lm[eye.corners[0]];
  const b = lm[eye.corners[1]];
  const up = lm[eye.lids[0]];
  const lo = lm[eye.lids[1]];
  if (!a || !b || !up || !lo) return undefined;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = eye.iris[0]; i < eye.iris[1]; i++) {
    const p = lm[i];
    if (!p) continue;
    sx += p.x;
    sy += p.y;
    n += 1;
  }
  const left = a.x <= b.x ? a : b;
  const w = Math.abs(b.x - a.x);
  const h = lo.y - up.y;
  if (!n || w <= 0 || h < 0.1 * w) return undefined; // eye closed → no gaze this frame
  return { x: (sx / n - left.x) / w, y: (sy / n - up.y) / h };
}

function gazeOffsets(lm: Pt[]): Gaze | undefined {
  const g = EYES.map((e) => eyeGaze(lm, e));
  const [r, l] = g;
  if (!r || !l) return undefined;
  return { x: (r.x + l.x) / 2, y: (r.y + l.y) / 2 };
}

/** landmark centroid in inter-ocular units — scale-free, so distance to the camera doesn't matter */
function centroidIod(lm: Pt[]): Pt | undefined {
  const a = lm[IOD[0]];
  const b = lm[IOD[1]];
  if (!a || !b) return undefined;
  const iod = Math.hypot(b.x - a.x, b.y - a.y);
  if (iod <= 0) return undefined;
  let sx = 0;
  let sy = 0;
  for (const p of lm) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / lm.length / iod, y: sy / lm.length / iod };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function variance(xs: number[]): number {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))] ?? 0;
}
const median = (xs: number[]): number => percentile(xs, 0.5);

export class AttentionFuser extends EventEmitter<AttentionEvents> implements AttentionProvider {
  private _state: AttentionState = "UNKNOWN";
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;

  // presence
  private lastPresentTs = 0;
  private stableSince: number | null = null;
  private awaySince = 0;

  // per-frame accumulators, drained every tick
  private acc = { frames: 0, onScreen: 0, down: 0, talking: 0 };
  private centroids: { ts: number; c: Pt }[] = [];

  // blinks
  private wasBlinking = false;
  private blinkStart: number | null = null;
  private closureCounted = false;
  private blinkEdges: number[] = []; // rising-edge timestamps, last 60 s
  private closures: number[] = []; // eye closures > eyeClosureSec, last drowsyWindowSec

  // calibration
  private baseline: Baseline | null = null;
  private calFrames: Pose[] = []; // focused-looking frames, first calibrationSec
  private calBlinkEdges = 0;
  private recalFrames: Pose[] = []; // focused-looking frames while FOCUSED, for the silent re-calibration
  private focusedSince = 0;

  // screen channel
  private lastVerdict: ScreenVerdict | null = null;
  private offTaskStreak = 0;
  private verdictFlipsOn = false; // a usable on_task=true arrived since we entered OFF_TASK

  // rolling score + hysteresis timers (all "since" timestamps, ms)
  private window: SecondFeatures[] = [];
  private _score: number | undefined;
  private last: SecondFeatures | null = null;
  private downSince: number | null = null;
  private lowSince: number | null = null;
  private highSince: number | null = null;
  private blinkHighSince: number | null = null;
  private drowsyClearSince = 0;
  private cleanSince: number | null = null;

  constructor(private readonly deps: { vitals: VitalsProvider }) {
    super();
    this.deps.vitals.on("face", this.onFace);
  }

  get state(): AttentionState {
    return this._state;
  }
  /** rolling 30 s score, 0..1; undefined until the first second of face data */
  get score(): number | undefined {
    return this._score;
  }
  get calibrated(): boolean {
    return this.baseline !== null;
  }
  get lastFeatures(): SecondFeatures | null {
    return this.last;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** the screen checker pushes each classification here (§4b screen channel) */
  /** demo controls: force a state now (the machine resumes from it on the next tick) */
  setState(state: AttentionState, reason = `forced ${state} (demo)`): void {
    this.transition(Date.now(), state, reason);
  }

  screenVerdict(v: ScreenVerdict): void {
    if (CONFIDENCE_RANK[v.confidence] < CONFIDENCE_RANK[A.screenMinConfidence]) return; // unknown: don't flip
    this.lastVerdict = v;
    if (v.onTask) {
      this.offTaskStreak = 0;
      this.verdictFlipsOn = true;
    } else {
      this.offTaskStreak += 1;
    }
  }

  // ── per frame (~10 Hz) ───────────────────────────────────────────────────

  private onFace = (s: FaceSample): void => {
    const f = faceFeatures(s);
    if (!f.present || !s.landmarks) {
      this.stableSince = null;
      this.trackBlink(false, s.ts);
      return;
    }
    this.lastPresentTs = s.ts;
    this.stableSince = f.stable ? (this.stableSince ?? s.ts) : null;
    this.trackBlink(f.blinking, s.ts);

    const gaze = f.blinking ? undefined : gazeOffsets(s.landmarks);
    const flags = this.flags(f, gaze);
    this.acc.frames += 1;
    if (flags.onScreen) this.acc.onScreen += 1;
    if (flags.down) this.acc.down += 1;
    if (f.talking) this.acc.talking += 1;

    const c = centroidIod(s.landmarks);
    if (c) this.centroids.push({ ts: s.ts, c });

    // calibration only learns from frames that already look like "at the work"
    if (flags.looksFocused && f.yaw !== undefined && f.pitch !== undefined && gaze) {
      const pose = { yaw: f.yaw, pitch: f.pitch, gaze };
      if (!this.baseline) this.calFrames.push(pose);
      else if (this._state === "FOCUSED") {
        this.recalFrames.push(pose);
        if (this.recalFrames.length > A.calibrationSec * A.faceHz) this.recalFrames.shift();
      }
    }
  };

  private trackBlink(blinking: boolean, ts: number): void {
    if (blinking && !this.wasBlinking) {
      this.blinkEdges.push(ts);
      if (!this.baseline) this.calBlinkEdges += 1;
    }
    this.wasBlinking = blinking;
    if (!blinking) {
      this.blinkStart = null;
      this.closureCounted = false;
      return;
    }
    this.blinkStart ??= ts;
    if (!this.closureCounted && ts - this.blinkStart >= A.eyeClosureSec * 1000) {
      this.closureCounted = true;
      this.closures.push(ts);
    }
  }

  /** frame labels; uncalibrated thresholds until the baseline exists, listener-relative after */
  private flags(f: FaceFeatures, gaze: Gaze | undefined): { onScreen: boolean; down: boolean; looksFocused: boolean } {
    const b = this.baseline;
    if (!b) {
      const c = classify(f);
      const gazeCentred = !gaze || (gaze.x >= A.gazeLeftBelow && gaze.x <= A.gazeRightAbove);
      const onScreen = c.head === "center" && gazeCentred;
      return { onScreen, down: c.head === "down" && !!gaze && gaze.y > 0.5, looksFocused: onScreen && f.stable && !!gaze };
    }
    const yaw = f.yaw ?? b.yaw;
    const pitch = f.pitch ?? b.pitch;
    const pitchDown = pitch - b.pitch > A.headDownDelta;
    const headCentred = Math.abs(yaw - b.yaw) <= A.headAwayYaw && !pitchDown;
    const m = A.gazeBoxMargin;
    const gazeIn =
      !gaze ||
      (gaze.x >= b.gaze.xLo - m && gaze.x <= b.gaze.xHi + m && gaze.y >= b.gaze.yLo - m && gaze.y <= b.gaze.yHi + m);
    const gazeDown = !!gaze && gaze.y > b.gaze.yHi + A.gazeDownMargin;
    const onScreen = headCentred && gazeIn;
    return { onScreen, down: pitchDown && gazeDown, looksFocused: onScreen && f.stable && !!gaze };
  }

  // ── per second ───────────────────────────────────────────────────────────

  /** one step of the estimator; `now` defaults to the wall clock, harnesses pass their own */
  tick(now: number = Date.now()): void {
    if (!this.startedAt) {
      this.startedAt = now;
      this.lastPresentTs = now; // "no face yet" counts from session start
      this.drowsyClearSince = now;
    }
    const present = now - this.lastPresentTs <= 1000;
    if (!present) this.stableSince = null;

    this.blinkEdges = this.blinkEdges.filter((t) => now - t <= 60_000);
    this.closures = this.closures.filter((t) => now - t <= A.drowsyWindowSec * 1000);
    this.centroids = this.centroids.filter((x) => now - x.ts <= 5000);

    const row = present && this.acc.frames > 0 ? this.buildRow(now) : null;
    this.acc = { frames: 0, onScreen: 0, down: 0, talking: 0 };
    if (row) {
      this.window.push(row);
      while (this.window.length > A.scoreWindowSec) this.window.shift();
      this._score = this.scoreOf(this.window);
      this.last = row;
    }

    this.calibrate(now);
    this.step(now, row);
  }

  private buildRow(now: number): SecondFeatures {
    const n = this.acc.frames;
    const blinkPerMin = this.blinkPerMin(now);
    const base = this.baseline?.blinkPerMin;
    const blinkNorm = base ? clamp01(1 - (blinkPerMin - base) / (base * (A.blinkHighFactor - 1))) : 1;
    const cs = this.centroids.map((x) => x.c);
    const v = cs.length >= 2 ? variance(cs.map((c) => c.x)) + variance(cs.map((c) => c.y)) : 0;
    return {
      ts: now,
      onScreen: this.acc.onScreen / n,
      down: this.acc.down / n,
      stillness: clamp01(1 - v / A.stillnessVarMax),
      blinkNorm,
      blinkPerMin,
      screenOnTask: this.lastVerdict ? (this.lastVerdict.onTask ? 1 : 0) : 1,
      talking: this.acc.talking / n,
    };
  }

  private blinkPerMin(now: number): number {
    const span = Math.min(60_000, Math.max(10_000, now - this.startedAt));
    return (this.blinkEdges.length * 60_000) / span;
  }

  private scoreOf(rows: SecondFeatures[]): number {
    const w = A.weights;
    return (
      w.onScreen * mean(rows.map((r) => r.onScreen)) +
      w.stillness * mean(rows.map((r) => r.stillness)) +
      w.blink * mean(rows.map((r) => r.blinkNorm)) +
      w.screen * mean(rows.map((r) => r.screenOnTask)) +
      w.notTalking * (1 - mean(rows.map((r) => r.talking)))
    );
  }

  // ── calibration (§4b): median pose, 5th–95th pct gaze box, baseline blink rate ──

  private calibrate(now: number): void {
    if (!this.baseline) {
      const elapsed = (now - this.startedAt) / 1000;
      if (elapsed < A.calibrationSec || this.calFrames.length < A.calibrationMinFrames) return;
      const blink = Math.max(A.blinkBaselineFloorPerMin, (this.calBlinkEdges * 60) / elapsed);
      this.baseline = this.fit(this.calFrames, blink);
      this.calFrames = [];
      return;
    }
    // silent re-calibration: drift as they shift in the chair
    if (this._state !== "FOCUSED" || now - this.focusedSince < A.recalibrateAfterFocusedSec * 1000) return;
    if (this.recalFrames.length >= A.calibrationMinFrames) {
      this.baseline = this.fit(this.recalFrames, Math.max(A.blinkBaselineFloorPerMin, this.blinkPerMin(now)));
    }
    this.recalFrames = [];
    this.focusedSince = now;
  }

  private fit(frames: Pose[], blinkPerMin: number): Baseline {
    const gx = frames.map((p) => p.gaze.x);
    const gy = frames.map((p) => p.gaze.y);
    return {
      yaw: median(frames.map((p) => p.yaw)),
      pitch: median(frames.map((p) => p.pitch)),
      gaze: { xLo: percentile(gx, 0.05), xHi: percentile(gx, 0.95), yLo: percentile(gy, 0.05), yHi: percentile(gy, 0.95) },
      blinkPerMin,
    };
  }

  // ── state machine (§4b table) ────────────────────────────────────────────

  private step(now: number, row: SecondFeatures | null): void {
    // presence gate first: lost tracking is the strongest look-away signal
    if (this._state !== "AWAY" && now - this.lastPresentTs >= A.awayAfterSec * 1000) {
      this.window = []; // stale evidence; start fresh when they return
      this.awaySince = this.lastPresentTs;
      this.resetTimers();
      return this.transition(now, "AWAY", `no face for ${A.awayAfterSec}s`);
    }
    if (this._state === "AWAY") {
      if (this.stableSince !== null && now - this.stableSince >= A.backAfterSec * 1000)
        this.transition(now, "FOCUSED", `face back after ${Math.round((now - this.awaySince) / 1000)}s away`);
      return;
    }

    // ── update hysteresis timers from this second's evidence ──
    const score = this._score;
    const enough = this.window.length >= A.scoreMinSec && score !== undefined;
    const low = enough && score < A.distractedBelow;
    const high = enough && score > A.focusedAbove && !!row && row.onScreen >= 0.5;
    const down = !!row && row.down >= 0.5;
    const blinkHigh = !!row && !!this.baseline && row.blinkPerMin > A.blinkHighFactor * this.baseline.blinkPerMin;
    const eyesShut = this.blinkStart !== null && now - this.blinkStart >= A.eyeClosureSec * 1000; // still closed
    const closureNow = eyesShut || this.closures.some((t) => now - t < 1000);
    if (row) {
      this.downSince = down ? (this.downSince ?? now) : null;
      this.lowSince = low ? (this.lowSince ?? now) : null;
      this.highSince = high ? (this.highSince ?? now) : null;
      this.blinkHighSince = blinkHigh ? (this.blinkHighSince ?? now) : null;
    }
    if (closureNow || blinkHigh) this.drowsyClearSince = now;
    const held = (since: number | null, sec: number): boolean => since !== null && now - since >= sec * 1000;

    const drowsyReason =
      this.closures.length >= A.drowsyClosures
        ? `eyes closed >${A.eyeClosureSec}s ${this.closures.length}× in ${A.drowsyWindowSec}s`
        : held(this.blinkHighSince, A.blinkHighSustainSec) && row && this.baseline
          ? `blink rate ${row.blinkPerMin.toFixed(0)}/min > ${A.blinkHighFactor}× baseline ${this.baseline.blinkPerMin.toFixed(0)}/min for ${A.blinkHighSustainSec}s`
          : null;
    const distractedReason = held(this.downSince, A.phoneSec)
      ? `looking down ${Math.round((now - this.downSince!) / 1000)}s (phone signature)`
      : held(this.lowSince, A.lowScoreSec)
        ? `attention ${score!.toFixed(2)} for ${A.lowScoreSec}s (${this.weakest()})`
        : null;
    const offTaskReason =
      this.offTaskStreak >= 2 && this.lastVerdict ? `screen: ${this.lastVerdict.activity} (${this.offTaskStreak} verdicts)` : null;

    switch (this._state) {
      case "UNKNOWN":
      case "FOCUSED": {
        const clean = !down && !low && !closureNow && this.offTaskStreak === 0;
        this.cleanSince = clean ? (this.cleanSince ?? now) : null;
        if (drowsyReason) return this.transition(now, "DROWSY", drowsyReason);
        if (distractedReason) return this.transition(now, "DISTRACTED", distractedReason);
        if (offTaskReason) return this.transition(now, "OFF_TASK", offTaskReason);
        if (this._state === "UNKNOWN" && held(this.cleanSince, A.focusedAfterSec))
          return this.transition(now, "FOCUSED", `face on screen ${A.focusedAfterSec}s`);
        return;
      }
      case "DISTRACTED":
        if (held(this.highSince, A.refocusSec))
          this.transition(now, "FOCUSED", `attention ${score!.toFixed(2)} for ${A.refocusSec}s`);
        return;
      case "OFF_TASK":
        if (this.verdictFlipsOn && this.lastVerdict) this.transition(now, "FOCUSED", `screen: ${this.lastVerdict.activity}`);
        return;
      case "DROWSY":
        if (now - this.drowsyClearSince >= A.drowsyClearSec * 1000) {
          this.closures = []; // else the demo profile (clear < window) re-enters at once
          this.transition(now, "FOCUSED", `eyes open, blink rate normal for ${A.drowsyClearSec}s`);
        }
        return;
    }
  }

  /** which channels dragged the score down — quoted to the model as the reason */
  private weakest(): string {
    const r = this.window;
    const parts: string[] = [];
    const off = 1 - mean(r.map((x) => x.onScreen));
    const talk = mean(r.map((x) => x.talking));
    const fidget = 1 - mean(r.map((x) => x.stillness));
    if (off >= 0.5) parts.push(`off-screen ${Math.round(off * 100)}%`);
    if (talk >= A.talkingFractionHigh) parts.push(`talking ${Math.round(talk * 100)}%`);
    if (fidget >= 0.5) parts.push("fidgeting");
    if (this.lastVerdict && !this.lastVerdict.onTask) parts.push(`screen: ${this.lastVerdict.activity}`);
    return parts.join(", ") || "low overall";
  }

  private resetTimers(): void {
    this.downSince = this.lowSince = this.highSince = this.blinkHighSince = this.cleanSince = null;
  }

  private transition(at: number, next: AttentionState, reason: string): void {
    const prev = this._state;
    if (next === prev) return;
    this._state = next;
    if (next === "FOCUSED") {
      this.focusedSince = at;
      this.recalFrames = [];
    }
    if (next === "DISTRACTED") this.highSince = null; // the 15 s of refocus starts now
    if (next === "OFF_TASK") this.verdictFlipsOn = false;
    if (next === "DROWSY") this.drowsyClearSince = at;
    if (next !== "OFF_TASK" && next !== "FOCUSED") this.offTaskStreak = 0;
    this.emit("state", next, reason);

    let ping: PingEvent | null = null;
    if (next === "DISTRACTED" || next === "OFF_TASK" || next === "DROWSY") ping = { kind: "DISTRACTED", at, detail: reason };
    else if (next === "FOCUSED" && prev !== "UNKNOWN") ping = { kind: "REFOCUSED", at, detail: reason };
    if (ping) this.emit("ping", ping);
  }
}
