// Preload (sandboxed, contextIsolation on): the only code that touches
// ipcRenderer. Exposes `window.attune` = { send, onEvent } and nothing else.
// A .cts file so tsc emits CommonJS, which is what a sandboxed preload needs.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AttuneBridge } from "./bridge.js";
import type { SessionCommand, SessionEvent } from "../core/session/events.js";

// duplicated from bridge.ts on purpose: a sandboxed preload cannot import ESM
const EVENT_CHANNEL = "session:event";
const COMMAND_CHANNEL = "session:command";

const bridge: AttuneBridge = {
  send: (cmd: SessionCommand) => ipcRenderer.invoke(COMMAND_CHANNEL, cmd) as Promise<void>,
  onEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, event: SessionEvent) => cb(event);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld("attune", bridge);
