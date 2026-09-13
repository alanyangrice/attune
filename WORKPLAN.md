# Attune — work plan

What is left to build, split into lanes that can run in parallel. Each lane names the seam it plugs into so nobody has to touch the agent core to land their piece. Section numbers refer to `design.md`. Status as of 2026-09-12 evening.

Legend: ✅ done · 🟡 partial · ⬜ not started

Status as of 2026-09-12 late evening. Backend lanes 1–6 are integrated behind one `SessionController` (`src/core/session/`); every front end speaks `src/core/session/events.ts`.

---

## 0. Where we are

| Lane | Status | One-liner |
|---|---|---|
| 1. Agent core | ✅ | Verified against real Claude (fixtures + full loop). Composes actions, per-ping attribution, one-shot `npm run ping` harness. Left: explicit tool imports before packaging. |
| 2. Events / orchestrator | ✅ | `SessionController` owns lifecycle, wires vitals → estimator → SPIKE, attention → DISTRACTED/REFOCUSED, player → TRACK_ENDING; emits the `SessionEvent` stream, accepts `SessionCommand`s. |
| 3. Spotify | 🟡 | Real adapter verified live for login (persisted) and search. **Playback blocked: the logged-in account is not Premium** (403 PREMIUM_REQUIRED). |
| 4. Presage vitals | 🟡 | `SmartSpectraProvider` (typed decoder, 1 Hz samples + 10 Hz face) behind `createVitals()`. Camera opens and validates; **no clean HR/BR run yet** — another app (Brave) held the camera during tests. |
| 5. Attention | 🟡 | `AttentionFuser` (§4b calibration, 30 s score, hysteresis, phone signature, AWAY/DROWSY/OFF_TASK) passes synthetic scenes in both profiles; `ScreenChecker` verified live with real Claude verdicts. **Not yet run on a real face.** |
| 6. macOS actuators | ✅ | `MacActuators` (`ACTUATORS=macos`): volume duck verified, ElevenLabs TTS verified (macOS `say` fallback), notifications, DND via two user-made Shortcuts. Pacer window / break card UI belong to lane 8. |
| 7. Electron shell + IPC | 🟡 | In progress on a subagent lane: `src/electron/main.ts` + preload, one IPC channel each way (`session:event` / `session:command`). |
| 8. Frontend UI | 🟡 | In progress on the same lane: Vite + React dashboard per §6, DJ feed first. |
| 9. Session memory across sittings | ⬜ (deferred) | `toSnapshot()/fromSnapshot()` exist; no store. |
| 10. Demo + ops | ⬜ | Script drafted in §9; nothing rehearsed. |

Run today: `npm run ping:fake -- --fixture=track-ending --kind=TRACK_ENDING --show-context` (one ping) · `npm run loop:fake:auto` (full loop, 2.5 min, mock everything) · `VITALS=real ATTENTION=fuse SCREEN=1 ACTUATORS=macos npm run loop` (the real thing) · smokes: `vitals:smoke`, `attention:smoke`, `screen:smoke`, `actuators:smoke`.

**Blocked on people, not code:** a Premium Spotify login (lane 3); a clean camera run with no other app holding the camera, sitting centered at eye level (lanes 4–5); Screen Recording + Accessibility permission for the launching app (lane 5 screen check); two Shortcuts named "Attune DND On/Off" (lane 6).

---

## 1. Agent core — `src/core/agent/`, `src/core/memory/`

**Exists:** `createAgent()` → gate (`loop.ts`) → deliberation (`deliberate.ts`, tool runner or scripted policy) → integrations in `tools/` (spotify, pacer, breaks, system, core) → ledger with per-ping attribution. Fixtures + one-shot harness.

