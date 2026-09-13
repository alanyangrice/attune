// Console harness for the agentic loop (design.md §10 M1). A thin front end
// over SessionController: it builds the ports, subscribes to the session's
// event stream, prints every SessionEvent as one line, and turns hotkeys (or
// the --auto timeline) into SessionCommands. Electron main is the same shape
// with IPC in place of stdout/stdin (design.md §7).
//
//   npm run loop              live keys, real Claude (needs ANTHROPIC_API_KEY)
//   npm run loop:fake         live keys, scripted policy (no key needed)
//   npm run loop:fake:auto    unattended scripted demo (~2.5 min), then exits
//
// Keys: [s]pike [r]ising [c]alm · [p]hone-distraction [b]ack-on-task
//       [n]ot-vibing [t]arget-cycle [a]ccept-break · [q]uit

import readline from "node:readline";
import { formatLedgerEntry } from "../agent/prompts/context.js";
import { CONFIG } from "../config.js";
import { createActuators } from "../adapters/index.js";
import { createSpotify } from "../adapters/spotify/index.js";
import { createVitals, MockVitalsProvider } from "../sensors/index.js";
import { createAttention, ScreenChecker } from "../sensors/attention/index.js";
import { SessionController } from "../session/controller.js";
import type { SessionCommand, SessionEvent, SessionPhase } from "../session/events.js";
import type { ArousalSnapshot, AttentionState, FeedEvent, NowPlaying, Target } from "../types.js";
import { errMsg, mmss } from "../util.js";
import { argOf, flag } from "./args.js";

const auto = flag("auto");

const target = (argOf("target") ?? "focus") as Target;
const task = argOf("task") ?? "orgo chapter 7 problem set";
const taste = argOf("taste") ?? "mostly instrumental is fine; likes Bonobo and film scores; no country";

