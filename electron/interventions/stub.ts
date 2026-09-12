// Console actuators (design.md §5 mechanics arrive with Electron/macOS:
// pacer overlay window, break card, `shortcuts run "Attune DND"`, osascript,
// `say`). Same port, printed effects — plus optional hooks so the dev
// harness can wire the mock vitals to *react* (pacer → BR converges).

import type { ActuatorPort } from "../types.js";

export interface ActuatorHooks {
  onPacer?: (seconds: number, bpm: number) => void;
  onBreak?: (kind: string, minutes: number) => void;
  onDnd?: (on: boolean) => void;
}

export class ConsoleActuators implements ActuatorPort {
  constructor(
    private print: (line: string) => void,
    private hooks: ActuatorHooks = {},
  ) {}

  startPacer(seconds: number, bpm: number): void {
    this.print(`◐ pacer overlay up — ${bpm} breaths/min for ${seconds}s (music ducked)`);
    this.hooks.onPacer?.(seconds, bpm);
  }

  suggestBreak(kind: string, minutes: number, reason: string): void {
    this.print(`☕ break card — ${kind}, ${minutes} min: "${reason}"  [A]ccept from keyboard`);
    this.hooks.onBreak?.(kind, minutes);
  }

  async setDnd(on: boolean): Promise<void> {
    this.print(`◙ macOS Focus ${on ? "ON" : "OFF"} (stub for: shortcuts run "Attune DND")`);
    this.hooks.onDnd?.(on);
  }

  duckVolume(pct: number, seconds: number): void {
    this.print(`▂ volume ducked to ${pct}% for ${seconds}s (stub for osascript)`);
  }

  say(text: string): void {
    this.print(`🗣 say: "${text}" (stub for macOS \`say\`)`);
  }
}
