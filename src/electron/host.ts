// The host proper: builds the ports from src/, hands them to a
// SessionController, and bridges it to one BrowserWindow over two IPC
// channels (design.md §7). No business logic here — every decision about
// what to do with a command or a sensor reading is the controller's.
//
//   main → renderer   "session:event"    SessionEvent (every one, unfiltered)
//   renderer → main   "session:command"  SessionCommand via ipcMain.handle

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, session as electronSession, systemPreferences } from "electron";
import { createActuators } from "../core/adapters/index.js";
import { createSpotify } from "../core/adapters/spotify/index.js";
import { CONFIG } from "../core/config.js";
import { HotkeyAttentionProvider } from "../core/sensors/attention/hotkey.js";
import { createVitals, MockVitalsProvider } from "../core/sensors/index.js";
import { SessionController } from "../core/session/controller.js";
import type { SessionCommand, SessionEvent } from "../core/session/events.js";
import { COMMAND_CHANNEL, EVENT_CHANNEL } from "./bridge.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist-electron/electron
const root = app.getAppPath(); // the project (where package.json lives)

/** dev: the Vite server (npm run dev sets ATTUNE_RENDERER_URL); prod: the built renderer */
const RENDERER_URL = process.env.ATTUNE_RENDERER_URL ?? "";
const RENDERER_FILE = path.join(root, "src", "renderer", "dist", "index.html");
const PRELOAD = path.join(here, "preload.cjs");

/** only our own page may get the camera — nothing else, nothing remote */
function isOurPage(url: string): boolean {
  if (RENDERER_URL && url.startsWith(RENDERER_URL)) return true;
  return url.startsWith("file://");
}

function installPermissionHandlers(): void {
  const ses = electronSession.defaultSession;
  // Presage's Electron quickstart pattern: grant `media` (video only) to the
  // local page, deny everything else. Their renderer SDK calls getUserMedia,
  // so this is the gate it passes through once the camera moves in-window.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details.requestingUrl || wc.getURL();
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    const videoOnly = permission === "media" && mediaTypes.length > 0 && mediaTypes.every((t) => t === "video");
    callback(videoOnly && isOurPage(url));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (permission !== "media") return false;
    const mediaType = "mediaType" in details ? details.mediaType : undefined;
    return isOurPage(origin) && (mediaType === undefined || mediaType === "video");
  });
}

async function ensureCameraAccess(): Promise<void> {
  // The in-process SmartSpectra provider (src/sensors/smartspectra.ts) opens
  // the camera from main; on macOS the TCC prompt is attributed to this app.
  // The unpackaged Electron.app already carries NSCameraUsageDescription.
  if (process.platform !== "darwin" || CONFIG.vitals !== "real") return;
  if (systemPreferences.getMediaAccessStatus("camera") === "granted") return;
  const granted = await systemPreferences.askForMediaAccess("camera");
  if (!granted) console.warn("[host] camera access denied — VITALS=real will not produce samples");
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: "Attune",
    backgroundColor: "#0b0d12",
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.on("did-fail-load", (_e, code, desc, url) => console.error(`[host] load failed ${code} ${desc} ${url}`));
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") console.log(`[renderer:${event.level}] ${event.message}`);
  });
  if (RENDERER_URL) {
    void win.loadURL(RENDERER_URL);
  } else if (existsSync(RENDERER_FILE)) {
    void win.loadFile(RENDERER_FILE);
  } else {
    void win.loadURL(
      "data:text/html," +
        encodeURIComponent(
          "<body style='background:#0b0d12;color:#e6e8ef;font:18px system-ui;padding:2rem'>" +
            "<h2>Attune: renderer not built</h2><p>Run <code>npm run dev</code> (Vite) or <code>npm run build:renderer</code> first.</p></body>",
        ),
    );
  }
  // TODO(presage): when camera capture moves into the window, this is where
  // `@smartspectra/node-sdk/main` attaches (attachSmartSpectra(win) or the
  // quickstart's equivalent) and the preload adds `/preload`. For now the
  // SmartSpectraProvider in src/ captures in-process, so the window stays
  // camera-free.
  return win;
}

export async function startHost(): Promise<void> {
  await app.whenReady();
  installPermissionHandlers();

  // ── ports (same recipe as src/dev/run-loop.ts, minus stdout) ─────────────
  const vitals = createVitals();
  const mock = vitals instanceof MockVitalsProvider ? vitals : null;
  const attention = new HotkeyAttentionProvider(); // camera fuser (attention/fuse.ts) drops in here
  const spotify = await createSpotify(); // SPOTIFY=real runs the PKCE login before returning
  const act = createActuators({
    print: (line) => console.log(`[act] ${line}`),
    onPacer: (seconds, bpm) => mock?.paceBreathing(bpm, seconds), // biofeedback: the mock body follows the pacer
  });
  const controller = new SessionController({ vitals, attention, spotify, act });

  // ── window + IPC ─────────────────────────────────────────────────────────
  let win = createWindow();

  // Events the renderer needs to redraw from scratch after a (re)load — HMR,
  // Cmd+R — are cached and replayed on did-finish-load. Pure transport.
  const replay = new Map<SessionEvent["type"], SessionEvent>();
  const REPLAYED: ReadonlySet<SessionEvent["type"]> = new Set([
    "session:state",
    "vitals:status",
    "vitals:sample",
    "attention:state",
    "player:state",
    "ledger:update",
  ]);

  const trace = process.env.ATTUNE_TRACE === "1"; // dev: log every event/command on stdout
  const send = (event: SessionEvent) => {
    if (trace && event.type !== "vitals:sample") console.log(`[event] ${JSON.stringify(event).slice(0, 300)}`);
    if (REPLAYED.has(event.type)) replay.set(event.type, event);
    if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event);
  };
  controller.on("event", send);
  win.webContents.on("did-finish-load", () => {
    win.webContents.send(EVENT_CHANNEL, { type: "session:state", state: controller.state } satisfies SessionEvent);
    for (const e of replay.values()) if (e.type !== "session:state") win.webContents.send(EVENT_CHANNEL, e);
  });

  ipcMain.handle(COMMAND_CHANNEL, async (_e, cmd: SessionCommand) => {
    if (trace) console.log(`[command] ${JSON.stringify(cmd)}`);
    if (cmd.type === "session:start") await ensureCameraAccess();
    await controller.dispatch(cmd);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    if (controller.running) void controller.dispatch({ type: "session:stop" });
  });

  // ── dev-only: ATTUNE_SCREENSHOT=/path.png starts a demo session, waits, snaps, quits ──
  const shot = process.env.ATTUNE_SCREENSHOT;
  if (shot) {
    const afterMs = Number(process.env.ATTUNE_SCREENSHOT_AFTER_MS ?? 30_000);
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        void controller.dispatch({
          type: "session:start",
          target: "focus",
          task: "orgo chapter 7 problem set",
          taste: "mostly instrumental; likes Bonobo and film scores; no country",
        });
      }, 1500);
      setTimeout(() => void controller.dispatch({ type: "demo:stress", level: "spike" }), Math.min(afterMs * 0.45, 20_000));
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        writeFileSync(shot, img.toPNG());
        console.log(`[host] screenshot written to ${shot}`);
        app.exit(0);
      }, afterMs);
    });
  }
}
