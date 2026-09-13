// Screen-channel smoke test: run the on-task checker for a while against a
// stated task and print every verdict and warning, then the Claude call
// count and token usage (design.md §4b).
//
//   npm run screen:smoke                                     # 60 s, default task
//   npm run screen:smoke -- --seconds=40 --task="orgo chapter 7 problem set"
//
// Switch apps/windows while it runs: a title change triggers an immediate
// check; an unchanged screen is skipped without a call.

import { CONFIG } from "../config.js";
import { ScreenChecker } from "../sensors/attention/screen.js";
import { argOf } from "./args.js";

const seconds = Number(argOf("seconds") ?? 60);
const task = argOf("task") ?? "writing TypeScript for the Attune hackathon project";

const t0 = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${line}`);

const checker = new ScreenChecker();
let verdicts = 0;
checker.on("verdict", (v) => {
  verdicts += 1;
  log(`verdict #${verdicts}: ${v.onTask ? "ON task" : "OFF task"} (${v.confidence}) · ${v.activity} · front: ${v.app}${v.title ? ` — ${v.title}` : ""}`);
});
checker.on("warning", (msg) => log(`warning: ${msg}`));

let stopping = false;
function finish(): void {
  if (stopping) return;
  stopping = true;
  checker.stop();
  const u = checker.usage;
  log(`done: ${verdicts} verdicts · ${u.calls} Claude calls · ${u.skipped} skipped (unchanged screen) · ${u.unknown} unparseable`);
  log(`usage: ${u.inputTokens} in · ${u.outputTokens} out · cache read ${u.cacheReadTokens} · cache write ${u.cacheCreationTokens}`);
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, finish);
setTimeout(finish, seconds * 1000);

log(`screen checker for ${seconds}s · model=${CONFIG.model} · every ${CONFIG.screen.intervalSec}s + on window change (poll ${CONFIG.screen.titlePollSec}s) · ≤${CONFIG.screen.maxWidth}px`);
log(`task: "${task}"`);
checker.start(task);
