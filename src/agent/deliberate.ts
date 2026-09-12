// One deliberation = one bounded agentic call over the session state
// (design.md §1, §5). Real path: Claude via the SDK tool runner over the
// integration registry. Fake path (ATTUNE_FAKE_LLM=1): a scripted policy
// that calls the same tools through the same guards, so the whole loop
// runs without credentials and the ledger/feed look identical.

import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "../config.js";
import type { DJSession } from "../memory/session.js";
import { INTERRUPT_KINDS, type Decision, type FeedSink, type PingEvent, type Target } from "../types.js";
import type { ActuatorPort, SpotifyPort } from "../ports.js";
import { serializeContext } from "./prompts/context.js";
import { systemPrompt } from "./prompts/system.js";
import { buildRunnerTools, callTool } from "./tools/index.js";
import type { PingRuntime } from "./tools/types.js";

export interface AgentDeps {
  spotify: SpotifyPort;
  act: ActuatorPort;
  feed: FeedSink;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic({ timeout: CONFIG.deliberationTimeoutMs, maxRetries: 1 });
  return client;
}

export async function deliberate(session: DJSession, event: PingEvent, deps: AgentDeps): Promise<Decision[]> {
  const interruptAllowed = INTERRUPT_KINDS.has(event.kind);
  const pingId = `${event.kind.toLowerCase()}-${event.at}`;
  session.currentPingId = pingId;
  const rt: PingRuntime = {
    session,
    spotify: deps.spotify,
    act: deps.act,
    feed: deps.feed,
    event,
    interruptAllowed,
    pingId,
    searches: 0,
    actions: [],
    seen: new Map(),
  };
  const t0 = Date.now();
  deps.feed({
    ts: t0,
    phase: "thinking",
    text: `… deliberating (${CONFIG.fakeLlm ? "scripted policy" : CONFIG.model})`,
  });

  try {
    if (CONFIG.fakeLlm) {
      await fakeDeliberate(rt);
    } else {
      const final = await getClient().beta.messages.toolRunner({
        model: CONFIG.model,
        max_tokens: 2048,
        max_iterations: CONFIG.maxIterationsPerPing, // hard stop; the model normally ends its own turn
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: "claude-opus-4-8" }], // auto-fallback if a request is safety-declined
        system: [{ type: "text" as const, text: systemPrompt(), cache_control: { type: "ephemeral" as const } }],
        tools: buildRunnerTools(rt),
        messages: [{ role: "user", content: serializeContext(session, event, deps.spotify, interruptAllowed) }],
      });
      if (rt.actions.length === 0) {
        // model ended its turn without any action tool → that's an implicit hold
        const text = final.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim()
          .slice(0, 200);
        await callTool(rt, "do_nothing", { reason: text || "(model returned no action)" });
      }
    }
  } catch (err) {
    deps.feed({
      ts: Date.now(),
      phase: "error",
      text: `✗ deliberation failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    if (rt.actions.length === 0) await callTool(rt, "do_nothing", { reason: "deliberation failed — holding as-is" });
  } finally {
    session.currentPingId = null;
  }

  if (rt.actions.some((a) => a.interrupted)) session.lastInterruptAt = Date.now();
  const summary = rt.actions.map((a) => a.action).join(" + ") || "nothing";
  deps.feed({ ts: Date.now(), phase: "info", text: `  resolved in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${summary}` });
  return rt.actions;
}

// ── scripted stand-in policy (mirrors design.md §5 "state → move class") ──

const queryFor = (t: Target): string =>
  t === "focus" ? "focus instrumental" : t === "calm" ? "ambient calm slow" : "upbeat energize";

async function fakeDeliberate(rt: PingRuntime): Promise<void> {
  const { session, spotify, event } = rt;
  const band = session.latest?.band ?? "calm";

  const pick = async (query: string, interrupt: boolean, reason: string): Promise<boolean> => {
    const before = rt.actions.length;
    const results = await spotify.search(query, 8);
    for (const t of results) rt.seen.set(t.uri, t);
    const last = session.lastArtists();
    const c = results.find((t) => !session.alreadyPlayed(t.uri) && !t.artists.some((a) => last.includes(a)));
    if (!c) return false;
    await callTool(rt, "queue_track", { uri: c.uri, reason, interrupt });
    return rt.actions.length > before;
  };
  const hold = (reason: string) => callTool(rt, "do_nothing", { reason });

  switch (event.kind) {
    case "SESSION_START":
      await pick(queryFor(session.target), false, `Opening in the ${session.target} lane while your baseline calibrates.`);
      break;
    case "SPIKE":
      if (session.pacerAvailableIn() === 0) {
        await callTool(rt, "start_breathing_pacer", { seconds: CONFIG.mode === "demo" ? 45 : 90, bpm: 6 });
        break;
      }
      if (await pick("ambient calm slow", true, "Vitals are running hot — dropping to something weightless.")) break;
      await hold("spike noted; no calm candidates left");
      break;
    case "DISTRACTED":
      if (/drowsy|sleep/i.test(event.detail)) {
        if (await pick("upbeat energize", true, "Energy is dipping — something with a pulse.")) break;
      } else if (await pick("hook upbeat", true, "Attention drifted — a clear onset to pull you back.")) {
        break;
      }
      if (!session.dndOn) {
        await callTool(rt, "set_dnd", { on: true });
        break;
      }
      await hold("distraction noted; already tried the obvious levers");
      break;
    case "TRACK_ENDING": {
      const q =
        band === "high"
          ? "calm ambient"
          : band === "calm" && session.target === "energize"
            ? "upbeat energize"
            : queryFor(session.target);
      if (!(await pick(q, false, band === "high" ? "Still elevated — keeping it gentle." : "Holding the lane that's been working.")))
        await hold("no fresh candidates in the catalog");
      break;
    }
    case "USER_NUDGE":
      if (!(await pick(session.target === "calm" ? "piano gentle" : "electronic focus texture", true, "Not vibing — switching lanes.")))
        await hold("nudge noted; catalog exhausted");
      break;
    case "TARGET_CHANGED":
      if (!(await pick(queryFor(session.target), true, `Target changed to ${session.target} — pivoting now.`)))
        await hold("target change noted");
      break;
    case "REFOCUSED":
      await hold("back on task"); // loop.ts normally short-circuits this
      break;
  }
}
