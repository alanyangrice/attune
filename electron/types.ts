// Shared contracts. Everything in the agent core talks through these,
// so the Electron shell / real Spotify / real SmartSpectra swap in later
// without touching the loop. (design.md §1, §5)

export type Target = "focus" | "calm" | "energize";

export type AttentionState =
  | "FOCUSED"
  | "DISTRACTED"
  | "OFF_TASK"
  | "DROWSY"
  | "AWAY"
  | "UNKNOWN";

// ── sensing ────────────────────────────────────────────────────────────────

export interface VitalsSample {
  ts: number; // epoch ms
  hr: number; // bpm
  br: number; // breaths/min
  hrv?: number;
  confidence: number; // 0..1
}

export interface ArousalSnapshot {
  ts: number;
  arousal: number; // signed, vs. own baseline (design.md §4)
  band: "calm" | "elevated" | "high";
  hr: number;
  br: number;
  baselineHr: number;
  baselineBr: number;
  calibrated: boolean;
}

// ── pings (what wakes the agent) ───────────────────────────────────────────

export type PingKind =
  | "SESSION_START"
  | "TRACK_ENDING"
  | "SPIKE"
  | "DISTRACTED" // covers DISTRACTED / OFF_TASK / DROWSY, reason in detail
  | "REFOCUSED"
  | "USER_NUDGE"
  | "TARGET_CHANGED";

export interface PingEvent {
  kind: PingKind;
  at: number;
  /** human-readable evidence, quoted to the model and shown in the feed,
   *  e.g. "HR 84 vs baseline 71, sustained 20s" / "looking down 12s (phone)" */
  detail: string;
}

/** Pings that are allowed to interrupt the current track (design.md §5). */
export const INTERRUPT_KINDS: ReadonlySet<PingKind> = new Set([
  "SPIKE",
  "USER_NUDGE",
  "TARGET_CHANGED",
  "DISTRACTED",
]);

// ── music ──────────────────────────────────────────────────────────────────

export interface TrackResult {
  uri: string;
  name: string;
  artists: string[];
  durationSec: number;
  popularity?: number;
}

export interface NowPlaying {
  track: TrackResult;
  positionSec: number;
  startedAt: number;
}

// ── the ledger: every lever's track record on THIS listener (§4, §5) ──────

export type LedgerEntry =
  | {
      kind: "track";
      track: TrackResult;
      reason: string;
      startedAt: number;
      endedAt?: number;
      meanArousal?: number;
      deltaVsPrev?: number; // mean arousal vs. previous track's mean
      onTaskFraction?: number;
      pulledBack?: boolean; // REFOCUSED landed during this track
    }
  | {
      kind: "pacer";
      seconds: number;
      bpm: number;
      startedAt: number;
      brBefore: number;
      brAfter?: number;
      arousalDelta?: number;
    }
  | {
      kind: "break";
      breakKind: string;
      minutes: number;
      reason: string;
      startedAt: number;
      response: "accepted" | "snoozed" | "ignored" | "pending";
      arousalDelta?: number;
    }
  | { kind: "dnd"; on: boolean; at: number }
  | { kind: "nothing"; reason: string; at: number };

// ── ports (implemented by stubs now, Electron/real services later) ────────

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

// ── feed: what the UI (or console) shows about the agent's inner life ─────

export interface FeedEvent {
  ts: number;
  phase: "ping" | "thinking" | "tool" | "decision" | "skip" | "error" | "info";
  text: string;
}

export type FeedSink = (e: FeedEvent) => void;

/** The one action the deliberation settled on (for cooldown bookkeeping). */
export interface Decision {
  action: "queue_track" | "pacer" | "break" | "dnd" | "duck" | "say" | "nothing";
  interrupted: boolean;
}
