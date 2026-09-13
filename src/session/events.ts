// The session's public event stream and command set. Every front end — the
// console harness, Electron IPC, tests — speaks only this. The controller
// (src/session/controller.ts) emits SessionEvents and accepts SessionCommands;
// nothing outside src/session/ should need to reach the agent, sensors, or
// adapters directly.

import type { ArousalSnapshot, AttentionState, FeedEvent, LedgerEntry, NowPlaying, Target } from "../types.js";

export type SessionPhase = "idle" | "calibrating" | "running" | "stopped";

export interface SessionState {
  phase: SessionPhase;
  target: Target;
  task: string;
  taste: string;
  startedAt: number | null;
  vitals: "mock" | "real";
  spotify: "stub" | "real";
}

export type VitalsStatus = "calibrating" | "ok" | "low-confidence" | "simulated";

export type SessionEvent =
  | { type: "session:state"; state: SessionState }
  /** 1 Hz, estimator output: HR/BR plus arousal relative to this listener's baseline */
  | { type: "vitals:sample"; sample: ArousalSnapshot }
  | { type: "vitals:status"; status: VitalsStatus; message?: string }
  | { type: "attention:state"; state: AttentionState; reason: string; score?: number }
  | { type: "screen:verdict"; onTask: boolean; activity: string; confidence: "low" | "medium" | "high"; ts: number }
  | { type: "player:state"; nowPlaying: NowPlaying | null; available: boolean; message?: string }
  /** the agent's inner life: ping → thinking → tool calls → decision (design.md §6 DJ feed) */
  | { type: "agent:event"; event: FeedEvent }
  | { type: "ledger:update"; ledger: LedgerEntry[] }
  /** actuator-originated UI: a break card to show, a pacer overlay to run */
  | { type: "break:card"; kind: string; minutes: number; reason: string }
  | { type: "pacer:start"; seconds: number; bpm: number }
  | { type: "pacer:end" }
  | { type: "warning"; source: "vitals" | "spotify" | "screen" | "agent" | "system"; message: string };

export type SessionCommand =
  | { type: "session:start"; target: Target; task: string; taste: string }
  | { type: "session:stop" }
  | { type: "session:setTarget"; target: Target }
  | { type: "session:setTask"; task: string }
  | { type: "user:nudge" }
  | { type: "break:respond"; response: "accepted" | "snoozed" | "ignored" }
  | { type: "screen:pause" }
  | { type: "screen:resume" }
  /** demo controls — honoured only when the corresponding sensor is a mock */
  | { type: "demo:stress"; level: "calm" | "rising" | "spike" }
  | { type: "demo:attention"; state: AttentionState; reason?: string };

export type SessionEventType = SessionEvent["type"];
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;
