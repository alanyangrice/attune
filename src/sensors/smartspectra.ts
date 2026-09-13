// Real vitals: Presage SmartSpectra over the laptop camera, headless in this
// process (design.md §3, WORKPLAN lane 4). Implements VitalsProvider.
//
// The SDK delivers a metrics protobuf at up to ~30 Hz. We keep only the
// latest buffer and decode it on our own clock: face samples at faceHz for
// attention, one complete VitalsSample per second for the estimator (which
// is tuned for 1 Hz). Samples are emitted only when both HR and BR exist;
// otherwise the status is "low-confidence".
//
// Under Electron, Presage's quickstart runs capture in the renderer and
// ships frames over IPC; this in-process `useCamera()` path is what the
// console harness and the demo fallback use.

import { EventEmitter } from "node:events";
import { breathingMetrics, cardioMetrics, faceMetrics, SmartSpectraSDK } from "@smartspectra/node-sdk";
import { decodeMetrics, presage } from "@smartspectra/node-sdk/messages";
import { CONFIG } from "../config.js";
import type { VitalsEvents, VitalsProvider } from "../ports.js";
import type { FaceSample, VitalsSample } from "../types.js";

export interface SmartSpectraOptions {
  apiKey: string;
  deviceIndex?: number;
  /** MetricType codes; defaults to breathing + cardio + face (design.md §3) */
  requestedMetrics?: readonly number[];
}

// The messages subpath exports its types through the decoder's return type.
type Metrics = ReturnType<typeof decodeMetrics>;
type Face = NonNullable<Metrics["face"]>;
const EXPRESSION_NAMES = presage.smartspectra.ExpressionType as Record<number, string>;

/** percent (0–100) confidences → 0..1 mean of the ones present */
function confidence01(...values: Array<number | null | undefined>): number {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length / 100 : 0;
}

export class SmartSpectraProvider extends EventEmitter<VitalsEvents> implements VitalsProvider {
  private sdk: SmartSpectraSDK | null = null;
  private timer: NodeJS.Timeout | null = null;
  private latestBuffer: Buffer | null = null;
  private latestTsMs = 0;
  private decodedForTs = 0;
  private ticks = 0;
  private lastValidationCode: number | null = null;
  private status: "calibrating" | "ok" | "low-confidence" = "calibrating";

  constructor(private readonly opts: SmartSpectraOptions) {
    super();
    if (!opts.apiKey) throw new Error("SmartSpectra needs an API key (PRESAGE_API_KEY in .env)");
  }

  start(): void {
    if (this.sdk) return;
    const sdk = new SmartSpectraSDK({
      apiKey: this.opts.apiKey,
      requestedMetrics: [...(this.opts.requestedMetrics ?? [...breathingMetrics, ...cardioMetrics, ...faceMetrics])],
    });
    sdk.on("metrics", (buf, timestampUs) => {
      this.latestBuffer = buf; // decode lazily on our own clock
      this.latestTsMs = timestampUs / 1000;
    });
    sdk.on("validationStatus", (code, _ts, hint) => {
      if (code === this.lastValidationCode) return; // once per change, not per frame
      this.lastValidationCode = code;
      if (hint) this.emit("warning", hint);
    });
    sdk.on("error", (code, message, retryable) => {
      this.emit("error", new Error(`SmartSpectra error ${code}: ${message}${retryable ? " (retryable)" : ""}`));
    });
    sdk.useCamera({ deviceIndex: this.opts.deviceIndex });
    sdk.start();
    this.sdk = sdk;
    this.emit("status", "calibrating");
    const faceHz = CONFIG.attention.faceHz;
    this.timer = setInterval(() => this.tick(faceHz), 1000 / faceHz);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const sdk = this.sdk;
    this.sdk = null;
    this.latestBuffer = null;
    if (sdk) await sdk.destroy(); // destroy() drains the pipeline itself; no separate stop needed
  }

  private tick(faceHz: number): void {
    this.ticks += 1;
    const buf = this.latestBuffer;
    if (!buf || this.latestTsMs === this.decodedForTs) return;
    this.decodedForTs = this.latestTsMs;
    const m = decodeMetrics(buf);
    const ts = Date.now();

    const face = this.toFace(m.face, ts);
    if (face) this.emit("face", face);

    if (this.ticks % faceHz === 0) this.emitVitals(m, ts);
  }

  private emitVitals(m: Metrics, ts: number): void {
    const pulse = m.cardio?.pulseRate?.at(-1);
    const breath = m.breathing?.rate?.at(-1);
    const hr = pulse?.value ?? null;
    const br = breath?.value ?? null;
    if (hr === null || br === null) return this.setStatus("low-confidence");
    const sample: VitalsSample = {
      ts,
      hr,
      br,
      hrv: m.cardio?.hrv?.at(-1)?.rmssd ?? undefined,
      eda: m.eda?.trace?.at(-1)?.value ?? undefined,
      confidence: confidence01(pulse?.confidence, breath?.confidence),
    };
    this.setStatus(sample.confidence < 0.6 ? "low-confidence" : "ok");
    this.emit("sample", sample);
  }

  private toFace(f: Face | null | undefined, ts: number): FaceSample | null {
    if (!f) return null;
    const lm = f.landmarks?.at(-1);
    const blinking = f.blinking?.at(-1);
    const talking = f.talking?.at(-1);
    const expr = f.expression?.at(-1);
    if (!lm?.value?.length && !blinking && !talking && !expr) return null;
    const expression = expr?.scores?.length
      ? Object.fromEntries(expr.scores.map((s) => [EXPRESSION_NAMES[s.type ?? 0] ?? String(s.type), s.confidence ?? 0]))
      : undefined;
    return {
      ts,
      landmarks: lm?.value?.length ? lm.value.map((p) => ({ x: p.x ?? 0, y: p.y ?? 0 })) : undefined,
      stable: lm?.stable ?? false,
      blinking: blinking?.detected ?? false,
      talking: talking?.detected ?? false,
      expression,
    };
  }

  private setStatus(s: "calibrating" | "ok" | "low-confidence"): void {
    if (s === this.status) return;
    this.status = s;
    this.emit("status", s);
  }
}
