# Attune — HackRice 16

A study-session agent: webcam vitals + attention → Claude deliberates → Spotify / breathing pacer / DND / breaks.
`design.md` is the source of truth; `CLAUDE.md` is the developer cheat sheet for the backend (`src/`).

## Run the desktop app

```sh
npm install
npm run dev          # Vite dev server + Electron, real Claude (ANTHROPIC_API_KEY in .env)
npm run dev:fake     # same, scripted policy instead of Claude — no keys needed
npm start            # production-style: builds the renderer + main, then launches Electron
```

`npm run dev` runs two things with `concurrently`: `vite --config src/renderer/vite.config.ts` on
http://localhost:5173, and (once that answers) `tsc -p tsconfig.electron.json` followed by `electron .`
with `ATTUNE_RENDERER_URL=http://localhost:5173`. Two-terminal equivalent:

```sh
npx vite --config src/renderer/vite.config.ts          # terminal 1
npm run electron:dev                                # terminal 2 (waits for Vite, builds main, launches)
```

Renderer edits hot-reload. Edits under `src/electron/` or `src/` need a restart of terminal 2 (main is compiled, not watched).

Env knobs are the same as the console harness (`.env.example`): `VITALS=real` (SmartSpectra camera,
`PRESAGE_API_KEY`), `SPOTIFY=real` (PKCE login opens in the browser before the window appears),
`ACTUATORS=macos`, `ATTUNE_FAKE_LLM=1`, `ATTUNE_MODE=demo|real`.

Dev helpers: `ATTUNE_TRACE=1` prints every SessionEvent / SessionCommand on main's stdout.
`ATTUNE_SCREENSHOT=/path.png [ATTUNE_SCREENSHOT_AFTER_MS=30000]` starts a demo session, snaps the window, and quits.

### The `ELECTRON_RUN_AS_NODE` gotcha

VS Code (and Cursor) export `ELECTRON_RUN_AS_NODE=1` into their integrated terminals. With that set, `electron .`
runs the binary as plain Node: no window, `import "electron"` resolves to a string, and `app` is undefined.
The `dev` / `start` scripts strip it with `env -u ELECTRON_RUN_AS_NODE`; if you launch Electron by hand, do the same
or `unset ELECTRON_RUN_AS_NODE` first.

## Layout

- `src/core/` — the backend: plain Node, zero Electron imports. `npm run loop:fake` runs it headless in a terminal.
- `src/core/session/events.ts` — **the contract**. `SessionEvent` (main → renderer) and `SessionCommand` (renderer → main).
  `src/core/session/controller.ts` emits the former and accepts the latter; every front end speaks only this.
- `src/electron/` — thin host. `main.ts` seeds `.env` and loads `host.ts`, which builds the ports (`createVitals`,
  `HotkeyAttentionProvider`, `createSpotify`, `createActuators`), constructs a `SessionController`, and bridges it
  to one `BrowserWindow`: every event goes down IPC channel `session:event`, commands come up `session:command`
  (`ipcMain.handle`). `preload.cts` exposes `window.attune = { send(cmd), onEvent(cb) }` (typed in `bridge.ts`).
  contextIsolation on, nodeIntegration off, sandbox on; camera permission is granted only to our own page.
- `src/renderer/` — Vite + React dashboard (design.md §6). `src/state.ts` is a reducer over `SessionEvent`s;
  `src/panels/*` are the panels. It imports **types only** from `src/`.

## Type checks

```sh
npm run typecheck        # src/ only (root tsconfig; must stay green)
npm run typecheck:app    # src/electron/ (tsconfig.electron.json) + src/renderer/ (src/renderer/tsconfig.json)
```

`tsconfig.electron.json` compiles `src/electron/**` and `src/**` into `dist-src/electron/` preserving the tree, because the
tool registry (`src/core/agent/tools/index.ts`) discovers integrations by scanning its own directory — a bundler would break it.

## Camera

With `VITALS=real` the SmartSpectra provider in `src/core/sensors/smartspectra.ts` opens the camera from the main process;
macOS prompts once for the Electron binary (the unpackaged `Electron.app` already declares `NSCameraUsageDescription`).
Presage's renderer-side capture is not wired yet — see the `TODO(presage)` in `src/electron/host.ts` and `src/renderer/index.html`.