- [ ] **Run it against real Claude.** Put `ANTHROPIC_API_KEY` in `.env`, run the three fixtures with `npm run ping`, read the reasoning. This is the biggest unknown in the whole project and takes 5 minutes once a key exists.
- [ ] Tune the system prompt and doctrine from what the fixtures show (expect 1–2 rounds).
- [ ] Add fixtures for the demo beats: `session-start`, `spike-first-time`, `distracted-phone`, `refocused`, `user-nudge`, `drowsy`.
- [ ] Replace directory auto-discovery in `tools/index.ts` with an explicit import list (breaks under Electron packaging).
- [ ] Move NOW_PLAYING out of `prompts/context.ts`'s Spotify parameter into the Spotify integration's `contextLine` hook, so the core stops knowing about music.
- [ ] End-of-session **report card**: one extra Claude call over the full ledger at `effort: "high"` (§9). Output feeds lane 8.
- [ ] Decide: do we keep the scripted policy as the demo fallback if the API is flaky on stage? (Recommend yes — it is already labelled in the feed.)

**Done when:** all fixtures produce sensible decisions from the real model; loop runs 30 min on mock sensors with no error lines.

---

## 2. Events / orchestrator — `src/core/sensors/`, entry point wiring

The "when does the agent wake up" layer. Everything here ends in `agent.handle({ kind, at, detail })`.

**Exists:** `PingKind` set (§5 table), gate priorities and cooldowns, `Estimator` (baseline + SPIKE), mock vitals, `Integration.events` hook for sensor-role integrations.

- [ ] `SessionController` (or similar) that owns lifecycle: `start(target, task, taste)` → SESSION_START; `stop()`; `setTarget()` → TARGET_CHANGED; `nudge()` → USER_NUDGE. Today this logic is inline in `dev/run-loop.ts`; it needs to be a module both the harness and Electron call.
- [ ] TRACK_ENDING from the real player (lane 3) at `trackEndLeadSec` before the end, only if nothing is queued.
- [ ] DISTRACTED / REFOCUSED from the attention provider (lane 5), with the reason string in `detail`.
- [ ] Attention state → `session.tick()` at 1 Hz (currently a hotkey variable).
- [ ] Dedupe / debounce policy for noisy sensors (a spike that flickers across the threshold must not fire twice).
- [ ] Decide: should time-based pings exist (e.g. "45 min unbroken → consider a break")? If yes, it is a sensor-role integration with an `events` hook — no core change.

**Done when:** the harness and Electron main share one wiring module; every ping kind in §5 has a real producer or an explicit "hotkey only for demo" note.

---

## 3. Spotify — `src/core/adapters/spotify/` (§8)

Implements `SpotifyPort` (`search`, `queue`, `nowPlaying`, `hasQueued`) and emits `trackchange` / `ending`.

- [x] Spotify dev app; redirect URI `http://127.0.0.1:8888/callback` (loopback IP literal, not `localhost`).
- [ ] **Allowlist every teammate + the demo account in the dashboard on day one** (dev mode, ≤25 users).
- [x] `auth.ts`: Authorization Code + PKCE from a one-shot local HTTP listener; refresh tokens.
- [x] `client.ts`: `GET /v1/me/player`, `GET /v1/search?type=track`, `POST /v1/me/player/queue`, `POST /v1/me/player/next`.
- [x] `real.ts`: 5 s poll → `trackchange` and `ending` events; `hasQueued()` tracks our own queued URI.
- [x] Interrupt = queue then immediately `next`. Queue cannot be cleared via API → never queue more than one ahead.
- [x] Handle "no active device" 404 → `no-device` event ("press play in Spotify").
- [x] Seed TASTE from `/me/top/artists` available via `RealSpotify.topArtists()` (wire into session start still open).
- [ ] Verify Premium on the demo account.
- [x] `SPOTIFY=stub|real` factory; `npm run loop:real` / `loop:real:fake`.

**Not available to new apps:** `/recommendations`, `/audio-features`, `/audio-analysis`. The agent is the recommender; do not spend time discovering this.

**Done when:** `npm run loop` with `SPOTIFY=real` plays audible music on the laptop and cuts on a hotkey spike.

