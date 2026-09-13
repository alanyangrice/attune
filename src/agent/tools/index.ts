// Integration registry: every sibling .ts file in this directory that
// default-exports an Integration is auto-discovered at startup. Drop a new
// file in → its tools, doctrine, and context lines are live on the next run.
// (Note for later: Electron packaging (asar) or a bundler may need this
// swapped for an explicit import list — one file.)

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { DJSession } from "../../memory/session.js";
import type { PingEvent } from "../../types.js";
import { errMsg } from "../../util.js";
import type { AgentDeps, AttuneTool, Integration, PingRuntime } from "./types.js";

let integrations: Integration[] | null = null;

const SKIP = new Set(["index.ts", "index.js", "types.ts", "types.js"]);

export async function loadIntegrations(warn: (msg: string) => void = console.warn): Promise<Integration[]> {
  if (integrations) return integrations;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts") && !SKIP.has(f));
  const loaded = await Promise.all(
    files.map(async (f): Promise<Integration | null> => {
      try {
        const mod = (await import(new URL(f, import.meta.url).href)) as { default?: Integration };
        if (mod.default?.name && Array.isArray(mod.default.tools)) return mod.default;
        warn(`[integrations] ${f} has no default-export Integration — skipped`);
      } catch (err) {
        warn(`[integrations] failed to load ${f}: ${errMsg(err)}`);
      }
      return null;
    }),
  );
  integrations = loaded
    .filter((i): i is Integration => i !== null)
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.name.localeCompare(b.name));
  return integrations;
}

function getIntegrations(): Integration[] {
  if (!integrations) throw new Error("loadIntegrations() must run before the agent is used");
  return integrations;
}

function allTools(): AttuneTool[] {
  return getIntegrations().flatMap((i) => i.tools);
}

/** bind this ping's runtime into SDK-runnable tools */
export function buildRunnerTools(rt: PingRuntime) {
  return allTools().map((t) =>
    betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      run: (input) => t.run(input, rt),
    }),
  );
}

/** invoke one tool by name through the same guards (used by the scripted policy) */
export async function callTool(rt: PingRuntime, name: string, input: unknown): Promise<string> {
  const tool = allTools().find((t) => t.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  return tool.run(tool.inputSchema.parse(input), rt);
}

export function collectDoctrine(): string {
  return getIntegrations()
    .map((i) => i.doctrine)
    .filter((d): d is string => Boolean(d))
    .map((d) => `- ${d}`)
    .join("\n");
}

export function collectLeverStatus(session: DJSession, deps: AgentDeps): string[] {
  return getIntegrations().flatMap((i) => i.leverStatus?.(session, deps) ?? []);
}

export function collectContextLines(session: DJSession, deps: AgentDeps): string[] {
  return getIntegrations()
    .map((i) => i.contextLine?.(session, deps))
    .filter((l): l is string => Boolean(l));
}

/** start every integration's sensor role; returns a stop-all function */
export function startIntegrationEvents(session: DJSession, deps: AgentDeps, emit: (e: PingEvent) => void): () => void {
  const stops = getIntegrations()
    .map((i) => i.events?.(emit, session, deps))
    .filter((s): s is () => void => typeof s === "function");
  return () => stops.forEach((s) => s());
}
