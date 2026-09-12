// DJSession: the agent's durable state for one sitting (design.md §1).
// The session outlives every deliberation; each ping is a bounded agentic
// call over this object. The ledger — tracks AND other interventions, each
// with its measured effect — is the agent's memory.

import { CONFIG } from "../config.js";
import type {
  ArousalSnapshot,
  AttentionState,
  LedgerEntry,
  Target,
  TrackResult,
} from "../types.js";

export interface SessionConfig {
  target: Target;
  task: string; // "orgo chapter 7 problem set"
  taste: string; // free text: "mostly instrumental; likes Radiohead"
  /** override the clock (fixtures / restore); defaults to now */
  startedAt?: number;
}

/** Plain-data view of a session: what a SessionStore persists and what
 *  dev/ping.ts fixtures describe. Timestamps are epoch ms. */
export interface SessionSnapshot extends SessionConfig {
  startedAt: number;
  ledger: LedgerEntry[];
  latest: ArousalSnapshot | null;
  attention: AttentionState;
  dndOn: boolean;
  lastInterruptAt: number;
  lastPacerAt: number;
  lastBreakAt: number;
}

interface TrackAccumulator {
  entry: Extract<LedgerEntry, { kind: "track" }>;
  sumArousal: number;
  n: number;
  onTask: number;
  attnSamples: number;
}

export class DJSession {
  readonly startedAt: number;
  readonly ledger: LedgerEntry[] = [];

  target: Target;
  task: string;
  taste: string;

  attention: AttentionState = "UNKNOWN";
  latest: ArousalSnapshot | null = null;
  dndOn = false;

  /** set by the queue_track tool; consumed when playback actually flips */
  pendingQueue: { track: TrackResult; reason: string; pingId?: string } | null = null;

  /** set by deliberate() for the duration of a ping; stamped onto ledger entries */
  currentPingId: string | null = null;

  // cooldown bookkeeping (design.md §5 anti-nag limits)
  lastInterruptAt = 0;
  lastPacerAt = 0;
  lastBreakAt = 0;

  private current: TrackAccumulator | null = null;
  private playedUris = new Set<string>();

  constructor(cfg: SessionConfig) {
    this.target = cfg.target;
    this.task = cfg.task;
    this.taste = cfg.taste;
    this.startedAt = cfg.startedAt ?? Date.now();
  }

  // ── snapshot / restore ───────────────────────────────────────────────────

  toSnapshot(): SessionSnapshot {
    return {
      target: this.target,
      task: this.task,
      taste: this.taste,
      startedAt: this.startedAt,
      ledger: structuredClone(this.ledger),
      latest: this.latest,
      attention: this.attention,
      dndOn: this.dndOn,
      lastInterruptAt: this.lastInterruptAt,
      lastPacerAt: this.lastPacerAt,
      lastBreakAt: this.lastBreakAt,
    };
  }

  /** Rebuild a live session from a snapshot. A trailing track entry without
   *  endedAt becomes the current track (its accumulator restarts). */
  static fromSnapshot(snap: SessionSnapshot): DJSession {
    const s = new DJSession(snap);
    s.ledger.push(...structuredClone(snap.ledger));
    s.latest = snap.latest;
    s.attention = snap.attention;
    s.dndOn = snap.dndOn;
    s.lastInterruptAt = snap.lastInterruptAt;
    s.lastPacerAt = snap.lastPacerAt;
    s.lastBreakAt = snap.lastBreakAt;
    for (const e of s.ledger) if (e.kind === "track") s.playedUris.add(e.track.uri);
    const last = s.ledger[s.ledger.length - 1];
    if (last?.kind === "track" && last.endedAt === undefined) {
      s.current = { entry: last, sumArousal: 0, n: 0, onTask: 0, attnSamples: 0 };
    }
    return s;
  }

  // ── sensing ticks (1 Hz) ─────────────────────────────────────────────────

  private recentArousal: number[] = [];

  tick(s: ArousalSnapshot, attention: AttentionState): void {
    this.latest = s;
    this.attention = attention;
    if (s.calibrated) {
      this.recentArousal.push(s.arousal);
      if (this.recentArousal.length > 120) this.recentArousal.shift();
    }
    if (this.current && s.calibrated) {
      this.current.sumArousal += s.arousal;
      this.current.n += 1;
      if (attention !== "UNKNOWN") {
        this.current.attnSamples += 1;
        if (attention === "FOCUSED") this.current.onTask += 1;
      }
    }
  }

  // ── track lifecycle (driven by the player's trackchange events) ─────────

