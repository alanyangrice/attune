// Console harness for the agentic loop (design.md §10 M1). Runs the whole
// closed loop headless: mock vitals → estimator → agent (gate → deliberation) →
// stub Spotify/actuators. The Electron renderer replaces this file at M2 —
// everything it prints arrives as the same events the UI will consume.
//
//   npm run loop              live keys, real Claude (needs ANTHROPIC_API_KEY)
//   npm run loop:fake         live keys, scripted policy (no key needed)
//   npm run loop:fake:auto    unattended scripted demo (~2.5 min), then exits
//
// Keys: [s]pike [r]ising [c]alm · [p]hone-distraction [b]ack-on-task
//       [n]ot-vibing [t]arget-cycle [a]ccept-break · [q]uit

import readline from "node:readline";
import { createAgent } from "../agent/index.js";
import { CONFIG } from "../config.js";
import { ConsoleActuators } from "../adapters/actuators-console.js";
import { DJSession } from "../memory/session.js";
import { Estimator } from "../sensors/estimator.js";
import { createSpotify, spotifyMode } from "../adapters/spotify/index.js";
import { MockVitalsProvider } from "../sensors/vitals-mock.js";
import type { AttentionState, FeedEvent, Target } from "../types.js";

const auto = process.argv.includes("--auto");
const argOf = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");

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

// ── wiring ─────────────────────────────────────────────────────────────────

const session = new DJSession({ target, task, taste });
const estimator = new Estimator();
const mock = new MockVitalsProvider();
const spotify = await createSpotify();
const act = new ConsoleActuators(print, {
  onPacer: (seconds, bpm) => mock.paceBreathing(bpm, seconds), // biofeedback: the mock body follows the pacer
});
const agent = await createAgent(session, { spotify, act, feed });

let attention: AttentionState = "UNKNOWN";

mock.on("sample", (s) => estimator.feed(s));
estimator.on("state", (snap) => session.tick(snap, attention));
estimator.on("calibrated", (hr, br) => {
  attention = "FOCUSED";
  print(`✓ calibrated — baseline HR ${hr.toFixed(0)} / BR ${br.toFixed(0)}; assuming FOCUSED until told otherwise`);
});
estimator.on("spike", (detail) => void agent.handle({ kind: "SPIKE", at: Date.now(), detail }));
spotify.on("trackchange", (t) => {
  session.onTrackChange(t);
  print(`▶ now playing "${t.name}" — ${t.artists.join(", ")}`);
});
spotify.on("ending", (t) =>
  void agent.handle({ kind: "TRACK_ENDING", at: Date.now(), detail: `"${t.name}" ends in ~${CONFIG.trackEndLeadSec}s` }),
);
spotify.on("no-device", (msg) => print(`⚠ ${msg}`));

// periodic one-line status (the future vitals/attention tiles)
setInterval(() => {
  const v = session.latest;
  const np = spotify.nowPlaying();
  if (!v) return;
  print(
    `· hr ${v.hr.toFixed(0)} br ${v.br.toFixed(0)} arousal ${v.arousal.toFixed(2)} (${v.band}) · ${attention}` +
      (np ? ` · "${np.track.name}" ${Math.floor(np.positionSec / 60)}:${String(np.positionSec % 60).padStart(2, "0")}` : ""),
  );
}, 10_000).unref();

// ── user/demo events ───────────────────────────────────────────────────────

function distracted(detail: string) {
  attention = "DISTRACTED";
  void agent.handle({ kind: "DISTRACTED", at: Date.now(), detail });
}
function refocused() {
  attention = "FOCUSED";
  void agent.handle({ kind: "REFOCUSED", at: Date.now(), detail: "back on task" });
}
function cycleTarget() {
  const order: Target[] = ["focus", "calm", "energize"];
  session.target = order[(order.indexOf(session.target) + 1) % order.length]!;
  void agent.handle({ kind: "TARGET_CHANGED", at: Date.now(), detail: `target is now ${session.target}` });
}

