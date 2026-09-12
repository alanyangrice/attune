// Ports: every boundary between the agent core and the outside world.
// Interfaces only. Adapters (src/adapters/*, later Electron/real services)
// implement them; agent/, memory/, and prompts/ import only from here.
// Rule: if a module in agent/ or memory/ needs something the core doesn't
// own, it arrives through a port declared in this file.

import type { EventEmitter } from "node:events";
import type { AttentionState, NowPlaying, TrackResult } from "./types.js";

// ── actuators (what the agent's tools act through) ───────────────────────


export interface SpotifyPort {
  search(query: string, limit: number): Promise<TrackResult[]>;
  /** queue next; interrupt=true also skips the current track immediately */
  queue(track: TrackResult, interrupt: boolean): Promise<void>;
  nowPlaying(): NowPlaying | null;
  /** whether we already queued something for the upcoming boundary */
  hasQueued(): boolean;
}

export interface ActuatorPort {
  startPacer(seconds: number, bpm: number): void;
  suggestBreak(kind: string, minutes: number, reason: string): void;
  setDnd(on: boolean): Promise<void>;
  duckVolume(pct: number, seconds: number): void;
  say(text: string): void;
}

// ── sensors (produce samples and pings; the deferred orchestrator side) ──

/** Emits 'sample' (~1 Hz VitalsSample) and 'status' (calibrating | ok | low-confidence | simulated). */
export interface VitalsProvider extends EventEmitter {
  start(): void | Promise<void>;
  stop(): void;
}

/** Emits 'state' (AttentionState + reason) and 'ping' (DISTRACTED / REFOCUSED PingEvents). */
export interface AttentionProvider extends EventEmitter {
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
