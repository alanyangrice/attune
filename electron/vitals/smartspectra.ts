import {
  cardioMetrics,
  decodeMetrics,
  edaMetrics,
  faceMetrics,
  SmartSpectraSDK,
  breathingMetrics,
} from "@smartspectra/node-sdk";

import {
  FaceSample,
  VitalsProvider,
  VitalsSample,
} from "./provider.js";

type Measurement = {
  value?: number;
  confidence?: number;
  stable?: boolean;
};

type HrvMeasurement = {
  rmssd?: number;
  confidence?: number;
};

type DecodedMetrics = {
  breathing?: { rate?: Measurement[] };
  cardio?: { pulseRate?: Measurement[]; hrv?: HrvMeasurement[] };
  eda?: { trace?: Measurement[] };
  face?: {
    landmarks?: Array<Measurement & { value?: Array<{ x: number; y: number }> }>;
    blinking?: Array<{ detected?: boolean; confidence?: number; stable?: boolean }>;
    talking?: Array<{ detected?: boolean; confidence?: number; stable?: boolean }>;
    expression?: Array<{ scores?: Record<string, number> }>;
  };
};

function latest<T>(values: T[] | undefined): T | undefined {
  return values?.at(-1);
}

function asDecodedMetrics(value: unknown): DecodedMetrics | undefined {
  return value && typeof value === "object" && !Buffer.isBuffer(value)
    ? (value as DecodedMetrics)
    : undefined;
}

function confidenceOf(...values: Array<number | undefined>): number {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? 0
    : present.reduce((sum, value) => sum + value, 0) / present.length / 100;
}

export interface SmartSpectraProviderOptions {
  apiKey?: string;
  deviceIndex?: number;
  requestedMetrics?: number[];
  debug?: boolean;
}

export class SmartSpectraProvider extends VitalsProvider {
  private readonly sdk: SmartSpectraSDK;
  private readonly debug: boolean;
  private running = false;
  private diagnosticSent = false;
  private metricsPayloadSeen = false;

  constructor(options: SmartSpectraProviderOptions = {}) {
    super();
    this.debug = options.debug ?? false;

    const apiKey = options.apiKey ?? process.env.SMARTSPECTRA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "SMARTSPECTRA_API_KEY is required to use the real SmartSpectra provider",
      );
    }

    this.sdk = new SmartSpectraSDK({
      apiKey,
      requestedMetrics: options.requestedMetrics ?? [
        ...breathingMetrics,
        ...cardioMetrics,
        ...faceMetrics,
        ...edaMetrics,
      ],
    });

    this.sdk.on("processingStatus", (status) => {
      if (status === 3) {
        this.emit("status", { kind: "running" });
      }
    });

    this.sdk.on("validationStatus", (code, timestampUs, hint) => {
      this.emit("status", {
        kind: "validation",
        code,
        hint,
        ts: timestampUs / 1000,
      });
    });

    this.sdk.on("error", (code, message, retryable) => {
      const error = new Error(
        `SmartSpectra error ${code}: ${message}${retryable ? " (retryable)" : ""}`,
      );
      this.emit("error", error);
    });

    this.sdk.on("metrics", (buffer, timestampUs) => {
      this.handleMetrics(decodeMetrics(buffer), timestampUs / 1000);
    });

    this.sdk.useCamera({ deviceIndex: options.deviceIndex });
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.emit("status", { kind: "starting" });
    this.sdk.start();
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    await this.sdk.stopAsync();
    await this.sdk.destroy();
    this.running = false;
    this.emit("status", { kind: "stopped" });
  }

  private handleMetrics(raw: unknown, ts: number): void {
    const metrics = asDecodedMetrics(raw);
    if (!metrics) {
      if (this.debug && !this.diagnosticSent) {
        this.diagnosticSent = true;
        this.emit(
          "status",
          {
            kind: "diagnostic",
            message:
              "SmartSpectra returned an undecodable metrics payload. " +
              "Check the installed SDK payload decoder.",
          },
        );
      }
      return;
    }

    const breathing = latest(metrics.breathing?.rate);
    const pulse = latest(metrics.cardio?.pulseRate);
    const hrv = latest(metrics.cardio?.hrv);
    const eda = latest(metrics.eda?.trace);
    const breathingCount = metrics.breathing?.rate?.length ?? 0;
    const pulseCount = metrics.cardio?.pulseRate?.length ?? 0;
    const hrvCount = metrics.cardio?.hrv?.length ?? 0;
    const faceLandmarkCount = metrics.face?.landmarks?.length ?? 0;

    if (this.debug && !this.metricsPayloadSeen) {
      this.metricsPayloadSeen = true;
      this.emit("status", {
        kind: "diagnostic",
        message:
          `Metric payload: pulse=${pulseCount}, breathing=${breathingCount}, ` +
          `hrv=${hrvCount}, faceLandmarks=${faceLandmarkCount}. ` +
          "Counts of zero mean the SDK did not return that metric in this payload.",
      });
    }
    if (
      this.debug &&
      !this.diagnosticSent &&
      pulse === undefined &&
      hrv === undefined &&
      breathing === undefined &&
      eda === undefined
    ) {
      this.diagnosticSent = true;
      this.emit("status", {
        kind: "diagnostic",
        message:
          `Decoded groups: cardio=${metrics.cardio ? "present" : "missing"}, ` +
          `breathing=${metrics.breathing ? "present" : "missing"}, ` +
          `face=${metrics.face ? "present" : "missing"}, ` +
          `eda=${metrics.eda ? "present" : "missing"}. ` +
          "A present-but-empty cardio group usually indicates measurement " +
          "quality or subscription authorization, not camera transport.",
      });
    }

    const sample: VitalsSample = {
      ts,
      hr: pulse?.value,
      br: breathing?.value,
      hrv: hrv?.rmssd,
      eda: eda?.value,
      confidence: confidenceOf(
        pulse?.confidence,
        breathing?.confidence,
        hrv?.confidence,
        eda?.confidence,
      ),
    };
    if (
      sample.hr !== undefined ||
      sample.br !== undefined ||
      sample.hrv !== undefined ||
      sample.eda !== undefined
    ) {
      this.emit("sample", sample);
    }

    const landmarks = latest(metrics.face?.landmarks);
    const blinking = latest(metrics.face?.blinking);
    const talking = latest(metrics.face?.talking);
    const expression = latest(metrics.face?.expression);
    if (
      !landmarks?.value?.length &&
      !blinking &&
      !talking &&
      !expression
    ) {
      return;
    }

    const face: FaceSample = {
      ts,
      landmarks: landmarks?.value,
      stable: landmarks?.stable ?? false,
      blinking: blinking?.detected ?? false,
      talking: talking?.detected ?? false,
      expression: expression?.scores,
    };
    this.emit("face", face);
  }
}
