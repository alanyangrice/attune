// DJSession: the agent's durable state for one sitting (design.md §1).
// The session outlives every deliberation; each ping is a bounded agentic
// call over this object. The ledger — tracks AND other interventions, each
// with its measured effect — is the agent's memory.

import { CONFIG } from "../config.js";
import type {
  ArousalSnapshot,
  AttentionState,
  BreakEntry,
  LedgerEntry,
  PacerEntry,
  Target,
  TrackEntry,
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
  entry: TrackEntry;
  sumArousal: number;
  n: number;
  onTask: number;
  attnSamples: number;
}

const freshAccumulator = (entry: TrackEntry): TrackAccumulator => ({ entry, sumArousal: 0, n: 0, onTask: 0, attnSamples: 0 });

const secondsUntil = (lastAt: number, cooldownSec: number): number =>
  Math.max(0, cooldownSec - (Date.now() - lastAt) / 1000);

export class DJSession {
  readonly startedAt: number;
  /** append-only, chronological */
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
  private recentArousal: number[] = [];

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

  /** Rebuild a live session from a snapshot. The most recent track entry
   *  without endedAt becomes the current track (its accumulator restarts). */
  static fromSnapshot(snap: SessionSnapshot): DJSession {
    const s = new DJSession(snap);
    s.ledger.push(...structuredClone(snap.ledger));
    s.latest = snap.latest;
    s.attention = snap.attention;
    s.dndOn = snap.dndOn;
    s.lastInterruptAt = snap.lastInterruptAt;
    s.lastPacerAt = snap.lastPacerAt;
    s.lastBreakAt = snap.lastBreakAt;
    const track = s.lastEntry("track");
    if (track && track.endedAt === undefined) s.current = freshAccumulator(track);
    return s;
  }

  // ── ledger queries ───────────────────────────────────────────────────────

  /** most recent entry of a kind (ledger is chronological, so no copy needed) */
  lastEntry(kind: "track"): TrackEntry | undefined;
  lastEntry(kind: "pacer"): PacerEntry | undefined;
  lastEntry(kind: "break"): BreakEntry | undefined;
  lastEntry(kind: LedgerEntry["kind"]): LedgerEntry | undefined {
    return this.ledger.findLast((e) => e.kind === kind);
  }

  currentTrackEntry(): TrackEntry | null {
    return this.current?.entry ?? null;
  }

  alreadyPlayed(uri: string): boolean {
    return this.ledger.some((e) => e.kind === "track" && e.track.uri === uri);
  }

  lastArtists(): string[] {
    return this.lastEntry("track")?.track.artists ?? [];
  }

  /** Why this track may not be queued right now, or null if it may.
   *  The one place the "no repeats / no same artist twice" rules live. */
  queueBlocker(track: TrackResult): string | null {
    if (this.alreadyPlayed(track.uri)) return "Already played this session — pick another track.";
    const last = this.lastArtists();
    if (track.artists.some((a) => last.includes(a)))
      return `Same artist back-to-back (${last.join(", ")}) — pick a different artist.`;
    return null;
  }

  // ── sensing ticks (1 Hz) ─────────────────────────────────────────────────

  tick(s: ArousalSnapshot, attention: AttentionState): void {
    this.latest = s;
    this.attention = attention;
    if (!s.calibrated) return;
    this.recentArousal.push(s.arousal);
    if (this.recentArousal.length > 120) this.recentArousal.shift();
    if (this.current) {
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
    this.closeCurrentTrack();
    const mine = this.pendingQueue?.track.uri === track.uri ? this.pendingQueue : null;
    this.pendingQueue = null;
    const entry: TrackEntry = {
      kind: "track",
      pingId: mine?.pingId,
      track,
      reason: mine?.reason ?? "(queued outside agent)",
      startedAt: Date.now(),
    };
    this.ledger.push(entry);
    this.current = freshAccumulator(entry);
  }

  private closeCurrentTrack(): void {
    if (!this.current) return;
    const { entry, sumArousal, n, onTask, attnSamples } = this.current;
    entry.endedAt = Date.now();
    entry.meanArousal = n ? sumArousal / n : undefined;
    entry.onTaskFraction = attnSamples ? onTask / attnSamples : undefined;
    const prev = this.ledger.findLast(
      (e): e is TrackEntry => e.kind === "track" && e !== entry && e.meanArousal !== undefined,
    );
    if (entry.meanArousal !== undefined && prev?.meanArousal !== undefined) {
      entry.deltaVsPrev = entry.meanArousal - prev.meanArousal;
    }
    this.current = null;
  }

  markPulledBack(): void {
    if (this.current) this.current.entry.pulledBack = true;
  }

  // ── non-music interventions ──────────────────────────────────────────────

  addPacer(seconds: number, bpm: number): PacerEntry {
    const entry: PacerEntry = {
      kind: "pacer",
      pingId: this.currentPingId ?? undefined,
      seconds,
      bpm,
      startedAt: Date.now(),
      brBefore: this.latest?.br ?? 0,
    };
    this.ledger.push(entry);
    this.lastPacerAt = entry.startedAt;
    return entry;
  }

  completePacer(entry: PacerEntry, arousalAtStart: number): void {
    entry.brAfter = this.latest?.br;
    if (this.latest) entry.arousalDelta = this.latest.arousal - arousalAtStart;
  }

  addBreak(breakKind: string, minutes: number, reason: string): BreakEntry {
    const entry: BreakEntry = {
      kind: "break",
      pingId: this.currentPingId ?? undefined,
      breakKind,
      minutes,
      reason,
      startedAt: Date.now(),
      response: "pending",
    };
    this.ledger.push(entry);
    this.lastBreakAt = entry.startedAt;
    return entry;
  }

  resolveBreak(response: "accepted" | "snoozed" | "ignored"): void {
    const pending = this.ledger.findLast((e): e is BreakEntry => e.kind === "break" && e.response === "pending");
    if (pending) pending.response = response;
  }

  addDnd(on: boolean): void {
    this.dndOn = on;
    this.ledger.push({ kind: "dnd", pingId: this.currentPingId ?? undefined, on, at: Date.now() });
  }

  addNothing(reason: string): void {
    this.ledger.push({ kind: "nothing", pingId: this.currentPingId ?? undefined, reason, at: Date.now() });
  }

  // ── cooldowns ────────────────────────────────────────────────────────────

  pacerAvailableIn(): number {
    return secondsUntil(this.lastPacerAt, CONFIG.pacerCooldownSec);
  }

  breakAvailableIn(): number {
    return secondsUntil(this.lastBreakAt, CONFIG.breakCooldownSec);
  }

  interruptAvailableIn(): number {
    return secondsUntil(this.lastInterruptAt, CONFIG.interruptCooldownSec);
  }

  // ── derived signals for the serializer ───────────────────────────────────

  /** 30-sample arousal trend: ↑ / → / ↓ */
  trend(): "↑" | "→" | "↓" {
    const n = this.recentArousal.length;
    if (n < 31) return "→";
    const d = this.recentArousal[n - 1]! - this.recentArousal[n - 31]!;
    return d > 0.03 ? "↑" : d < -0.03 ? "↓" : "→";
  }

  /** live on-task fraction for the current track */
  currentOnTask(): number | undefined {
    if (!this.current || !this.current.attnSamples) return undefined;
    return this.current.onTask / this.current.attnSamples;
  }
}
