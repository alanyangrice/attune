// The agent's gate (design.md §5 ping table): every sensor or player event
// lands here; gating decides whether it wakes the model at all. One
// deliberation in flight; at most one pending (highest priority wins);
// REFOCUSED never costs an LLM call. Construct via createAgent() in index.ts.

import { deliberate, type AgentDeps } from "./deliberate.js";
import type { DJSession } from "../memory/session.js";
import type { PingEvent, PingKind } from "../types.js";

const PRIORITY: Record<PingKind, number> = {
  SESSION_START: 6,
  SPIKE: 5,
  USER_NUDGE: 5,
  TARGET_CHANGED: 5,
  DISTRACTED: 4,
  TRACK_ENDING: 3,
  REFOCUSED: 1,
};

export class AgentLoop {
  private inFlight = false;
  private pending: PingEvent | null = null;

  constructor(
    private session: DJSession,
    private deps: AgentDeps,
  ) {}

  private skip(text: string): void {
    this.deps.feed({ ts: Date.now(), phase: "skip", text: `∅ ${text}` });
  }

  async handle(event: PingEvent): Promise<void> {
    const { session, deps } = this;

    // book-keeping ping — no LLM (design.md §5)
    if (event.kind === "REFOCUSED") {
      session.markPulledBack();
      const t = session.currentTrackEntry();
      this.skip(`refocused — credited ${t ? `"${t.track.name}"` : "the current state"} with the pull-back`);
      return;
    }

    if (event.kind === "TRACK_ENDING" && deps.spotify.hasQueued()) {
      this.skip("track ending, but the next one is already queued");
      return;
    }

    if (event.kind === "SPIKE" || event.kind === "DISTRACTED") {
      const wait = session.interruptAvailableIn();
      if (wait > 0) {
        this.skip(`${event.kind.toLowerCase()} noted — interrupt cooldown ${Math.ceil(wait)}s`);
        return;
      }
    }

    if (this.inFlight) {
      if (!this.pending || PRIORITY[event.kind] > PRIORITY[this.pending.kind]) {
        this.pending = event;
        this.skip(`${event.kind} queued behind the current deliberation`);
      } else {
        this.skip(`${event.kind} dropped (lower priority than pending ${this.pending.kind})`);
      }
      return;
    }

    this.inFlight = true;
    deps.feed({ ts: Date.now(), phase: "ping", text: `⚡ ${event.kind} — ${event.detail}` });
    try {
      await deliberate(session, event, deps);
    } finally {
      this.inFlight = false;
      const next = this.pending;
      this.pending = null;
      if (next) void this.handle(next);
    }
  }
}
