// Breathing pacer: the fastest visible closed loop we have (design.md §5, §9).

import { z } from "zod";
import { decide, defineTool, type Integration, type PingRuntime } from "./types.js";

function pacer(seconds: number, bpm: number, rt: PingRuntime): string {
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
    "The pacer is the fastest downshift when arousal is high or rising — breathing converges to it within a minute and heart rate follows. Prefer it over a track swap for acute stress; if the ledger shows it worked on this listener before, reach for it sooner. While a pacer is active or just ended, a low breathing rate is the pacer working — not drowsiness, not a reason to energize.",
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
  contextLine: (session) => {
    const last = [...session.ledger].reverse().find((e) => e.kind === "pacer");
    if (!last || last.kind !== "pacer") return null;
    const endsAt = last.startedAt + last.seconds * 1000;
    const now = Date.now();
    if (now < endsAt) return `PACER: active, ${Math.ceil((endsAt - now) / 1000)}s left at ${last.bpm}/min — breathing is being paced right now`;
    if (now - endsAt < 90_000) return `PACER: ended ${Math.round((now - endsAt) / 1000)}s ago — breathing may still be settling back toward baseline`;
    return null;
  },
};

export default integration;
