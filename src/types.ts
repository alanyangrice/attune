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
  hrv?: number; // RMSSD, ms
  eda?: number; // electrodermal activity trace, arbitrary units
  confidence: number; // 0..1
}

/** Raw face metrics passed through from the camera at ~10 Hz (design.md §3, §4b). */
export interface FaceSample {
  ts: number;
  /** 478 MediaPipe points, pixel coords; absent = no face */
  landmarks?: { x: number; y: number }[];
  stable: boolean;
  blinking: boolean;
  talking: boolean;
  /** expression class → confidence % */
  expression?: Record<string, number>;
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
      pingId?: string; // deliberation that produced this entry (attribution is per ping)
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
      pingId?: string; // deliberation that produced this entry (attribution is per ping)
      seconds: number;
      bpm: number;
      startedAt: number;
      brBefore: number;
      brAfter?: number;
      arousalDelta?: number;
    }
  | {
      kind: "break";
      pingId?: string; // deliberation that produced this entry (attribution is per ping)
      breakKind: string;
      minutes: number;
      reason: string;
      startedAt: number;
      response: "accepted" | "snoozed" | "ignored" | "pending";
      arousalDelta?: number;
    }
  | { kind: "dnd"; pingId?: string; on: boolean; at: number }
  | { kind: "nothing"; pingId?: string; reason: string; at: number };

export type TrackEntry = Extract<LedgerEntry, { kind: "track" }>;
export type PacerEntry = Extract<LedgerEntry, { kind: "pacer" }>;
export type BreakEntry = Extract<LedgerEntry, { kind: "break" }>;

/** epoch ms at which a ledger entry happened */
export const entryTime = (e: LedgerEntry): number => ("startedAt" in e ? e.startedAt : e.at);

// ── feed: what the UI (or console) shows about the agent's inner life ─────

export interface FeedEvent {
  ts: number;
  phase: "ping" | "thinking" | "tool" | "decision" | "skip" | "error" | "info";
  text: string;
}

export type FeedSink = (e: FeedEvent) => void;

/** One action taken during a deliberation (a ping may take several). */
export interface Decision {
  action: string; // tool-defined label, e.g. "queue_track", "pacer", "nothing"
  interrupted: boolean;
}
