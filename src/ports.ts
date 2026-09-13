// Ports: every boundary between the agent core and the outside world.
// Interfaces only. Adapters (src/adapters/*, later Electron/real services)
// implement them; agent/, memory/, and prompts/ import only from here.
// Rule: if a module in agent/ or memory/ needs something the core doesn't
// own, it arrives through a port declared in this file.

import type { EventEmitter } from "node:events";
import type { AttentionState, FaceSample, NowPlaying, PingEvent, TrackResult, VitalsSample } from "./types.js";

// ── music ────────────────────────────────────────────────────────────────

export type SpotifyEvents = {
  /** playback moved to a new track (also fired once for whatever is playing at start) */
  trackchange: [track: TrackResult];
  /** the current track ends in about `secondsLeft`; fired once per track */
  ending: [track: TrackResult, secondsLeft: number];
  /** playback control is unavailable (fired once per outage) / available again */
  "no-device": [message: string];
  device: [message: string];
  /** informational, e.g. account is not Premium */
  warning: [message: string];
};

export interface SpotifyPort extends EventEmitter<SpotifyEvents> {
  start(): void;
  stop(): void;
  search(query: string, limit: number): Promise<TrackResult[]>;
  /** queue next; interrupt=true also skips the current track immediately. Throws if playback control fails. */
  queue(track: TrackResult, interrupt: boolean): Promise<void>;
  nowPlaying(): NowPlaying | null;
  /** whether we already queued something for the upcoming boundary */
  hasQueued(): boolean;
  /** can playback be controlled right now? (false = no active device; search still works) */
  available(): boolean;
}

// ── actuators (what the agent's tools act through) ───────────────────────

export interface ActuatorPort {
  startPacer(seconds: number, bpm: number): void;
  suggestBreak(kind: string, minutes: number, reason: string): void;
  setDnd(on: boolean): Promise<void>;
  duckVolume(pct: number, seconds: number): void;
  say(text: string): void;
}

// ── sensors (produce samples and pings; the deferred orchestrator side) ──

export type VitalsEvents = {
  sample: [sample: VitalsSample]; // 1 Hz, only when hr and br are both present
  face: [sample: FaceSample]; // ~10 Hz when the face group is requested
  status: [status: "calibrating" | "ok" | "low-confidence" | "simulated"];
  /** measurement hints from the sensor ("face not centered", "too dark") — informational */
  warning: [message: string];
  error: [err: Error];
};

export interface VitalsProvider extends EventEmitter<VitalsEvents> {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export type AttentionEvents = {
  state: [state: AttentionState, reason: string];
  ping: [event: PingEvent]; // DISTRACTED / REFOCUSED
};

export interface AttentionProvider extends EventEmitter<AttentionEvents> {
  start(): void | Promise<void>;
  stop(): void;
  readonly state: AttentionState;
}

// ── memory across sittings ───────────────────────────────────────────────

/** Persists SessionSnapshots (see memory/session.ts). */
export interface SessionStore<Snap = unknown> {
  save(snapshot: Snap): Promise<void>;
  loadRecent(n: number): Promise<Snap[]>;
}