const t0 = Date.now();
const clock = () => {
  const s = Math.floor((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const print = (line: string) => console.log(`[${clock()}] ${line}`);
const feed = (e: FeedEvent) => print(e.phase === "thinking" || e.phase === "tool" || e.phase === "info" ? `   ${e.text}` : e.text);

// ── ports + controller ─────────────────────────────────────────────────────

const vitals = createVitals();
const mock = vitals instanceof MockVitalsProvider ? vitals : null; // pacer biofeedback only makes sense on the mock body
const attention = createAttention({ vitals });
const spotify = await createSpotify();
const act = createActuators({ print, warn: (msg: string) => print(`⚠ ${msg}`),
  onPacer: (seconds, bpm) => mock?.paceBreathing(bpm, seconds), // biofeedback: the mock body follows the pacer
});
const screen = CONFIG.screen.enabled ? new ScreenChecker() : undefined;
const controller = new SessionController({ vitals, attention, spotify, act, screen });

const send = (cmd: SessionCommand) => void controller.dispatch(cmd).catch((err) => print(`✗ ${cmd.type}: ${errMsg(err)}`));

// ── render: one line per event (the future tiles / feed / timeline) ───────

let phase: SessionPhase = "idle";
let latest: ArousalSnapshot | null = null;
let attentionState: AttentionState = "UNKNOWN";
let nowPlaying: NowPlaying | null = null;
let baselinePrinted = false;

function render(e: SessionEvent): void {
  switch (e.type) {
    case "session:state":
      if (e.state.phase !== phase) {
        phase = e.state.phase;
        print(`· session ${phase}${phase === "calibrating" ? ` (baseline over ${CONFIG.baselineSec}s)` : ""}`);
      }
      break;
    case "vitals:sample":
      latest = e.sample;
      if (e.sample.calibrated && !baselinePrinted) {
        baselinePrinted = true;
        print(`✓ calibrated — baseline HR ${e.sample.baselineHr.toFixed(0)} / BR ${e.sample.baselineBr.toFixed(0)}`);
      }
      break;
    case "vitals:status":
      print(`· vitals ${e.status}${e.message ? ` — ${e.message}` : ""}`);
      break;
    case "attention:state":
      attentionState = e.state;
      print(`· attention ${e.state} — ${e.reason}`);
      break;
    case "screen:verdict":
      print(`· screen ${e.onTask ? "on task" : "OFF TASK"} — ${e.activity} (${e.confidence})`);
      break;
    case "player:state":
      nowPlaying = e.nowPlaying;
      if (e.message) print(`${e.available ? "✓" : "⚠"} ${e.message}`); // the 5 s heartbeat carries no message
      break;
    case "agent:event":
      feed(e.event);
      break;
    case "ledger:update":
    case "break:card":
    case "pacer:start":
    case "pacer:end":
      // ConsoleActuators already printed the card / overlay; the ledger shows up in the summary
      break;
    case "warning":
      print(`⚠ ${e.source}: ${e.message}`);
      break;
  }
}
controller.on("event", render);

// periodic one-line status (the future vitals/attention tiles)
setInterval(() => {
  if (!latest) return;
  print(
    `· hr ${latest.hr.toFixed(0)} br ${latest.br.toFixed(0)} arousal ${latest.arousal.toFixed(2)} (${latest.band}) · ${attentionState}` +
      (nowPlaying ? ` · "${nowPlaying.track.name}" ${mmss(nowPlaying.positionSec)}` : ""),
  );
}, 10_000).unref();

// ── user/demo commands ─────────────────────────────────────────────────────

const stress = (level: "calm" | "rising" | "spike") => send({ type: "demo:stress", level });
const phone = () => send({ type: "demo:attention", state: "DISTRACTED", reason: "looking down 12s (phone signature)" });
const back = () => send({ type: "demo:attention", state: "FOCUSED", reason: "back on task" });
const nudge = () => send({ type: "user:nudge" });
function cycleTarget() {
  const order: Target[] = ["focus", "calm", "energize"];
  send({ type: "session:setTarget", target: order[(order.indexOf(controller.state.target) + 1) % order.length]! });
}

function summary(): void {
  print("── session summary ──────────────────────────────");
  controller.session?.ledger.forEach((e, i) => print(` ${i + 1}. ${formatLedgerEntry(e)}`));
  print("─────────────────────────────────────────────────");
}

let quitting = false;
async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  summary();
  await controller.dispatch({ type: "session:stop" }).catch((err) => print(`✗ stop: ${errMsg(err)}`));
  process.exit(0);
}

// ── go ─────────────────────────────────────────────────────────────────────

print(
  `attune loop · mode=${CONFIG.mode} · vitals=${CONFIG.vitals} · spotify=${CONFIG.spotify} · llm=${CONFIG.fakeLlm ? "FAKE (scripted)" : CONFIG.model} · target=${target} · task="${task}"`,
);
if (!auto) print("keys: [s]pike [r]ising [c]alm · [p]hone [b]ack · [n]ot-vibing [t]arget [a]ccept-break · [q]uit");

await controller.dispatch({ type: "session:start", target, task, taste });
print(`integrations: ${controller.integrations.join(", ")}`);

if (auto) {
  const at = (sec: number, fn: () => void) => setTimeout(fn, sec * 1000).unref();
  at(20, () => {
    print("‹auto› stress rising (mental math starts)");
    stress("rising");
  });
  at(28, () => {
    print("‹auto› full spike");
    stress("spike");
  });
  at(80, () => {
    print("‹auto› picks up phone");
    phone();
  });
  at(100, () => {
    print("‹auto› looks back at the screen");
    back();
  });
  at(125, () => {
    print("‹auto› user hits Not Vibing");
    nudge();
  });
  at(150, () => void quit());
} else {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", (_str, key: { name?: string; ctrl?: boolean }) => {
    if (key.ctrl && key.name === "c") return void quit();
    switch (key.name) {
      case "s": print("‹key› spike"); stress("spike"); break;
      case "r": print("‹key› rising"); stress("rising"); break;
      case "c": print("‹key› calm"); stress("calm"); break;
      case "p": print("‹key› phone"); phone(); break;
      case "b": print("‹key› back on task"); back(); break;
      case "n": nudge(); break;
      case "t": cycleTarget(); break;
      case "a": print("‹key› break accepted"); send({ type: "break:respond", response: "accepted" }); break;
      case "q": void quit(); break;
    }
  });
}
