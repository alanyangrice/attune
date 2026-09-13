// Adaptive breaks: break when physiology says so, not when a timer does.

import { z } from "zod";
import { cooldownRefusal, decide, defineTool, leverStatus, type Integration, type PingRuntime } from "./types.js";

function brk(kind: string, minutes: number, reason: string, rt: PingRuntime): string {
  const wait = rt.session.breakAvailableIn();
  if (wait > 0) return cooldownRefusal("Break suggestion", wait);
  rt.session.addBreak(kind, minutes, reason);
  rt.act.suggestBreak(kind, minutes, reason);
  rt.feed({ ts: Date.now(), phase: "decision", text: `☕ suggested ${kind} break (${minutes} min): ${reason}` });
  decide(rt, { action: "break", interrupted: true });
  return "Break suggested — the listener can accept or snooze.";
}

const integration: Integration = {
  name: "breaks",
  order: 30,
  doctrine:
    "Suggest a break for drowsiness, long unbroken stretches, or repeated failed refocusing — never as a first response to a single wobble.",
  tools: [
    defineTool({
      name: "suggest_break",
      description: "Show a gentle break card (Accept / Snooze).",
      inputSchema: z.object({
        kind: z.enum(["stretch", "water", "walk", "breathe"]),
        minutes: z.number().int().min(1).max(10).default(3),
        reason: z.string(),
      }),
      run: (i, rt) => brk(i.kind, i.minutes, i.reason, rt),
    }),
  ],
  leverStatus: (session) => [leverStatus("suggest_break", session.breakAvailableIn())],
};

export default integration;
