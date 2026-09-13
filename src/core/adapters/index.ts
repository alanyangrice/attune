// Actuator adapter factory (WORKPLAN lane 6). CONFIG.actuators picks the mode:
//   console (default) — printed effects (ConsoleActuators)
//   macos             — real osascript / shortcuts / say (ACTUATORS=macos)
// Hooks (onPacer / onBreak / onDnd) reach both, so the dev loop's mock body
// can follow the pacer whichever adapter is live.

import { CONFIG } from "../config.js";
import type { ActuatorPort } from "../ports.js";
import { ConsoleActuators, type ActuatorHooks } from "./actuators-console.js";
import { MacActuators } from "./actuators-macos.js";

export interface ActuatorOptions extends ActuatorHooks {
  /** feed line sink; the console adapter prints its effects here, the mac one logs what it did */
  print?: (line: string) => void;
  /** one-line problems the user must fix (missing Shortcut, osascript failure); defaults to print */
  warn?: (msg: string) => void;
}

export function createActuators(opts: ActuatorOptions = {}): ActuatorPort {
  const print = opts.print ?? ((line: string) => console.log(line));
  const hooks: ActuatorHooks = { onPacer: opts.onPacer, onBreak: opts.onBreak, onDnd: opts.onDnd };
  if (CONFIG.actuators === "macos") {
    return new MacActuators({ ...hooks, log: print, warn: opts.warn ?? ((m) => print(`⚠ ${m}`)) });
  }
  return new ConsoleActuators(print, hooks);
}

export { ConsoleActuators, type ActuatorHooks } from "./actuators-console.js";
export { MacActuators, type MacActuatorOptions } from "./actuators-macos.js";