  onTrackChange(track: TrackResult): void {
    const prevMean = this.closeCurrentTrack();
    const mine = this.pendingQueue?.track.uri === track.uri ? this.pendingQueue : null;
    this.pendingQueue = null;
    const entry: Extract<LedgerEntry, { kind: "track" }> = {
      kind: "track",
      pingId: mine?.pingId,
      track,
      reason: mine?.reason ?? "(queued outside agent)",
      startedAt: Date.now(),
    };
    this.ledger.push(entry);
    this.current = { entry, sumArousal: 0, n: 0, onTask: 0, attnSamples: 0 };
    this.playedUris.add(track.uri);
    void prevMean;
  }

  private closeCurrentTrack(): number | undefined {
    if (!this.current) return undefined;
    const { entry, sumArousal, n, onTask, attnSamples } = this.current;
    entry.endedAt = Date.now();
    entry.meanArousal = n ? sumArousal / n : undefined;
    entry.onTaskFraction = attnSamples ? onTask / attnSamples : undefined;
    const prevTrack = [...this.ledger]
      .reverse()
      .find((e): e is Extract<LedgerEntry, { kind: "track" }> => e.kind === "track" && e !== entry && e.meanArousal !== undefined);
    if (entry.meanArousal !== undefined && prevTrack?.meanArousal !== undefined) {
      entry.deltaVsPrev = entry.meanArousal - prevTrack.meanArousal;
    }
    this.current = null;
    return entry.meanArousal;
  }

  markPulledBack(): void {
    if (this.current) this.current.entry.pulledBack = true;
  }

  // ── non-music interventions ──────────────────────────────────────────────

  addPacer(seconds: number, bpm: number): Extract<LedgerEntry, { kind: "pacer" }> {
    const entry: Extract<LedgerEntry, { kind: "pacer" }> = {
      kind: "pacer",
      pingId: this.currentPingId ?? undefined,
      seconds,
      bpm,
      startedAt: Date.now(),
      brBefore: this.latest?.br ?? 0,
    };
    this.ledger.push(entry);
    this.lastPacerAt = Date.now();
    return entry;
  }

  completePacer(entry: Extract<LedgerEntry, { kind: "pacer" }>, arousalAtStart: number): void {
    entry.brAfter = this.latest?.br;
    if (this.latest) entry.arousalDelta = this.latest.arousal - arousalAtStart;
  }

  addBreak(breakKind: string, minutes: number, reason: string): Extract<LedgerEntry, { kind: "break" }> {
    const entry: Extract<LedgerEntry, { kind: "break" }> = {
      kind: "break",
      pingId: this.currentPingId ?? undefined,
      breakKind,
      minutes,
      reason,
      startedAt: Date.now(),
      response: "pending",
    };
    this.ledger.push(entry);
    this.lastBreakAt = Date.now();
    return entry;
  }

  resolveBreak(response: "accepted" | "snoozed" | "ignored"): void {
    const pending = [...this.ledger]
      .reverse()
      .find((e): e is Extract<LedgerEntry, { kind: "break" }> => e.kind === "break" && e.response === "pending");
    if (pending) pending.response = response;
  }

  addDnd(on: boolean): void {
    this.dndOn = on;
    this.ledger.push({ kind: "dnd", pingId: this.currentPingId ?? undefined, on, at: Date.now() });
  }

  addNothing(reason: string): void {
    this.ledger.push({ kind: "nothing", pingId: this.currentPingId ?? undefined, reason, at: Date.now() });
  }

  // ── constraints the tools enforce / the prompt cites ────────────────────

  alreadyPlayed(uri: string): boolean {
    return this.playedUris.has(uri);
  }

  lastArtists(): string[] {
    const t = [...this.ledger]
      .reverse()
      .find((e): e is Extract<LedgerEntry, { kind: "track" }> => e.kind === "track");
    return t?.track.artists ?? [];
  }

  pacerAvailableIn(): number {
    return Math.max(0, CONFIG.pacerCooldownSec - (Date.now() - this.lastPacerAt) / 1000);
  }

  breakAvailableIn(): number {
    return Math.max(0, CONFIG.breakCooldownSec - (Date.now() - this.lastBreakAt) / 1000);
  }

  interruptAvailableIn(): number {
    return Math.max(0, CONFIG.interruptCooldownSec - (Date.now() - this.lastInterruptAt) / 1000);
  }

  currentTrackEntry(): Extract<LedgerEntry, { kind: "track" }> | null {
    return this.current?.entry ?? null;
  }

  /** 30-sample arousal trend for the serializer: ↑ / → / ↓ */
  trend(): "↑" | "→" | "↓" {
    const n = this.recentArousal.length;
    if (n < 31) return "→";
    const d = this.recentArousal[n - 1]! - this.recentArousal[n - 31]!;
    return d > 0.03 ? "↑" : d < -0.03 ? "↓" : "→";
  }

  /** live on-task fraction for the current track (for the serializer) */
  currentOnTask(): number | undefined {
    if (!this.current || !this.current.attnSamples) return undefined;
    return this.current.onTask / this.current.attnSamples;
  }
}
