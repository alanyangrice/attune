// Breathing pacer: the fastest visible closed loop we have (design.md §5, §9).

import { z } from "zod";
import { ALREADY_ACTED, decide, defineTool, type Integration, type PingRuntime } from "./types.js";

function pacer(seconds: number, bpm: number, rt: PingRuntime): string {
  if (rt.actionTaken) return ALREADY_ACTED;
  const wait = rt.session.pacerAvailableIn();
  if (wait > 0) return `Pacer on cooldown for ${Math.ceil(wait)}s — choose another lever.`;
  const entry = rt.session.addPacer(seconds, bpm);
  const arousalAtStart = rt.session.latest?.arousal ?? 0;
  rt.act.startPacer(seconds, bpm);
  setTimeout(() => {
    rt.session.completePacer(entry, arousalAtStart);
    rt.feed({
      ts: Date.now(),
      phase: "info",
      text: `◐ pacer done — BR ${entry.brBefore.toFixed(0)}→${entry.brAfter?.toFixed(0) ?? "?"}, arousal Δ ${entry.arousalDelta !== undefined ? entry.arousalDelta.toFixed(2) : "?"}`,
    });
  }, seconds * 1000).unref();
  rt.feed({ ts: Date.now(), phase: "decision", text: `◐ breathing pacer ${bpm}/min × ${seconds}s` });
  decide(rt, { action: "pacer", interrupted: true });
  return "Pacer started.";
}

const integration: Integration = {
  name: "pacer",
  order: 20,
  doctrine:
    "The pacer is the fastest downshift when arousal is high or rising — breathing converges to it within a minute and heart rate follows. Prefer it over a track swap for acute stress; if the ledger shows it worked on this listener before, reach for it sooner.",
  tools: [
    defineTool({
      name: "start_breathing_pacer",
      description: "Overlay a slow-breathing pacer (music ducks under it). Best when arousal is high or rising.",
      inputSchema: z.object({
        seconds: z.number().int().min(30).max(180).default(90),
        bpm: z.number().int().min(4).max(8).default(6).describe("paced breaths per minute"),
      }),
      run: (i, rt) => pacer(i.seconds, i.bpm, rt),
    }),
  ],
  leverStatus: (session) => {
    const wait = session.pacerAvailableIn();
    return [wait > 0 ? `start_breathing_pacer on cooldown ${Math.ceil(wait)}s` : "start_breathing_pacer ✓"];
  },
};

export default integration;