---

## 4. Presage vitals — `src/core/sensors/smartspectra.ts` (§3, M3)

Implements `VitalsProvider`: emits `sample` (`VitalsSample` at ~1 Hz) and `status`.

- [ ] Confirm the free tier returns HRV + face metrics (ask the sponsor table first thing).
- [ ] Clone their `nodejs/samples/electron-quickstart`; get real numbers on screen. Note their SDK runs in the **renderer** with frames shipped to main over IPC — so this adapter is partly an Electron concern (lane 7).
- [ ] Request the face group explicitly: `requestedMetrics: [...breathingMetrics, ...cardioMetrics, ...faceMetrics]` (default bundle is breathing-only).
- [ ] Downsample the continuous stream to 1 Hz; map `pulse.rate` / `breathing.rate` / `hrv.rmssd` / confidence → `VitalsSample`.
- [ ] Pass raw face metrics through as a `face` event (landmarks, blinking, talking, expression) for lane 5.
- [ ] Confidence gating → `status: low-confidence`; UI badge.
- [ ] Record a real session to JSON for `replay` mock mode (demo insurance).
- [ ] Test in venue lighting early. Glasses, backlighting, and motion degrade rPPG.

**Done when:** the estimator calibrates on a real person and fires SPIKE during 30 s of mental math.

---

## 5. Attention — `src/core/sensors/attention/` (§4b)

Implements `AttentionProvider`: `state` (AWAY / DISTRACTED / OFF_TASK / DROWSY / FOCUSED) and DISTRACTED / REFOCUSED pings with reasons. No ML of our own.

- [ ] `face.ts`: from 478 landmarks → presence, head yaw/pitch ratios, iris-in-eye-box gaze, blink rate (rising edges of `blinking`), eye closure > 1 s, talking fraction, stillness. Formulas and landmark indices are in §4b.
- [ ] Calibration in the first 60 s: median yaw/pitch, gaze box, baseline blink rate. Re-baseline silently after 5 min FOCUSED.
- [ ] `screen.ts`: `desktopCapturer` thumbnail every 30 s + on window change; skip if title and perceptual hash unchanged; one Claude call with structured output → `{ on_task, activity, confidence }`. macOS Screen Recording permission granted at setup, not on stage.
- [ ] `fuse.ts`: weighted 30 s score + state machine with hysteresis (thresholds in §4b, constants in `config.ts`).
- [ ] Mock attention provider driven by hotkeys (what the harness does inline today) so lane 2 and 8 can build without a camera.
- [ ] Privacy stance in the UI: visible "screen check" indicator, pause button, never persisted.

**Done when:** picking up a phone flips the tile to DISTRACTED within ~10 s and looking back flips it to FOCUSED; alt-tabbing to YouTube produces OFF_TASK within one check.

---

## 6. macOS actuators — `src/core/adapters/actuators-macos.ts` (§5)

Implements `ActuatorPort` (`startPacer`, `suggestBreak`, `setDnd`, `duckVolume`, `say`). The pacer and break card are windows, so this straddles lane 7.

- [ ] Pacer overlay: frameless always-on-top window with an expanding/contracting circle at N breaths/min; music ducks under it.
- [ ] Break card: small window with Accept / Snooze; result → `session.resolveBreak()`.
- [ ] DND: a Shortcuts automation ("Attune DND" on/off) invoked via `shortcuts run`.
- [ ] Volume duck: `osascript -e 'set volume output volume N'` with restore.
- [ ] `say`: macOS `say` (behind `ATTUNE_SAY=1`, off by default).

**Done when:** each tool in the fake loop produces the real effect on the laptop.

---

## 7. Electron shell + IPC — `src/electron/` (§2, §7, M2)

Thin host. Owns windows, permissions, and IPC. Imports `src/` and never the reverse.

