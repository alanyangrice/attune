// Actuator smoke test: exercise each lever through the ActuatorPort, for real
// on this Mac (ACTUATORS=macos) or printed (default).
//
//   npm run actuators:smoke                      # all, gently
//   npm run actuators:smoke -- --only=duck       # duck|dnd|say|break|pacer
//
// DND flips your Focus state (on, then off after 3 s) and needs the two
// Shortcuts "Attune DND On" / "Attune DND Off" — otherwise you get the setup hint.

import { createActuators } from "../adapters/index.js";
import { MacActuators } from "../adapters/actuators-macos.js";
import { CONFIG } from "../config.js";
import { argOf } from "./args.js";

const LEVERS = ["duck", "say", "break", "pacer", "dnd"] as const;
type Lever = (typeof LEVERS)[number];

const only = argOf("only");
const wanted: Lever[] = only ? (only.split(",") as Lever[]) : [...LEVERS];
const bad = wanted.filter((l) => !LEVERS.includes(l));
if (bad.length) {
  console.error(`unknown lever(s) ${bad.join(", ")} — use --only=${LEVERS.join("|")}`);
  process.exit(2);
}

const t0 = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const act = createActuators({ print: (l) => log(`actuate  ${l}`), warn: (m) => log(`WARN     ${m}`) });
log(`actuators=${CONFIG.actuators}${CONFIG.actuators === "console" ? " (set ACTUATORS=macos for real effects)" : ""}`);

const steps: Record<Lever, () => Promise<void>> = {
  async duck() {
    log("duck: volume → 50% for 5 s, then restored");
    act.duckVolume(50, 5);
    await sleep(6500);
  },
  async say() {
    log("say: one short line");
    act.say("Hi, this is Attune. Nice and steady.");
    await sleep(4000);
  },
  async break() {
    log("break: one notification");
    act.suggestBreak("stretch", 3, "Smoke test — your shoulders have been up for a while.");
    await sleep(2000);
  },
  async pacer() {
    log("pacer: notification + music ducked to 40% for 8 s");
    act.startPacer(8, 6);
    await sleep(9500);
  },
  async dnd() {
    log("dnd: Focus on, then off after 3 s");
    await act.setDnd(true);
    await sleep(3000);
    await act.setDnd(false);
  },
};

for (const lever of wanted) await steps[lever]();
if (act instanceof MacActuators) await act.dispose(); // restore volume if a duck is still pending
log(`done: ${wanted.join(", ")}`);
process.exit(0);
