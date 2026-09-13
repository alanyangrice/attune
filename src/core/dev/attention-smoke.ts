// Attention smoke test: scripted synthetic FaceSamples through a fake
// VitalsProvider into AttentionFuser, with the clock driven by hand — no
// camera, no sleeping, deterministic. Scene lengths derive from the timing
// profile so the same script passes under both profiles:
//
//   npm run attention:smoke                      # demo profile (default)
//   ATTUNE_MODE=real npm run attention:smoke     # design.md §4b numbers

import { EventEmitter } from "node:events";
import { CONFIG } from "../config.js";
import type { VitalsEvents, VitalsProvider } from "../ports.js";
import { AttentionFuser } from "../sensors/attention/fuse.js";
import type { AttentionState, FaceSample, PingEvent } from "../types.js";

const A = CONFIG.attention;
const HZ = A.faceHz;
const T0 = 1_700_000_000_000;

class FakeVitals extends EventEmitter<VitalsEvents> implements VitalsProvider {
  start(): void {}
  stop(): void {}
}

// ── synthetic face: 478 points, only the indices face.ts / fuse.ts read are meaningful ──

interface Pose {
  yaw: number; // −0.5..0.5, 0 = centred
  pitch: number; // nose between eye line (0) and chin (1); 0.5 = level
  gazeX: number; // 0..1 across the eye, 0.5 = centred
  gazeY: number; // 0..1 down the eye, 0.5 = centred
}
const CENTRE: Pose = { yaw: 0, pitch: 0.5, gazeX: 0.5, gazeY: 0.5 };

let seed = 42;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1; // −1..1, deterministic

function makeFace(ts: number, pose: Pose, blinking: boolean, talking: boolean): FaceSample {
  const j = (): number => rnd() * 0.3; // sub-pixel settling noise
  const lm = Array.from({ length: 478 }, () => ({ x: 320 + j(), y: 240 + j() }));
  const set = (i: number, x: number, y: number) => (lm[i] = { x: x + j(), y: y + j() });
  set(234, 260, 240); // cheeks
  set(454, 380, 240);
  set(152, 320, 300); // chin
  set(1, 320 + pose.yaw * 120, 210 + (pose.pitch + rnd() * 0.01) * 90); // nose
  const lidH = blinking ? 0 : 10;
  const eyes = [
    { outer: 33, inner: 133, up: 159, lo: 145, iris: 468, left: 280 },
    { outer: 362, inner: 263, up: 386, lo: 374, iris: 473, left: 335 },
  ];
  for (const e of eyes) {
    set(e.outer, e.outer === 33 ? e.left : e.left + 25, 210);
    set(e.inner, e.outer === 33 ? e.left + 25 : e.left, 210);
    set(e.up, e.left + 12.5, 210 - lidH / 2);
    set(e.lo, e.left + 12.5, 210 + lidH / 2);
    const ix = e.left + (pose.gazeX + rnd() * 0.02) * 25;
    const iy = 205 + (pose.gazeY + rnd() * 0.02) * 10;
    for (let k = 0; k < 5; k++) set(e.iris + k, ix + (k - 2) * 0.5, iy);
  }
  return { ts, landmarks: lm, stable: true, blinking, talking };
}

// ── scenes ──────────────────────────────────────────────────────────────────

interface Scene {
  name: string;
  sec: number;
  pose?: Partial<Pose>;
  present?: boolean;
  eyesClosed?: boolean;
  talking?: boolean;
  verdicts?: { atSec: number; onTask: boolean; activity: string }[];
}

const SCENES: Scene[] = [
  { name: "centred at screen", sec: A.calibrationSec + 30 },
  { name: "glance left", sec: 3, pose: { gazeX: 0.15 } },
  { name: "phone (look down)", sec: A.phoneSec + 4, pose: { pitch: 0.75, gazeY: 0.9 } },
  { name: "back at screen", sec: A.refocusSec + 5 },
  { name: "face gone", sec: A.awayAfterSec + 5, present: false },
  { name: "back at desk", sec: A.backAfterSec + 5 },
  { name: "eyes closed #1", sec: A.eyeClosureSec + 1, eyesClosed: true },
  { name: "eyes open", sec: 8 },
  { name: "eyes closed #2", sec: A.eyeClosureSec + 1, eyesClosed: true },
  { name: "eyes open (recover)", sec: A.drowsyClearSec + 5 },
  { name: "talking", sec: 20, talking: true },
  {
    name: "screen off-task",
    sec: 12,
    verdicts: [
      { atSec: 1, onTask: false, activity: "YouTube" },
      { atSec: 6, onTask: false, activity: "YouTube" },
    ],
  },
  { name: "screen on-task", sec: 6, verdicts: [{ atSec: 1, onTask: true, activity: "reading a PDF on SN2 reactions" }] },
];

