// Restraint as a first-class lever.

import { z } from "zod";
import { decide, defineTool, type Integration, type PingRuntime } from "./types.js";

function nothing(reason: string, rt: PingRuntime): string {
  if (rt.actions.length) return "You already acted this ping — do_nothing only makes sense on its own. Just end your turn.";
  rt.session.addNothing(reason);
  rt.feed({ ts: Date.now(), phase: "decision", text: `— holding steady: ${reason}` });
  decide(rt, { action: "nothing", interrupted: false });
  return "Holding steady.";
}

const integration: Integration = {
  name: "core",
  order: 90,
  doctrine:
    "do_nothing is a real decision: when the listener is FOCUSED and the lane is working, hold everything and protect the streak.",
  tools: [
    defineTool({
      name: "do_nothing",
      description: "Deliberately hold everything as-is. reason is shown in the feed.",
      inputSchema: z.object({ reason: z.string() }),
      run: (i, rt) => nothing(i.reason, rt),
    }),
  ],
  leverStatus: () => ["do_nothing ✓"],
};

export default integration;
