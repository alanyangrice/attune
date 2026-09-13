// SessionController: the one wiring module every front end drives
// (design.md §2 "agent service + thin frontend", §7 IPC channels). It owns
// the session lifecycle and turns the ports' events into SessionEvents
// (events.ts). The console harness (dev/run-loop.ts) and Electron main both
// construct one, subscribe to `event`, and call dispatch() — nothing outside
// src/session/ reaches the agent, the estimator, or the ports directly.
//
//   const controller = new SessionController({ vitals, attention, spotify, act });
//   controller.on("event", (e) => render(e));
//   await controller.dispatch({ type: "session:start", target, task, taste });
//
// dispatch() resolves once the command has been accepted; the outcome of any
// deliberation it triggers arrives later as agent:event / ledger:update.

import { EventEmitter } from "node:events";
import { createAgent, type Agent } from "../agent/index.js";
import { DJSession } from "../memory/session.js";
import type { ActuatorPort, AttentionProvider, SpotifyPort, VitalsProvider } from "../ports.js";
import { Estimator } from "../sensors/estimator.js";
import { MockVitalsProvider } from "../sensors/vitals-mock.js";
import { StubSpotify } from "../adapters/spotify/stub.js";
import type { ScreenChecker } from "../sensors/attention/screen.js";
import type { AttentionState, FeedEvent, PingEvent, PingKind, Target } from "../types.js";
import { errMsg } from "../util.js";
import type { SessionCommand, SessionEvent, SessionState } from "./events.js";

export interface SessionPorts {
  vitals: VitalsProvider;
  attention: AttentionProvider;
  spotify: SpotifyPort;
  act: ActuatorPort;
  /** optional screen on-task checker (design.md §4b); verdicts feed the attention provider when it accepts them */
  screen?: ScreenChecker;
}

/** attention providers the demo controls may drive (the hotkey mock; a real fuser may opt in) */
interface SettableAttention {
  setState(state: AttentionState, reason?: string): void;
}
const isSettable = (a: AttentionProvider): a is AttentionProvider & SettableAttention =>
  typeof (a as Partial<SettableAttention>).setState === "function";

/** the real fuser exposes a score and takes screen verdicts; the mock has neither */
interface FusedAttention {
  readonly score: number | undefined;
  screenVerdict(v: { onTask: boolean; activity: string; confidence: "low" | "medium" | "high"; ts: number }): void;
}
const isFused = (a: AttentionProvider): a is AttentionProvider & FusedAttention =>
  typeof (a as Partial<FusedAttention>).screenVerdict === "function";

/** actuators with resources to release (MacActuators restores volume, stops speech) */
const disposable = (a: ActuatorPort): a is ActuatorPort & { dispose(): Promise<void> } =>
  typeof (a as { dispose?: unknown }).dispose === "function";

const PLAYER_POLL_MS = 5_000;
/** the pacer integration finalises its ledger entry on its own timer right after the pacer ends */
const PACER_SETTLE_MS = 250;

export class SessionController extends EventEmitter<{ event: [SessionEvent] }> {
  state: SessionState;
  session: DJSession | null = null;

  private agent: Agent | null = null;
  private estimator: Estimator | null = null;
  private unsubscribe: (() => void)[] = [];
  private timers = new Set<NodeJS.Timeout>();
  private act: ActuatorPort;

  constructor(private ports: SessionPorts) {
    super();
    this.act = this.wrapActuators(ports.act);
    this.state = {
      phase: "idle",
      target: "focus",
      task: "",
      taste: "",
      startedAt: null,
      vitals: ports.vitals instanceof MockVitalsProvider ? "mock" : "real",
      spotify: ports.spotify instanceof StubSpotify ? "stub" : "real",
    };
  }

  /** discovered integration names, in prompt order (empty until a session starts) */
  get integrations(): string[] {
    return this.agent?.integrations.map((i) => i.name) ?? [];
  }