- [ ] `main.ts`: build session, ports, `createAgent()`; route IPC commands and sensor events to `agent.handle()`.
- [ ] Camera permission handler and preload as in Presage's quickstart (`@smartspectra/node-sdk/main` + `/preload`).
- [ ] Typed IPC channels per §7: `vitals:*`, `attention:*`, `screen:*`, `player:state`, `agent:event`, `ledger:update`, `session:state`; commands `session:start/stop/setTarget/setTask`, `user:nudge`, `screen:pause/resume`, `demo:*`.
- [ ] Feed sink → `agent:event` so the UI gets the same lines the console prints today.
- [ ] Packaging is **not** a goal; `npm start` on the demo laptop is enough. But confirm the tool registry's explicit-import change (lane 1) so nothing depends on directory scanning.
- [ ] `ELECTRON_RUN_AS_NODE` gotcha in VS Code terminals — note in README.

**Done when:** the app launches, shows the camera preview and the DJ feed, and a hotkey spike in mock mode produces an agent decision in the window.

---

## 8. Frontend UI — `src/renderer/` (§6)

React + Vite. Thin client over the IPC events; no logic.

- [ ] Session controls: target picker, task text, taste text, start/stop, **Not Vibing** button.
- [ ] Vitals tiles: HR, BR, arousal band, calibrating / low-confidence / **SIMULATED** badge (never fake silently).
- [ ] Attention tile: state, on-task %, screen-check indicator with pause.
- [ ] Timeline chart: HR curve, attention band, colored track bands.
- [ ] Now playing / up next.
- [ ] **DJ reasoning feed**: every ping → searches → decision + listener-visible reason. This is the demo's star; do it first.
- [ ] Break card + pacer render (or they are separate windows from lane 6 — decide once).
- [ ] Demo controls panel (mock mode only): stress, phone, back, not-vibing.
- [ ] Report card view at session end (from lane 1).

**Done when:** a judge can read what the agent did and why without anyone narrating.

---

## 9. Session memory across sittings — `src/core/memory/store.ts` (deferred)

- [ ] `SessionStore` implementation: JSON per session under `sessions/`.
- [ ] Save on stop; `loadRecent(3)` on start.
- [ ] PRIOR SESSIONS block in the context serializer: which lanes and levers worked for this listener before.
- [ ] Optional `recall_sessions` info tool if the block gets long.

---

## 10. Demo + ops (§9, M5)

- [ ] Pick the demo beats from the §9 menu once real Claude has run.
- [ ] Rehearse the 3-minute script with a stopwatch; record a real session for `replay` mode.
- [ ] Grant camera + Screen Recording permissions on the demo laptop ahead of time.
- [ ] Phone hotspot; verify Presage is on-device (their site says so) so only Claude + Spotify need network.
- [ ] Keys in `.env` on the demo laptop; `.env.example` is the checklist.
- [ ] README with run commands (CLAUDE.md has them; copy the Run section).
- [ ] Commit discipline: `npm run typecheck` and `npm run loop:fake:auto` before every push.

---

## Dependencies and suggested lanes

```
lane 1 (agent, real Claude)  ──┐
lane 3 (Spotify)             ──┼──► lane 2 (events wiring) ──► lane 7 (Electron) ──► lane 8 (UI) ──► lane 10 (demo)
lane 4 (Presage)  ──► lane 5 (attention) ──┘
lane 6 (actuators) ─────────────────────────┘
```

- Lanes 1, 3, 4, 6 have no dependencies on each other. Start all four today.
- Lane 5 needs lane 4's face events; build it on the mock attention provider until then.
- Lane 7 is the integration point; whoever owns it should also own lane 2.
- Lane 8 can start on the IPC contract alone with fake events.
- Lane 9 is optional for the demo. Do it only after lane 1's report card works.

## Open decisions

- [ ] Name: ship as Attune?
- [ ] Pacer / break card: renderer components or separate always-on-top windows?
- [ ] Do we demo with real Spotify audio or is the pacer + DND path the safer money moment?
- [ ] Who owns which lane.
