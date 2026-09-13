// The renderer's whole model: a reducer over SessionEvents (plus two purely
// local UI actions). No logic beyond "remember what main told us".

import { useEffect, useReducer } from "react";
import type { SessionCommand, SessionEvent, SessionState, VitalsStatus } from "../../core/session/events";
import type { ArousalSnapshot, AttentionState, FeedEvent, LedgerEntry, NowPlaying } from "../../core/types";

export const HISTORY_MS = 10 * 60_000; // timeline strip window
const FEED_CAP = 600;
const WARNING_CAP = 6;

export interface AttentionInfo {
  state: AttentionState;
  reason: string;
  score?: number;
  since: number;
}

export interface ScreenVerdict {
  onTask: boolean;
  activity: string;
  confidence: "low" | "medium" | "high";
  ts: number;
}

export interface PlayerInfo {
  nowPlaying: NowPlaying | null;
  available: boolean;
  message?: string;
}

export interface Warning {
  source: string;
  message: string;
  ts: number;
}

export interface UIState {
  connected: boolean;
  session: SessionState | null;
  sample: ArousalSnapshot | null;
  history: ArousalSnapshot[];
  vitalsStatus: VitalsStatus | null;
  vitalsMessage: string | null;
  attention: AttentionInfo | null;
  attentionLog: { ts: number; state: AttentionState }[];
  screen: ScreenVerdict | null;
  screenPaused: boolean;
  player: PlayerInfo | null;
  feed: FeedEvent[];
  ledger: LedgerEntry[];
  breakCard: { kind: string; minutes: number; reason: string; at: number } | null;
  pacer: { seconds: number; bpm: number; startedAt: number } | null;
  warnings: Warning[];
}

export const initialState: UIState = {
  connected: typeof window !== "undefined" && !!window.attune,
  session: null,
  sample: null,
  history: [],
  vitalsStatus: null,
  vitalsMessage: null,
  attention: null,
  attentionLog: [],
  screen: null,
  screenPaused: false,
  player: null,
  feed: [],
  ledger: [],
  breakCard: null,
  pacer: null,
  warnings: [],
};

export type Action =
  | { type: "event"; event: SessionEvent }
  | { type: "local:screenPaused"; paused: boolean }
  | { type: "local:dismissBreak" }
  | { type: "local:pacerDone" };

/** a fresh session (new startedAt) clears everything that belongs to the previous one */
function freshSession(s: UIState, next: SessionState): UIState {
  return {
    ...s,
    session: next,
    sample: null,
    history: [],
    attention: null,
    attentionLog: [],
    screen: null,
    player: null,
    feed: [],
    ledger: [],
    breakCard: null,
    pacer: null,
  };
}

export function reduce(s: UIState, a: Action): UIState {
  switch (a.type) {
    case "local:screenPaused":
      return { ...s, screenPaused: a.paused };
    case "local:dismissBreak":
      return { ...s, breakCard: null };
    case "local:pacerDone":
      return { ...s, pacer: null };
    case "event":
      return apply(s, a.event);
  }
}

function apply(s: UIState, e: SessionEvent): UIState {
  switch (e.type) {
    case "session:state": {
      const isNew = e.state.startedAt !== null && e.state.startedAt !== s.session?.startedAt;
      return isNew ? freshSession(s, e.state) : { ...s, session: e.state };
    }
    case "vitals:sample": {
      const cutoff = e.sample.ts - HISTORY_MS;
      const history = s.history.length && s.history[0]!.ts < cutoff ? s.history.filter((x) => x.ts >= cutoff) : s.history;
      return { ...s, sample: e.sample, history: [...history, e.sample] };
    }
    case "vitals:status":
      return { ...s, vitalsStatus: e.status, vitalsMessage: e.message ?? null };
    case "attention:state": {
      const now = Date.now();
      const attention: AttentionInfo = { state: e.state, reason: e.reason, since: now };
      if (e.score !== undefined) attention.score = e.score;
      return { ...s, attention, attentionLog: [...s.attentionLog, { ts: now, state: e.state }] };
    }
    case "screen:verdict":
      return { ...s, screen: { onTask: e.onTask, activity: e.activity, confidence: e.confidence, ts: e.ts } };
    case "player:state": {
      const player: PlayerInfo = { nowPlaying: e.nowPlaying, available: e.available };
      if (e.message !== undefined) player.message = e.message;
      return { ...s, player };
    }
    case "agent:event": {
      const feed = s.feed.length >= FEED_CAP ? s.feed.slice(s.feed.length - FEED_CAP + 1) : s.feed;
      return { ...s, feed: [...feed, e.event] };
    }
    case "ledger:update":
      return { ...s, ledger: e.ledger };
    case "break:card":
      return { ...s, breakCard: { kind: e.kind, minutes: e.minutes, reason: e.reason, at: Date.now() } };
    case "pacer:start":
      return { ...s, pacer: { seconds: e.seconds, bpm: e.bpm, startedAt: Date.now() } };
    case "pacer:end":
      return { ...s, pacer: null };
    case "warning": {
      const warnings = [...s.warnings, { source: e.source, message: e.message, ts: Date.now() }];
      return { ...s, warnings: warnings.slice(-WARNING_CAP) };
    }
  }
}

/** subscribe to main's event stream for the component's lifetime */
export function useSession(): [UIState, React.Dispatch<Action>, (cmd: SessionCommand) => void] {
  const [state, dispatch] = useReducer(reduce, initialState);
  useEffect(() => {
    const bridge = window.attune;
    if (!bridge) return;
    return bridge.onEvent((event) => dispatch({ type: "event", event }));
  }, []);
  const send = (cmd: SessionCommand) => {
    const bridge = window.attune;
    if (!bridge) {
      console.warn("[attune] not inside Electron — command dropped", cmd);
      return;
    }
    bridge.send(cmd).catch((err: unknown) => console.error(`[attune] ${cmd.type} failed`, err));
  };
  return [state, dispatch, send];
}

// ── derived helpers ────────────────────────────────────────────────────────

/** fraction of session time spent FOCUSED, from the attention state log */
export function onTaskFraction(log: { ts: number; state: AttentionState }[], now: number): number | null {
  if (log.length === 0) return null;
  let focused = 0;
  let total = 0;
  for (let i = 0; i < log.length; i++) {
    const cur = log[i]!;
    const end = i + 1 < log.length ? log[i + 1]!.ts : now;
    const dur = Math.max(0, end - cur.ts);
    total += dur;
    if (cur.state === "FOCUSED") focused += dur;
  }
  return total > 0 ? focused / total : null;
}

export function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function clockOf(ts: number, startedAt: number | null): string {
  if (startedAt) return mmss((ts - startedAt) / 1000);
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}