  get running(): boolean {
    return this.state.phase === "calibrating" || this.state.phase === "running";
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async dispatch(cmd: SessionCommand): Promise<void> {
    switch (cmd.type) {
      case "session:start":
        return this.start(cmd.target, cmd.task, cmd.taste);
      case "session:stop":
        return this.stop();
      case "session:setTarget":
        return this.setTarget(cmd.target);
      case "session:setTask":
        this.setState({ task: cmd.task });
        if (this.session) this.session.task = cmd.task;
        this.ports.screen?.setTask(cmd.task);
        return;
      case "user:nudge":
        if (!this.requireRunning("user:nudge")) return;
        this.ping("USER_NUDGE", "listener hit the Not Vibing button");
        return;
      case "break:respond":
        if (!this.session) return;
        this.session.resolveBreak(cmd.response);
        this.emitLedger();
        return;
      case "screen:pause":
      case "screen:resume": {
        const screen = this.ports.screen;
        if (!screen) return this.warn("screen", `${cmd.type} ignored — screen check not enabled (SCREEN=1)`);
        if (cmd.type === "screen:pause") screen.pause();
        else screen.resume();
        return;
      }
      case "demo:stress":
        if (this.ports.vitals instanceof MockVitalsProvider) this.ports.vitals.setStress(cmd.level);
        else this.warn("vitals", `demo:stress ignored — vitals are real, not a mock`);
        return;
      case "demo:attention":
        if (isSettable(this.ports.attention)) this.ports.attention.setState(cmd.state, cmd.reason);
        else this.warn("system", `demo:attention ignored — the attention provider cannot be driven by hand`);
        return;
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  private async start(target: Target, task: string, taste: string): Promise<void> {
    if (this.running) {
      this.warn("system", "session:start ignored — a session is already running");
      return;
    }
    const { vitals, attention, spotify } = this.ports;
    const session = new DJSession({ target, task, taste });
    const estimator = new Estimator();
    this.session = session;
    this.estimator = estimator;
    this.setState({ phase: "calibrating", target, task, taste, startedAt: session.startedAt });

    const feed = (e: FeedEvent) => {
      this.emit("event", { type: "agent:event", event: e });
      // deliberate() always closes a ping with this line, error path included
      if (e.phase === "info" && e.text.trimStart().startsWith("resolved in")) this.emitLedger();
    };
    // the agent subscribes to spotify trackchange/ending itself (agent/tools/spotify.ts)
    this.agent = await createAgent(session, { spotify, act: this.act, feed });

    // vitals → estimator → session
    this.listen(vitals, "sample", (s) => estimator.feed(s));
    this.listen(vitals, "status", (status) => this.emit("event", { type: "vitals:status", status }));
    this.listen(vitals, "warning", (message) => this.warn("vitals", message));
    this.listen(vitals, "error", (err) => this.warn("vitals", err.message));
    estimator.on("state", (snap) => {
      session.tick(snap, attention.state);
      this.emit("event", { type: "vitals:sample", sample: snap });
    });
    estimator.on("calibrated", () => this.setState({ phase: "running" }));
    estimator.on("spike", (detail) => this.ping("SPIKE", detail));

    // attention → session (+ pings straight to the gate)
    this.listen(attention, "state", (state, reason) => {
      session.attention = state;
      const score = isFused(attention) ? attention.score : undefined;
      this.emit("event", { type: "attention:state", state, reason, ...(score !== undefined ? { score } : {}) });
    });
    this.listen(attention, "ping", (e) => this.ping(e));

    // screen → attention (+ UI)
    const screen = this.ports.screen;
    if (screen) {
      this.listen(screen, "verdict", (v) => {
        if (isFused(attention)) attention.screenVerdict(v);
        this.emit("event", { type: "screen:verdict", onTask: v.onTask, activity: v.activity, confidence: v.confidence, ts: v.ts });
      });
      this.listen(screen, "warning", (message) => this.warn("screen", message));
    }

    // player → UI (registered after createAgent, so session.onTrackChange has already run)
    this.listen(spotify, "trackchange", () => {
      this.emitPlayer();
      this.emitLedger();
    });
    this.listen(spotify, "no-device", (message) => this.emitPlayer(message));
    this.listen(spotify, "device", (message) => this.emitPlayer(message));
    this.listen(spotify, "warning", (message) => this.warn("spotify", message));
    this.every(PLAYER_POLL_MS, () => this.emitPlayer());

    await vitals.start();
    await attention.start();
    spotify.start();
    screen?.start(task);
    this.ping("SESSION_START", `target ${target}; task "${task}"`);
  }

  private async stop(): Promise<void> {
    if (!this.running) {
      this.warn("system", "session:stop ignored — no session is running");
      return;
    }
    const { vitals, attention, spotify } = this.ports;
    this.agent?.stop(); // sensor-role integrations let go of the player first
    this.agent = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.estimator?.removeAllListeners();
    this.estimator = null;
    this.ports.screen?.stop();
    spotify.stop();
    attention.stop();
    try {
      await vitals.stop();
    } catch (err) {
      this.warn("vitals", `stop failed: ${errMsg(err)}`);
    }
    if (disposable(this.ports.act)) await this.ports.act.dispose().catch((err) => this.warn("system", errMsg(err)));
    this.emitLedger(); // final ledger with the last track still open
    this.setState({ phase: "stopped" });
  }

  private setTarget(target: Target): void {
    this.setState({ target });
    if (!this.session) return;
    this.session.target = target;
    this.ping("TARGET_CHANGED", `target is now ${target}`);
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  /** feed one ping to the gate; the ledger is re-emitted once the ping has settled */
  private ping(kind: PingKind | PingEvent, detail = ""): void {
    const agent = this.agent;
    if (!agent) return;
    const event: PingEvent = typeof kind === "string" ? { kind, at: Date.now(), detail } : kind;
    void agent
      .handle(event)
      .catch((err) => this.warn("agent", errMsg(err)))
      .finally(() => {
        // deliberations announce their own end through the feed; the LLM-free
        // book-keeping ping is the one that changes the ledger silently
        if (event.kind === "REFOCUSED") this.emitLedger();
      });
  }

  private requireRunning(what: string): boolean {
    if (this.running) return true;
    this.warn("system", `${what} ignored — no session is running`);
    return false;
  }

  private setState(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("event", { type: "session:state", state: this.state });
  }

  private emitLedger(): void {
    if (!this.session) return;
    this.emit("event", { type: "ledger:update", ledger: structuredClone(this.session.ledger) });
  }

  private emitPlayer(message?: string): void {
    const { spotify } = this.ports;
    this.emit("event", {
      type: "player:state",
      nowPlaying: spotify.nowPlaying(),
      available: spotify.available(),
      ...(message !== undefined ? { message } : {}),
    });
  }

  private warn(source: Extract<SessionEvent, { type: "warning" }>["source"], message: string): void {
    this.emit("event", { type: "warning", source, message });
  }

  /** subscribe for the lifetime of the session (torn down in stop()) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listen<E extends Record<keyof E, any[]>, K extends keyof E & string>(
    emitter: EventEmitter<E>,
    name: K,
    fn: (...args: E[K]) => void,
  ): void {
    // node's typed EventEmitter overloads reject generic keys; the runtime call is the plain on/off pair
    const target = emitter as unknown as { on(n: string, f: unknown): void; off(n: string, f: unknown): void };
    target.on(name, fn);
    this.unsubscribe.push(() => target.off(name, fn));
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms);
    t.unref();
    this.timers.add(t);
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  /** the agent acts through this: same port, plus the UI-facing events the renderer draws */
  private wrapActuators(act: ActuatorPort): ActuatorPort {
    return {
      startPacer: (seconds, bpm) => {
        act.startPacer(seconds, bpm);
        this.emit("event", { type: "pacer:start", seconds, bpm });
        this.after(seconds * 1000, () => this.emit("event", { type: "pacer:end" }));
        this.after(seconds * 1000 + PACER_SETTLE_MS, () => this.emitLedger()); // brAfter / arousalDelta filled in
      },
      suggestBreak: (kind, minutes, reason) => {
        act.suggestBreak(kind, minutes, reason);
        this.emit("event", { type: "break:card", kind, minutes, reason });
      },
      setDnd: (on) => act.setDnd(on),
      duckVolume: (pct, seconds) => act.duckVolume(pct, seconds),
      say: (text) => act.say(text),
    };
  }
}
