// One-shot deliberation harness: load a session fixture, fire ONE ping,
// print exactly what the model saw and what it did. No sensors, no clock.
// This is how you iterate on prompts and tools in seconds instead of
// waiting on the 2.5-minute demo loop.
//
//   npm run ping:fake -- --fixture=track-ending --kind=TRACK_ENDING
//   npm run ping:fake -- --fixture=spike-pacer-cooldown --kind=SPIKE --detail="HR 86 vs 71, sustained 20s"
//   npm run ping      -- --fixture=distracted-dnd-on --kind=DISTRACTED --show-context
//
// Fixture format (src/dev/fixtures/*.json): a SessionSnapshot where every
// timestamp is SECONDS SINCE SESSION START (so fixtures don't rot), plus
// `elapsedSec` (how far into the session we are) and optional `nowPlaying`.

import { readFileSync } from "node:fs";
import { createAgent } from "../agent/index.js";
import { serializeContext } from "../agent/prompts/context.js";
import { ConsoleActuators } from "../adapters/actuators-console.js";
import { StubSpotify } from "../adapters/spotify-stub.js";
import { CONFIG } from "../config.js";
import { DJSession, type SessionSnapshot } from "../memory/session.js";
import { INTERRUPT_KINDS, type FeedEvent, type LedgerEntry, type PingKind, type TrackResult } from "../types.js";

interface Fixture extends Omit<SessionSnapshot, "startedAt" | "lastInterruptAt" | "lastPacerAt" | "lastBreakAt"> {
  elapsedSec: number;
  lastInterruptAtSec?: number; // seconds since session start; omit = never
  lastPacerAtSec?: number;
  lastBreakAtSec?: number;
  nowPlaying?: { uri: string; positionSec: number; queuedUri?: string } | null;
}

const argOf = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const flag = (k: string) => process.argv.includes(`--${k}`);

const fixtureName = argOf("fixture") ?? "track-ending";
const kind = (argOf("kind") ?? "TRACK_ENDING") as PingKind;
const detail = argOf("detail") ?? `(${fixtureName} fixture)`;

const fx = JSON.parse(readFileSync(new URL(`./fixtures/${fixtureName}.json`, import.meta.url), "utf8")) as Fixture;

// rebase fixture-relative seconds onto the wall clock
const startedAt = Date.now() - fx.elapsedSec * 1000;
const abs = (sec: number | undefined) => (sec === undefined ? 0 : startedAt + sec * 1000);
const ledger = fx.ledger.map((e): LedgerEntry => {
  const c = structuredClone(e);
  if ("startedAt" in c) c.startedAt = abs(c.startedAt);
  if ("endedAt" in c && c.endedAt !== undefined) c.endedAt = abs(c.endedAt);
  if ("at" in c) c.at = abs(c.at);
  return c;
});
const session = DJSession.fromSnapshot({
  ...fx,
  startedAt,
  ledger,
  latest: fx.latest ? { ...fx.latest, ts: Date.now() } : null,
  lastInterruptAt: abs(fx.lastInterruptAtSec),
  lastPacerAt: abs(fx.lastPacerAtSec),
  lastBreakAt: abs(fx.lastBreakAtSec),
});

const print = (line: string) => console.log(line);
const feed = (e: FeedEvent) => print(`  ${e.phase.padEnd(8)} ${e.text}`);
const spotify = new StubSpotify();
if (fx.nowPlaying) {
  const byUri = new Map<string, TrackResult>();
  for (const e of ledger) if (e.kind === "track") byUri.set(e.track.uri, e.track);
  const t = byUri.get(fx.nowPlaying.uri);
  if (!t) throw new Error(`nowPlaying.uri ${fx.nowPlaying.uri} is not a track in the fixture ledger`);
  spotify.setNowPlaying(t, fx.nowPlaying.positionSec, fx.nowPlaying.queuedUri ? (byUri.get(fx.nowPlaying.queuedUri) ?? null) : null);
}
const act = new ConsoleActuators((l) => print(`  actuate  ${l}`));
const agent = await createAgent(session, { spotify, act, feed });

const event = { kind, at: Date.now(), detail };
print(`── ping · fixture=${fixtureName} · ${kind} · llm=${CONFIG.fakeLlm ? "FAKE" : CONFIG.model} · mode=${CONFIG.mode}`);
if (flag("show-context")) {
  print("── context the model sees ─────────────────────────────");
  print(serializeContext(session, event, spotify, INTERRUPT_KINDS.has(kind)));
}
print("── run ────────────────────────────────────────────────");
await agent.handle(event);
print("── ledger tail ────────────────────────────────────────");
for (const e of session.ledger.slice(-3)) print(`  ${JSON.stringify(e).slice(0, 160)}`);
agent.stop();
