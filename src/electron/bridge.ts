// The renderer ⇄ main contract, as seen from the preload bridge (design.md §7).
// One channel each way: every SessionEvent goes down "session:event", every
// SessionCommand comes up "session:command". The shapes themselves live in
// src/session/events.ts — this file only names the channels and the object
// the preload exposes as `window.attune`.

import type { SessionCommand, SessionEvent } from "../core/session/events.js";

export const EVENT_CHANNEL = "session:event";
export const COMMAND_CHANNEL = "session:command";

export interface AttuneBridge {
  /** dispatch one SessionCommand to the controller; resolves when accepted */
  send(cmd: SessionCommand): Promise<void>;
  /** subscribe to the session's event stream; returns an unsubscribe function */
  onEvent(cb: (event: SessionEvent) => void): () => void;
}
