import { EventEmitter } from "node:events";

export interface VitalsSample {
  ts: number;
  hr?: number;
  br?: number;
  hrv?: number;
  eda?: number;
  confidence: number;
}

export interface FaceSample {
  ts: number;
  landmarks?: Array<{ x: number; y: number }>;
  stable: boolean;
  blinking: boolean;
  talking: boolean;
  expression?: Record<string, number>;
}

export interface VitalsProviderEvents {
  sample: (sample: VitalsSample) => void;
  face: (sample: FaceSample) => void;
  status: (status: VitalsStatus) => void;
  diagnostic: (message: string) => void;
  error: (error: Error) => void;
}

export type VitalsStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "validation"; code: number; hint: string; ts: number }
  | { kind: "diagnostic"; message: string }
  | { kind: "stopped" };

export abstract class VitalsProvider extends EventEmitter {
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  override on<E extends keyof VitalsProviderEvents>(
    event: E,
    listener: VitalsProviderEvents[E],
  ): this {
    return super.on(event, listener);
  }
}
