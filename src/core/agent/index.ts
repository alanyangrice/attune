// The agent's public surface. Both entry points (dev/run-loop.ts today,
// Electron main at M2) build the agent through this one factory so the
// wiring — integration discovery, sensor-role integrations, the gate, the
// deliberation — lives in exactly one place.
//
//   const agent = await createAgent(session, { spotify, act, feed });
//   agent.handle({ kind: "SESSION_START", at: Date.now(), detail: "…" });
//   …
//   agent.stop();

import type { DJSession } from "../memory/session.js";
import type { PingEvent } from "../types.js";
import { AgentLoop } from "./loop.js";
import { loadIntegrations, startIntegrationEvents } from "./tools/index.js";
import type { AgentDeps, Integration } from "./tools/types.js";

export type { AgentDeps } from "./tools/types.js";

export interface Agent {
  /** feed one ping; the gate decides whether it reaches the model */
  handle(event: PingEvent): Promise<void>;
  /** discovered integrations, in prompt order (for status lines / UI) */
  integrations: readonly Integration[];
  /** stop sensor-role integrations; the session object stays intact */
  stop(): void;
}

export async function createAgent(session: DJSession, deps: AgentDeps): Promise<Agent> {
  const integrations = await loadIntegrations((msg) => deps.feed({ ts: Date.now(), phase: "info", text: msg }));
  const loop = new AgentLoop(session, deps);
  const handle = (event: PingEvent) => loop.handle(event);
  const stopSensors = startIntegrationEvents(session, deps, (e) => void handle(e));
  return { handle, integrations, stop: stopSensors };
}
