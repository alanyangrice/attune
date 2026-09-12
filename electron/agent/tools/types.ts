// Integration contract (design.md §5 "Integrations"). Pattern mirrors
// evanai-client's tool providers: one file per integration in this
// directory, auto-discovered by index.ts. Each integration contributes
// tools (levers), doctrine (prompt guidance — the "skills" layer),
// lever-status + context lines (live state for the serializer), and
// optionally events (sensor role).
//
// State model: PingRuntime = per-ping state (like evanai's
// per_conversation_state); DJSession = per-session durable state.

import type { z } from "zod";
import type { DJSession } from "../../state/session.js";
import type {
  ActuatorPort,
  Decision,
  FeedSink,
  PingEvent,
  SpotifyPort,
  TrackResult,
} from "../../types.js";

export interface PingRuntime {
  session: DJSession;
  spotify: SpotifyPort;
  act: ActuatorPort;
  feed: FeedSink;
  event: PingEvent;
  interruptAllowed: boolean;
  searchesLeft: number;
  actionTaken: boolean;
  decision: Decision | null;
  /** uris surfaced by search this ping — the only queueable ones */
  seen: Map<string, TrackResult>;
}

export const ALREADY_ACTED = "You already took your action this ping — end your turn.";

/** mark the ping's one action as taken */
export function decide(rt: PingRuntime, decision: Decision): void {
  rt.actionTaken = true;
  rt.decision = decision;
}

export interface AttuneTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  run(input: z.infer<S>, rt: PingRuntime): string | Promise<string>;
}

/** call-site inference helper so `run` sees its own schema's output type */
export function defineTool<S extends z.ZodTypeAny>(t: {
  name: string;
  description: string;
  inputSchema: S;
  run(input: z.infer<S>, rt: PingRuntime): string | Promise<string>;
}): AttuneTool {
  return t as AttuneTool;
}

export interface Integration {
  name: string;
  /** sort key for prompt/status assembly (default 50) */
  order?: number;
  /** 1–3 sentences appended to the system prompt: when to reach for these levers */
  doctrine?: string;
  tools: AttuneTool[];
  /** fragments for the AVAILABLE LEVERS line, e.g. "start_breathing_pacer on cooldown 34s" */
  leverStatus?(session: DJSession): string[];
  /** one live context line (e.g. "LIGHTS: warm 30%"), or null to omit */
  contextLine?(session: DJSession): string | null;
  /** sensor role: start raising pings; returns a stop function */
  events?(emit: (e: PingEvent) => void, session: DJSession): () => void;
}
