// macOS levers: DND, volume ducking, and (opt-in) spoken nudges.

import { z } from "zod";
import { CONFIG } from "../../config.js";
import { ALREADY_ACTED, decide, defineTool, type AttuneTool, type Integration, type PingRuntime } from "./types.js";

async function dnd(on: boolean, rt: PingRuntime): Promise<string> {
  if (rt.actionTaken) return ALREADY_ACTED;
  if (rt.session.dndOn === on) return `DND is already ${on ? "on" : "off"} — choose another action.`;
  rt.session.addDnd(on);
  await rt.act.setDnd(on);
  rt.feed({ ts: Date.now(), phase: "decision", text: `◙ Do Not Disturb ${on ? "on" : "off"}` });
  decide(rt, { action: "dnd", interrupted: false });
  return `DND ${on ? "on" : "off"}.`;
}

function duck(pct: number, seconds: number, rt: PingRuntime): string {
  if (rt.actionTaken) return ALREADY_ACTED;
  rt.act.duckVolume(pct, seconds);
  rt.feed({ ts: Date.now(), phase: "decision", text: `▂ volume ducked to ${pct}% for ${seconds}s` });
  decide(rt, { action: "duck", interrupted: false });
  return "Volume ducked.";
}

function say(text: string, rt: PingRuntime): string {
  if (rt.actionTaken) return ALREADY_ACTED;
  rt.act.say(text);
  rt.feed({ ts: Date.now(), phase: "decision", text: `🗣 "${text}"` });
  decide(rt, { action: "say", interrupted: false });
  return "Said.";
}

const sayTool: AttuneTool = {
  name: "say_nudge",
  description: "Speak one short, playful line out loud. Rare. Never scolding.",
  inputSchema: z.object({ text: z.string().max(140) }),
  run: (i, rt) => say((i as { text: string }).text, rt),
};

const integration: Integration = {
  name: "system",
  order: 40,
  doctrine:
    `set_dnd on protects flow or cuts notification noise; consider turning it off as the session winds down. duck_volume softens without switching tracks.${CONFIG.sayEnabled ? " say_nudge speaks one short playful line — rare, never scolding." : ""}`,
  tools: [
    defineTool({
      name: "set_dnd",
      description: "Toggle macOS Do Not Disturb.",
      inputSchema: z.object({ on: z.boolean() }),
      run: (i, rt) => dnd(i.on, rt),
    }),
    defineTool({
      name: "duck_volume",
      description: "Temporarily soften the music without changing tracks.",
      inputSchema: z.object({
        pct: z.number().int().min(10).max(80).default(40),
        seconds: z.number().int().min(5).max(60).default(20),
      }),
      run: (i, rt) => duck(i.pct, i.seconds, rt),
    }),
    ...(CONFIG.sayEnabled ? [sayTool] : []),
  ],
  leverStatus: (session) => [
    `set_dnd ✓ (currently ${session.dndOn ? "on" : "off"})`,
    "duck_volume ✓",
    ...(CONFIG.sayEnabled ? ["say_nudge ✓"] : []),
  ],
};

export default integration;