/** [state, scene it must happen in]; anything else — or a transition during "talking" — fails */
const EXPECTED: [AttentionState, string][] = [
  ["FOCUSED", "centred at screen"],
  ["DISTRACTED", "phone (look down)"],
  ["FOCUSED", "back at screen"],
  ["AWAY", "face gone"],
  ["FOCUSED", "back at desk"],
  ["DROWSY", "eyes closed #2"],
  ["FOCUSED", "eyes open (recover)"],
  ["OFF_TASK", "screen off-task"],
  ["FOCUSED", "screen on-task"],
];
const EXPECTED_PINGS: PingEvent["kind"][] = ["DISTRACTED", "REFOCUSED", "REFOCUSED", "DISTRACTED", "REFOCUSED", "DISTRACTED", "REFOCUSED"];
const REASON_MUST_CONTAIN: Partial<Record<AttentionState, string>> = { DISTRACTED: "phone signature", DROWSY: "eyes closed", OFF_TASK: "screen:" };

// ── run ─────────────────────────────────────────────────────────────────────

const vitals = new FakeVitals();
const fuser = new AttentionFuser({ vitals });
let scene: Scene = SCENES[0]!;
let ts = T0;
const at = () => `[${((ts - T0) / 1000).toFixed(0).padStart(4)}s]`;

const transitions: { state: AttentionState; reason: string; scene: string }[] = [];
const pings: PingEvent[] = [];
fuser.on("state", (state, reason) => {
  transitions.push({ state, reason, scene: scene.name });
  console.log(`${at()} ${state.padEnd(10)} ${reason}  · score=${fuser.score?.toFixed(2) ?? "n/a"}  ‹${scene.name}›`);
});
fuser.on("ping", (p) => {
  pings.push(p);
  console.log(`${at()}   ping ${p.kind}: ${p.detail}`);
});

const wall = Date.now();
console.log(`attention smoke · profile=${CONFIG.mode} · ${SCENES.reduce((s, x) => s + x.sec, 0)}s of scripted face at ${HZ} Hz\n`);
let frame = 0;
for (scene of SCENES) {
  console.log(`${at()} — scene: ${scene.name} (${scene.sec}s)`);
  const pose = { ...CENTRE, ...scene.pose };
  for (let i = 0; i < scene.sec * HZ; i++) {
    ts = T0 + frame * (1000 / HZ);
    if (i % HZ === 0)
      for (const v of scene.verdicts ?? []) if (v.atSec === i / HZ) fuser.screenVerdict({ ...v, confidence: "high", ts });
    const blink = scene.eyesClosed || (ts - T0) % 4000 < 200; // a 200 ms blink every 4 s ≈ 15/min baseline
    if (scene.present !== false) vitals.emit("face", makeFace(ts, pose, blink, !!scene.talking));
    if (i % HZ === HZ - 1) fuser.tick(ts);
    frame += 1;
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────

const problems: string[] = [];
const got = transitions.map((t) => `${t.state}@${t.scene}`);
const want = EXPECTED.map(([s, sc]) => `${s}@${sc}`);
if (got.join(" | ") !== want.join(" | ")) problems.push(`transitions\n    got:  ${got.join(" → ")}\n    want: ${want.join(" → ")}`);
const gotPings = pings.map((p) => p.kind);
if (gotPings.join() !== EXPECTED_PINGS.join()) problems.push(`pings got ${gotPings.join(",")} want ${EXPECTED_PINGS.join(",")}`);
for (const t of transitions) {
  const must = REASON_MUST_CONTAIN[t.state];
  if (must && !t.reason.includes(must)) problems.push(`${t.state} reason "${t.reason}" should mention "${must}"`);
}
if (!fuser.calibrated) problems.push("never calibrated");

console.log(`\n${transitions.length} transitions, ${pings.length} pings, ${frame} frames in ${Date.now() - wall} ms wall`);
if (problems.length) {
  console.log(`FAIL\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("PASS");
