// `window.attune` is installed by electron/preload.cts. Type-only import:
// nothing from electron/ or src/ is ever bundled into the renderer.
import type { AttuneBridge } from "../../electron/bridge";

declare global {
  interface Window {
    /** absent when the page is opened in a plain browser instead of Electron */
    attune?: AttuneBridge;
  }
}

export {};
