// Integration contract (design.md §5 "Integrations"). One file per
// integration in this directory, auto-discovered by index.ts. Each
// integration contributes tools (levers), doctrine (prompt guidance),
// lever-status + context lines (live state for the serializer), and
// optionally events (sensor role: it raises pings).
//
// State model: AgentDeps = the ports; PingRuntime = per-ping state on top
// of them; DJSession = per-session durable state.

import type { z } from "zod";
import type { DJSession } from "../../memory/session.js";
import type { Decision, FeedSink, PingEvent, TrackResult } from "../../types.js";
import type { ActuatorPort, SpotifyPort } from "../../ports.js";

/** Everything outside the core that the agent acts through. */
export interface AgentDeps {
  spotify: SpotifyPort;
  act: ActuatorPort;
  feed: FeedSink;
}

export interface PingRuntime extends AgentDeps {
  session: DJSession;
  event: PingEvent;
  interruptAllowed: boolean;
  /** id stamped onto every ledger entry this deliberation produces */
  pingId: string;
  /** searches so far this ping (soft budget → nudge, never a refusal) */
  searches: number;
  /** every action taken this ping, in order; the model decides when it is done */
  actions: Decision[];
  /** uris surfaced by search this ping — the only queueable ones */
  seen: Map<string, TrackResult>;
}

/** record one action; tools may be composed, the runner stops when the model ends its turn */
export function decide(rt: PingRuntime, decision: Decision): void {
  rt.actions.push(decision);
}

/** "name ✓" or "name on cooldown 34s" for the AVAILABLE LEVERS line */
export const leverStatus = (name: string, waitSec = 0): string =>
  waitSec > 0 ? `${name} on cooldown ${Math.ceil(waitSec)}s` : `${name} ✓`;

/** tool result when a lever is on cooldown */
export const cooldownRefusal = (label: string, waitSec: number): string =>
  `${label} on cooldown for ${Math.ceil(waitSec)}s — choose another lever.`;

/** A tool as the registry sees it. `input` is already parsed against `inputSchema`;
 *  write tools with defineTool() to get it typed. */
export interface AttuneTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(input: any, rt: PingRuntime): string | Promise<string>;
}

/** call-site inference helper so `run` sees its own schema's output type */
export function defineTool<S extends z.ZodTypeAny>(t: {
  name: string;
  description: string;
  inputSchema: S;
  run(input: z.infer<S>, rt: PingRuntime): string | Promise<string>;
}): AttuneTool {
  return t;
}

export interface Integration {
  name: string;
  /** sort key for prompt/status assembly (default 50) */
  order?: number;
  /** 1–3 sentences appended to the system prompt: when to reach for these levers */
  doctrine?: string;
  tools: AttuneTool[];
  /** fragments for the AVAILABLE LEVERS line, e.g. "start_breathing_pacer on cooldown 34s" */
  leverStatus?(session: DJSession, deps: AgentDeps): string[];
  /** one live context line (e.g. "NOW_PLAYING: …"), or null to omit */
  contextLine?(session: DJSession, deps: AgentDeps): string | null;
  /** sensor role: subscribe to a port and raise pings; returns a stop function */
  events?(emit: (e: PingEvent) => void, session: DJSession, deps: AgentDeps): () => void;
}