function summary(): void {
  print("── session summary ──────────────────────────────");
  session.ledger.forEach((e, i) => {
    switch (e.kind) {
      case "track": {
        const bits = [`"${e.track.name}" — ${e.track.artists.join(", ")}`];
        if (e.meanArousal !== undefined) bits.push(`arousal ${e.meanArousal.toFixed(2)}`);
        if (e.deltaVsPrev !== undefined) bits.push(`Δ ${e.deltaVsPrev >= 0 ? "+" : ""}${e.deltaVsPrev.toFixed(2)}`);
        if (e.onTaskFraction !== undefined) bits.push(`on-task ${Math.round(e.onTaskFraction * 100)}%`);
        if (e.pulledBack) bits.push("pulled back ✓");
        print(` ${i + 1}. ${bits.join(" · ")}`);
        break;
      }
      case "pacer":
        print(
          ` ${i + 1}. [pacer ${e.seconds}s @ ${e.bpm}/min] BR ${e.brBefore.toFixed(0)}→${e.brAfter?.toFixed(0) ?? "?"} arousal Δ ${e.arousalDelta !== undefined ? e.arousalDelta.toFixed(2) : "?"}`,
        );
        break;
      case "break":
        print(` ${i + 1}. [break ${e.breakKind} ${e.minutes} min] ${e.response}`);
        break;
      case "dnd":
        print(` ${i + 1}. [dnd ${e.on ? "on" : "off"}]`);
        break;
      case "nothing":
        print(` ${i + 1}. [held steady: ${e.reason}]`);
        break;
    }
  });
  print("─────────────────────────────────────────────────");
}

function quit(): void {
  summary();
  agent.stop();
  mock.stop();
  spotify.stop();
  process.exit(0);
}

// ── go ─────────────────────────────────────────────────────────────────────

print(
  `attune loop · mode=${CONFIG.mode} · spotify=${spotifyMode()} · llm=${CONFIG.fakeLlm ? "FAKE (scripted)" : CONFIG.model} · target=${target} · task="${task}"`,
);
print(`integrations: ${agent.integrations.map((i) => i.name).join(", ")}`);
if (!auto) print("keys: [s]pike [r]ising [c]alm · [p]hone [b]ack · [n]ot-vibing [t]arget [a]ccept-break · [q]uit");

mock.start();
spotify.start();
void agent.handle({ kind: "SESSION_START", at: Date.now(), detail: `target ${target}; task "${task}"` });

if (auto) {
  const at = (sec: number, fn: () => void) => setTimeout(fn, sec * 1000).unref();
  at(20, () => {
    print("‹auto› stress rising (mental math starts)");
    mock.setStress("rising");
  });
  at(28, () => {
    print("‹auto› full spike");
    mock.setStress("spike");
  });
  at(80, () => {
    print("‹auto› picks up phone");
    distracted("looking down 12s (phone signature)");
  });
  at(100, () => {
    print("‹auto› looks back at the screen");
    refocused();
  });
  at(125, () => {
    print("‹auto› user hits Not Vibing");
    void agent.handle({ kind: "USER_NUDGE", at: Date.now(), detail: "listener hit the Not Vibing button" });
  });
  at(150, quit);
} else {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", (_str, key: { name?: string; ctrl?: boolean }) => {
    if (key.ctrl && key.name === "c") return quit();
    switch (key.name) {
      case "s": print("‹key› spike"); mock.setStress("spike"); break;
      case "r": print("‹key› rising"); mock.setStress("rising"); break;
      case "c": print("‹key› calm"); mock.setStress("calm"); break;
      case "p": print("‹key› phone"); distracted("looking down 12s (phone signature)"); break;
      case "b": print("‹key› back on task"); refocused(); break;
      case "n": void agent.handle({ kind: "USER_NUDGE", at: Date.now(), detail: "listener hit the Not Vibing button" }); break;
      case "t": cycleTarget(); break;
      case "a": session.resolveBreak("accepted"); print("‹key› break accepted"); break;
      case "q": quit(); break;
    }
  });
}
