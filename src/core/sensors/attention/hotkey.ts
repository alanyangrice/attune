// Hotkey attention provider (design.md §4b, WORKPLAN lane 4 "mock attention
// provider driven by hotkeys"). No camera: the state is whatever the demo
// controls (`demo:attention`, the harness keys) set it to. It emits the same
// `state` + `ping` events the real fuser (fuse.ts) will, so the controller
// and the agent cannot tell the difference — which is the point.

import { EventEmitter } from "node:events";
import type { AttentionEvents, AttentionProvider } from "../../ports.js";
import type { AttentionState } from "../../types.js";

const DISTRACTED_STATES: ReadonlySet<AttentionState> = new Set(["DISTRACTED", "OFF_TASK", "DROWSY", "AWAY"]);

const DEFAULT_REASON: Record<AttentionState, string> = {
  FOCUSED: "back on task",
  DISTRACTED: "looking away from the screen",
  OFF_TASK: "on something other than the task",
  DROWSY: "blink rate up, head drooping",
  AWAY: "no face in frame",
  UNKNOWN: "no reading",
};

export class HotkeyAttentionProvider extends EventEmitter<AttentionEvents> implements AttentionProvider {
  state: AttentionState = "UNKNOWN";

  start(): void {
    // no sensor to wait for: assume the listener is on task until told otherwise
    this.state = "FOCUSED";
    this.emit("state", "FOCUSED", "hotkey mock: assuming FOCUSED until told otherwise");
  }

  stop(): void {
    this.state = "UNKNOWN";
  }

  /** demo control: set the state and raise the matching ping (DISTRACTED / REFOCUSED) */
  setState(state: AttentionState, reason: string = DEFAULT_REASON[state]): void {
    const prev = this.state;
    this.state = state;
    this.emit("state", state, reason);
    const at = Date.now();
    if (DISTRACTED_STATES.has(state)) {
      // the ping kind covers all four; the state itself is the evidence
      const detail = state === "DISTRACTED" ? reason : `${state}: ${reason}`;
      this.emit("ping", { kind: "DISTRACTED", at, detail });
    } else if (state === "FOCUSED" && DISTRACTED_STATES.has(prev)) {
      this.emit("ping", { kind: "REFOCUSED", at, detail: reason });
    }
  }
}
