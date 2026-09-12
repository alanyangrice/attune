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
}

interface TrackAccumulator {
  entry: Extract<LedgerEntry, { kind: "track" }>;
  sumArousal: number;
  n: number;
  onTask: number;
  attnSamples: number;
}

export class DJSession {
  readonly startedAt = Date.now();
  readonly ledger: LedgerEntry[] = [];

  target: Target;
  task: string;
  taste: string;

  attention: AttentionState = "UNKNOWN";
  latest: ArousalSnapshot | null = null;
  dndOn = false;

  /** set by the queue_track tool; consumed when playback actually flips */
  pendingQueue: { track: TrackResult; reason: string } | null = null;

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
    const reason = this.pendingQueue?.track.uri === track.uri ? this.pendingQueue.reason : "(queued outside agent)";
    this.pendingQueue = null;
    const entry: Extract<LedgerEntry, { kind: "track" }> = {
      kind: "track",
      track,
      reason,
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
    this.ledger.push({ kind: "dnd", on, at: Date.now() });
  }

  addNothing(reason: string): void {
    this.ledger.push({ kind: "nothing", reason, at: Date.now() });
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
