# Attune — a DJ that listens back

**Working title:** Attune (alts: Vibecheck, Tempo, Biobeat — bikeshed later)

**One-liner:** A study-session focus agent that watches your real physiology *and attention* through the webcam (Presage SmartSpectra) plus what's on your screen, deliberates like a human DJ between tracks, and steers you toward the state you asked for — music as its main instrument, plus a small kit of other levers (breathing pacer, adaptive breaks, Do Not Disturb) for the moments a track isn't the right move.

**The demo sentence for judges:** "Focus apps guess. Attune *measures* — contactless heart rate, breathing, and where your eyes are, straight from the camera — and closes the loop: every track, breathing cue, and break is an experiment, the agent reads the result in your body, and learns which levers actually keep *you* on task. Sometimes its smartest move is doing nothing, and it tells you why."

---

## Decisions locked (2026-09-12)

| Decision | Choice | Why |
|---|---|---|
| Vitals source | Presage SmartSpectra Node SDK, **mock-first** | Key expected at hackathon, not in hand → everything builds against a `VitalsProvider` interface; real adapter drops in |
| App shape | **Electron app**, seeded from Presage's `nodejs/samples/electron-quickstart` | Their runnable reference app already does camera → IPC → SDK; we build the DJ around it |
| Spotify | **Premium, drive the real desktop Spotify app** via Web API (`/me/player`) | Least code, real sound from the laptop, most reliable live |
| Recommender | **The agent itself picks the exact next track** (verifies via Spotify search), with visible reasoning | Spotify killed `/recommendations` + `/audio-features` for new apps (Nov 2024) — Claude's music knowledge replaces them, and it's the better demo anyway |
| Agent model | `claude-opus-5` via `@anthropic-ai/sdk` tool runner | Deliberation quality *is* the product; at ~20 calls/hour cost is pennies |
| Scope pivot (2026-09-12) | Agent optimizes **attention, not just music**: one action per ping from an **intervention toolbox** (§5); music stays the backbone | Music is one lever on attention; the other levers demo on faster timescales (breathing converges in ~1 min, distraction reacts in seconds), and explicit `do_nothing` makes restraint visible |
| Demo-moment priorities | **Open** — menu in §9, pick at the table after M1 | Team call once the core loop exists |

---

## 1. Core loop

```
   ┌──────────────────────────────────────────────────────────┐
   │                                                          │
   ▼                                                          │
 webcam ──► SmartSpectra SDK ──► State Estimator ──► ping ──► Focus Agent (Claude)
            (HR, BR, HRV, face,  (arousal §4 +        ▲        │  one action per ping (§5):
             continuous)          attention §4b)      │        │  • search → queue_track
                                                      │        │  • breathing pacer · break
            track-ending / spike / distracted /       │        │  • set_dnd · duck · do_nothing
            drowsy / user-nudge ──────────────────────┘        ▼
                                                   Spotify + overlays + macOS ──► affects listener ──────────┐
                                                                                                               │
   └───────────────────────────────── the listener's body is the feedback signal ─────────────────────────────┘
```

Two more sensor channels feed the same estimator (§4b): **face metrics** from the same SmartSpectra stream (landmarks, blinks, talking) → gaze/head-pose/attention, and a **periodic screen check** (screenshot → Claude → on-task verdict). Together they answer "is the listener actually on task?", which physiology alone can't.

The agent is a **long-running session, not a long-running conversation**: a `DJSession` object lives in the Electron main process for the whole session and holds the durable state (target, baseline, intervention ledger). Each *ping* runs one bounded agentic call (Claude + tool loop, ~5s) over that state. Stateless calls over durable state = crash-safe, no context bloat, easy to replay/debug — and the ledger (tracks, pacer runs, breaks, each with its measured effect) *is* the agent's memory.

## 2. Architecture (Electron)

```
attune/
  electron/                     # main process (Node 20+, TypeScript)
    main.ts                     #   boot + module wiring
    vitals/
      provider.ts               #   VitalsProvider interface + types
      smartspectra.ts           #   real adapter (@smartspectra/node-sdk)
      mock.ts                   #   scripted / replay / manual mock
    state/
      estimator.ts              #   baseline, arousal, spike detection
      session.ts                #   DJSession: target, task, ledger, event log
    attention/
      face.ts                   #   landmarks → head pose, gaze, blink rate, stillness (pure math)
      screen.ts                 #   desktopCapturer → downscaled JPEG → Claude on-task verdict
      fuse.ts                   #   face + screen → attention score + state machine (§4b)
    agent/
      dj.ts                     #   deliberate(): toolRunner call
      prompts.ts                #   system prompt + context serializer
      tools.ts                  #   betaZodTool defs (search + the §5 action toolbox)
    interventions/
      pacer.ts                  #   breathing-pacer overlay window (frameless, always-on-top)
      breaks.ts                 #   break card overlay + accept/snooze plumbing
      system.ts                 #   macOS levers: DND via `shortcuts run`, volume via osascript, optional `say`
    spotify/
      auth.ts                   #   Authorization Code + PKCE, token refresh
      client.ts                 #   thin fetch wrapper
      player.ts                 #   5s poll loop → PlayerState events
    ipc.ts                      #   typed channel contract (see §7)
  src/                          # renderer (React + Vite)
    App.tsx, panels/*           #   dashboard (see §6)
  design.md
```

Everything interesting runs in **main** (SDK, agent, Spotify). The renderer is a dashboard + the SmartSpectra camera-capture page (their renderer entry auto-acquires the camera and ships frames to main over IPC).

## 3. Vitals module

**Interface first — the whole weekend hangs on this seam:**

```ts
interface VitalsSample { ts: number; hr: number; br: number; hrv?: number; eda?: number; confidence: number }
interface FaceSample {                             // raw face metrics, passed through at frame rate
  ts: number;
  landmarks?: { x: number; y: number }[];         // 478 MediaPipe points, pixel coords; absent = no face
  stable: boolean;                                // Presage's own stability flag
  blinking: boolean; talking: boolean;
  expression?: Record<string, number>;            // 8 classes, % confidence
}
interface VitalsProvider extends EventEmitter {  // emits 'sample' (~1 Hz), 'face' (~10-30 Hz), 'status'
  start(): Promise<void>; stop(): void;
}
```

**Real adapter** (`smartspectra.ts`): `npm i @smartspectra/node-sdk` (Apple-Silicon runtime `@smartspectra/node-sdk-darwin-arm64` ships as a platform dep). Instantiate `SmartSpectraSDK` with the API key + requested metrics, listen for `'metrics'` / `'error'` / `'validationStatus'`, call `start()`. It emits **continuous** metrics; we downsample to ~1 Hz and normalize into `VitalsSample`. SDK exposes pulse rate, breathing rate, HRV, EDA, breathing waveforms, face analysis. Arousal (§4) uses **HR + BR only** (HRV is a stretch refinement); attention (§4b) needs the **face group** — request it explicitly, the default bundle is breathing-only: `requestedMetrics: [...breathingMetrics, ...cardioMetrics, ...faceMetrics]`. Face payload per frame: `metrics.face.landmarks.at(-1).value` (478 `{x,y}`), `.blinking.at(-1).detected`, `.talking.at(-1).detected`, `.expression.at(-1).scores`. No gaze, head-pose, or blink-rate fields exist — we derive them (§4b). Electron path: use their `/main`, `/preload`, `/renderer` entry points exactly as the quickstart does.

**Mock adapter** (`mock.ts`) — first-class, not a shim; it's also demo insurance:
- `scripted`: phases baseline(70bpm) → rising → spike(88) → recovery, with noise
- `replay`: plays back a recorded session JSON (record real sessions once the key lands)
- `manual`: UI slider / hotkeys (S = spike, C = calm, L = look away, P = phone, B = back on task) drive the numbers live
- Mock also emits synthetic `face` samples (a canned landmark set nudged per hotkey) so `attention/` can be built and demoed before the key lands

Switch: `VITALS=mock|real`. UI shows a "SIMULATED" badge in mock mode — never fake it silently.

## 4. State estimator

Deliberately dumb math; honesty note in §11.

- **Calibration:** first 60 s of session → `baseline_hr`, `baseline_br` = median of confidence-gated samples. UI shows "calibrating…" (first track already plays during this).
- **Arousal score:** `a = 0.7·ΔHR% + 0.3·ΔBR%` vs. baseline, EMA-smoothed (~20 s window). Bands: calm < 0.05 ≤ elevated < 0.15 ≤ high.
- **Spike event:** `a ≥ 0.15` sustained 15 s **and** ≥ 90 s since last interrupt → emit `SPIKE`.
- **Ledger (the agent's evidence):** on every track boundary, record `{track, artist, startedAt, meanArousal, deltaVsPrevTrack, onTaskFraction, distractions, userNudge?}` (attention fields from §4b). Non-music interventions (§5) append their own rows: `{kind, params, response: accepted|snoozed|ignored, arousalDelta, attentionDelta}` — one ledger, every lever's track record on *this* listener.
- Focus is reported as a proxy: low arousal + low HR variance over the last 2 min.

All thresholds are constants in one file — we will tune them on humans at the venue.

## 4b. Attention estimator

**Claim we can actually make:** "is the listener present, looking at the work, and is the work the thing they said they'd do?" Not "are they learning." Two channels, fused; no ML of our own — Presage gives raw ingredients, we do geometry and windowed stats.

### Face channel (Presage → `attention/face.ts`)

Everything below is a few lines of arithmetic over the 478-point landmark array. Indices are MediaPipe's (Presage links the same numbering chart). Run at ~10 Hz (downsample the frame-rate stream), emit features every 1 s.

| Feature | How | Reads as |
|---|---|---|
| **Presence** | landmarks arrived in the last 1 s and `stable` | absent → `AWAY`. Presage's face model gives up when the head is far off-axis, so *lost tracking is itself the strongest look-away signal*, not a failure |
| **Head yaw** | `(nose[1].x − cheek[234].x) / (cheek[454].x − cheek[234].x) − 0.5` | ∣yaw∣ > ~0.2 sustained → turned away from screen |
| **Head pitch** | `(nose[1].y − eyeline.y) / (chin[152].y − eyeline.y)` where eyeline = midpoint of outer corners `33`,`263` | pitch well above baseline (nose closer to chin) → looking down (phone / lap) |
| **Gaze** | iris centres = mean of `468–472` (R) and `473–477` (L); horizontal offset within eye box `[133→33]`, `[362→263]`; vertical within lids `[159→145]`, `[386→374]` | iris outside the calibrated on-screen box → off-screen glance. Down + pitch-down together = phone signature |
| **Blink rate** | rising edges of `blinking.detected` per 60 s | vs. own baseline: low = visual concentration, high = fatigue / disengagement |
| **Eye closure** | `blinking.detected` held > 1 s | micro-sleep → `DROWSY` |
| **Talking** | fraction of last 30 s with `talking.detected` | > 0.3 → conversation / call |
| **Stillness** | variance of landmark centroid + inter-ocular distance over 5 s | fidgeting; low variance = settled |
| **Expression** | 8-class scores | *not* in the score — logged for the report card only (persistent frustration is a "take a break" cue, not a distraction) |

**Calibration** piggybacks on the 60 s arousal calibration (§4): the UI says "look at your work"; we record median yaw/pitch, the gaze box (5th–95th percentile of iris offsets), and baseline blink rate. All later features are relative to that. Re-calibrate silently whenever the user is `FOCUSED` for 5 min (drift as they shift in the chair).

**What we do not build:** gaze-to-pixel eye tracking, head-pose via PnP, action units. The ratios above are enough for on-screen / off-screen / down.

### Screen channel (`attention/screen.ts`) — "is it the *right* work?"

Face says *whether* they're looking at the screen; the screen says *what* they're looking at. At `session:start` the user types the task ("orgo chapter 7 problem set", "reading for HIST 201").

- **Capture:** Electron `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1024, height: 640 } })` in main — a one-shot thumbnail, no stream, no recording. Also grab the frontmost app + window title (`active-win`) for a cheap pre-filter. macOS requires **Screen Recording** permission for both (System Settings → Privacy & Security); check `systemPreferences.getMediaAccessStatus('screen')` at start and prompt once.
- **Cadence:** every 30 s, **plus** immediately when the active app/window changes, **plus** when the face channel reports a refocus (they looked back — at what?). Skip the call if the window title is unchanged *and* the thumbnail's perceptual hash barely moved. Typical: 40–80 calls/hr.
- **Classify:** one Claude call, no tools, structured output. ~1.5k input tokens (image + prompt), ~60 out → **≈ $1/hr** on Opus 5 at `effort: "low"`.

```ts
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const Verdict = z.object({
  on_task: z.boolean(),
  activity: z.string(),                         // "reading a PDF about SN2 reactions", "YouTube", "iMessage"
  confidence: z.enum(["low", "medium", "high"]),
});

const res = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 256,
  output_config: { effort: "low", format: zodOutputFormat(Verdict) },
  system: SCREEN_SYSTEM_PROMPT,                 // byte-stable → cached
  messages: [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegB64 } },
    { type: "text", text: `TASK: ${session.task}\nFRONT APP: ${app} — ${title}\nIs the screen consistent with the task?` },
  ]}],
});
const verdict = res.parsed_output;              // null if parsing failed → treat as unknown, don't flip state
```

> System prompt sketch: *You judge whether a student's screen is consistent with their stated study task. Be generous about adjacent tools (a browser tab of lecture notes, a calculator, a chat with a classmate about the problem set). Be strict about entertainment, social feeds, and unrelated work. Reply in the schema only.*

**Privacy stance (say it out loud in the demo):** Presage processes video on-device and we never store frames. Screen thumbnails are the one thing that *does* leave the laptop (to the Claude API). We downscale to 1024 px, never write them to disk, show a visible "screen check" indicator, and the user can pause it with one click. Face → attention math is local.

### Fusion (`attention/fuse.ts`)

Gate on presence, then a 30 s rolling score:

```
attention = 0.40·onScreen(gaze ∧ head)  +  0.20·stillness  +  0.15·blinkNorm
          + 0.15·screenOnTask            +  0.10·(1 − talking)
```

State machine with hysteresis (no flicker in the demo):

| State | Enter when | Leave when |
|---|---|---|
| `AWAY` | no face for 10 s | face stable 3 s |
| `DISTRACTED` | attention < 0.4 for 20 s **or** gaze-down + pitch-down for 8 s (phone) | attention > 0.6 for 15 s |
| `OFF_TASK` | on-screen but 2 consecutive `on_task=false` verdicts | next `on_task=true` verdict |
| `DROWSY` | eye closure > 1 s twice in 60 s, or blink rate > 2× baseline for 2 min | back under thresholds 60 s |
| `FOCUSED` | none of the above for 15 s | — |

Emits `DISTRACTED` / `REFOCUSED` events to the DJ (§5) with the *reason* attached ("looking down for 12 s", "screen: YouTube"), so the agent's explanation can cite it.

**What it feeds:** (1) the DJ ping table; (2) `onTaskFraction` per track in the ledger — the agent learns which tracks actually kept *this* listener on task, not just calm; (3) the timeline (attention band under the HR curve) and the report card ("on task 74% · 6 look-aways · longest streak 18 min").

Honesty note: like arousal, this is a heuristic, listener-relative, tuned on us at the venue. "Looking at the right screen" ≠ "learning".

## 5. DJ agent

**Ping triggers** (one deliberation in flight at a time; duplicates dropped):

| Event | When | Interrupt allowed |
|---|---|---|
| `SESSION_START` | user hits start | — (picks opening track) |
| `TRACK_ENDING` | now-playing progress ≥ duration − 25 s and nothing queued for this boundary | no |
| `SPIKE` | estimator, see §4 | **yes** (queue + skip now) |
| `USER_NUDGE` | "Not vibing" button | yes |
| `TARGET_CHANGED` | user switches Focus→Calm etc. | yes |
| `DISTRACTED` | attention state machine (§4b) enters `DISTRACTED`/`OFF_TASK`/`DROWSY`, ≥ 90 s since last interrupt | **yes** — for target *focus* the agent may cut to something more engaging; for *calm* it may leave the music alone and just log the pattern |
| `REFOCUSED` | back to `FOCUSED` after a distraction | no — book-keeping ping: mark the current track as "pulled them back" in the ledger (may skip the LLM call entirely) |

**Intervention toolbox** — the agent picks **exactly one action tool per ping** (after ≤3 searches if it's going musical). Lightest lever that can work wins; `do_nothing` is a real decision, not a failure:

| Tool | What happens | Mechanics | Measured by |
|---|---|---|---|
| `queue_track(uri, reason, interrupt)` | next track, or cut now | Spotify §8 | arousal Δ + on-task % per track |
| `start_breathing_pacer(seconds, bpm=6)` | translucent always-on-top circle animates a breathing pace; music ducks underneath | Electron frameless overlay; auto-dismiss | **live BR converging to the pacer** — the fastest visible loop we have; HR follows |
| `suggest_break(kind, minutes, reason)` | gentle overlay card: stretch / water / walk · Accept / Snooze | overlay + timer; accept pauses music; return triggers silent recalibration (§4b) | arousal + blink rate before/after; accept rate |
| `set_dnd(on)` | macOS Focus on/off — protect flow or cut noise | `shortcuts run "Attune DND"` (pre-built Shortcut, M0-D) | distractions/hr while on |
| `duck_volume(pct, seconds)` | soften without switching tracks | `osascript -e 'set volume …'` | garnish; logged only |
| `say_nudge(text)` | one spoken line (macOS `say`) — **default off**, UI toggle | rare, playful, never scolding | reaction in attention state |
| `do_nothing(reason)` | hold everything; often pairs with `set_dnd(on)` | pure ledger/feed entry: "FLOW · 18 min streak — not touching anything" | streak length |

**State → move class** (grounding for the prompt, not hard rules):

| State (arousal × attention) | Reading | First levers |
|---|---|---|
| high × falling | wired, anxious | pacer, then calmer track |
| low × low / `DROWSY` | drowsy, bored | upbeat track with a clear onset; stand-up break if it repeats |
| ok × `DISTRACTED` / `OFF_TASK` | pulled away | track with a hook; `set_dnd(on)`; nudge only on a repeating pattern |
| moderate × `FOCUSED` | **flow** | **`do_nothing`** + protect: DND on, no boundary interrupts, stretch the current lane |

Anti-nag rate limits (the agent must never become the distraction): global 90 s interrupt cooldown (§4) · ≤1 break suggestion per 25 min · ≤1 pacer per 10 min · overlays suppressed while `AWAY`.

**Call shape** — SDK tool runner, one bounded run per ping (≤ ~4 tool rounds):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

const searchTracks = betaZodTool({
  name: "search_spotify_tracks",
  description: "Search Spotify for real, playable tracks. Returns name, artists, uri, duration, popularity.",
  inputSchema: z.object({ query: z.string(), limit: z.number().max(10).default(5) }),
  run: async (i) => JSON.stringify(await spotify.search(i.query, i.limit)),
});
const queueTrack = betaZodTool({
  name: "queue_track",
  description: "Queue the chosen track. reason is shown to the listener (≤2 sentences, cite the vitals evidence). interrupt=true skips the current track immediately.",
  inputSchema: z.object({ uri: z.string(), reason: z.string(), interrupt: z.boolean() }),
  run: async (i) => player.queue(i),   // side effect + ends the loop
});

await client.beta.messages.toolRunner({
  model: "claude-opus-5",
  max_tokens: 2048,
  output_config: { effort: "low" },          // snappy picks; raise for the report card
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",                       // auto-fallback if a request is safety-declined
  system: SYSTEM_PROMPT,                      // byte-stable → prompt-cache hits every ping
  tools: [searchTracks, ...actionTools],   // queue_track, pacer, break, dnd, duck, say, do_nothing — §5 table
  messages: [{ role: "user", content: serializeContext(session, event) }],
});
```

(Thinking is adaptive by default on Opus 5 — omit the param. Latency budget: deliberation fires at T−25 s, typical run with 1–3 searches lands in 3–8 s. On spike, the UI shows "DJ is thinking…" immediately — that's a feature.)

**Context payload per ping** (`serializeContext`), fenced blocks:

```
EVENT: SPIKE (HR 84 vs baseline 71, sustained 20s)
TARGET: focus            TASTE: "mostly instrumental ok; likes Radiohead, hates country"
NOW_PLAYING: "Track X" — Artist (2:10 / 3:40)
VITALS: baseline HR 71 / BR 13 · now HR 84 / BR 17 · arousal 0.17 (high) · trend ↑
ATTENTION: FOCUSED · on-task 82% this track · last look-away 4 min ago (phone, 14 s) · screen: "PDF: orgo ch.7"
LEDGER (this session):
  1. "Weightless" — Marconi Union · arousal 0.03 · Δ −0.06 · on-task 91%  ← worked
  2. [pacer 90 s]                  · BR 17→11 · arousal Δ −0.05 · accepted ← worked fast
  3. "Cobblestone" — Bonobo        · arousal 0.05 · Δ +0.02 · on-task 88%
  4. [break 3 min]                 · snoozed
  5. "Track X" — Artist            · arousal 0.15 · Δ +0.10 · on-task 55%  ← current, not working
CONSTRAINTS: no repeats this session; no same artist back-to-back
```

**System prompt sketch** (`prompts.ts`):

> You are the focus engine of Attune. Steer the listener toward TARGET one intervention at a time. You receive live physiology vs. their own baseline, an attention state (present / looking at the work / on the stated task, from camera + screen), and a ledger of every intervention's measured effect on both. Pick exactly **one** action tool per ping — the lightest lever that can work; when they're FOCUSED, call do_nothing and protect the streak. Weigh ledger evidence over stereotypes: if their heart rate fell during something, book more like it; if the pacer worked before, reach for it sooner. Music rules: verify tracks via search before queueing (≤3 searches, then one action); for focus, instrumental bias, steady energy, no jarring transitions; never repeat a track; avoid same-artist back-to-back. On DISTRACTED, prefer a track with a clear onset, or DND if the noise is notifications; if the ledger shows a lane that previously pulled attention back, favour it. interrupt=true only when EVENT is SPIKE / USER_NUDGE / TARGET_CHANGED / DISTRACTED. Interventions are invitations, never scolding — no guilt in reasons or nudges; the music or a quiet overlay is the nudge. reason is listener-visible: ≤2 sentences, cite the evidence, no purple prose.

Cost: ~20 pings/hr × (~3k in + ~500 out) ≈ **< $0.40/hr** on Opus 5 before cache hits. Not a factor.

## 6. UI (renderer)

```
┌──────────────────────────────────────────────────────────────────┐
│ ATTUNE      target [ Focus ▾ ]   taste ["no lyrics…"]  ● 12:34   │
├────────────────┬─────────────────────────────────────────────────┤
│  camera        │  HR 71 ▁▂▃▂▁  BR 14  CALM · FOCUSED 82% ◉scrn   │
│  preview       │  ── timeline: HR curve + track bands (§9) ──    │
│  [SIMULATED]   ├─────────────────────────────────────────────────┤
│                │  ♫ Now: "Cobblestone" — Bonobo   up next: ♪ ✓   │
├────────────────┤  DJ feed:                                       │
│ [Not vibing]   │   14:02  track ending → searched "ambient       │
│ [Stress test]  │          piano" → picked Ólafur Arnalds:        │
│ (demo controls)│          "HR settled during the last two        │
│                │          instrumentals — staying in that lane." │
└────────────────┴─────────────────────────────────────────────────┘
```

Panels: vitals tiles, **attention tile** (state + on-task % + "screen check" indicator with pause), timeline chart (HR curve, attention band, track bands), now-playing/up-next + **DND badge**, **DJ reasoning feed** (every ping: event → searches → decision + reason; `do_nothing` entries included — restraint is content), session controls, demo controls (mock mode only).

Plus two **overlay windows** owned by main (§5): the breathing pacer and the break card — frameless, always-on-top, ignore-mouse except their buttons. The overlays are the agent's hands; the dashboard is its face.

## 7. IPC contract (typed channels)

main → renderer: `vitals:sample`, `vitals:status` (calibrating | ok | low-confidence | simulated), `attention:sample` (score + features, 1 Hz), `attention:state` (AWAY | DISTRACTED | OFF_TASK | DROWSY | FOCUSED, with reason), `screen:verdict` ({on_task, activity, ts}), `screen:permission` (macOS Screen Recording status), `player:state`, `agent:event` ({phase: thinking | tool_call | decision | error, …}), `intervention:event` ({kind, phase: start | accepted | snoozed | done, params}), `dnd:state`, `ledger:update`, `session:state`
renderer → main: `session:start {target, task, tastePrompt}`, `session:stop`, `session:setTarget`, `session:setTask`, `screen:pause` / `screen:resume`, `user:nudge`, `break:response {accept | snooze}`, `demo:setMode`, `demo:stress`, `demo:attention {lookAway | phone | back}`

## 8. Spotify integration

- **Auth:** Authorization Code + **PKCE** from Electron; redirect URI `http://127.0.0.1:8888/callback` (Spotify requires the loopback *IP literal* — `localhost` is rejected). Tiny one-shot HTTP listener in main catches the code. Refresh tokens handled in `auth.ts`.
- **Scopes:** `user-read-playback-state user-modify-playback-state user-read-currently-playing user-top-read playlist-read-private user-library-read` (top artists seed the TASTE block).
- **Endpoints:** `GET /v1/me/player` (5 s poll → progress, track changes), `GET /v1/search?type=track`, `POST /v1/me/player/queue?uri=…`, `POST /v1/me/player/next`.
- **Constraints we design around:**
  - New apps (post-Nov 2024) have **no** `/recommendations`, `/audio-features`, `/audio-analysis` → the agent is the recommender. Don't waste an hour discovering this.
  - The queue **can't be cleared** via API → queue at most **one** track ahead, at T−25 s. Interrupt = queue then immediately `next`.
  - "No active device" 404s → keep the desktop Spotify app playing; on 404, UI prompts "poke play in Spotify".
  - Dev mode: **allowlist every account** (teammates + demo account, ≤25) in the dashboard on day one.
- Premium required for control — confirmed available.

## 9. Demo-moment menu (open — pick after M1)

| Feature | Effort | Impact | Notes |
|---|---|---|---|
| Live DJ reasoning feed | **S** | ★★★ | Falls out of `agent:event` almost free — likely just do it |
| Stress-spike interrupt | **S/M** | ★★★ | Detector exists (§4); the money moment: mental-math on stage → agent cuts in |
| Breathing pacer biofeedback | **S** | ★★★ | Agent launches the pacer on SPIKE → judges watch the live BR number converge to 6/min inside a minute — the fastest visible closed loop in the product |
| Flow protection (`do_nothing` + DND) | **S** | ★★☆ | Feed shows the agent choosing restraint, with a reason; DND badge flips. Cheap, and it lands the "agent, not automation" point |
| Phone / look-away interrupt | **M** | ★★★ | Judge picks up their phone → attention tile flips → agent cuts in *and says why* ("you looked down for 12 s"). Face channel only; needs face metrics live (M3) |
| Screen on-task check | **M** | ★★☆ | Alt-tab to YouTube → `OFF_TASK` in ≤ 30 s → the agent reacts. Works in mock-vitals mode too, so it survives a Presage failure |
| Session timeline chart | **M** | ★★☆ | HR curve + attention band + colored track bands; the at-a-glance proof |
| End-of-session report card | **S** | ★★☆ | One extra Opus call over the ledger (effort: high); great closer |
| TTS DJ voice drops | M | ★☆☆ | Stretch-stretch |

**3-minute demo script (draft):** pick Focus + taste note → session starts, calibrating badge, first track plays → show reasoning feed on first boundary → judge does 30 s of mental math / speed-questions → HR climbs on screen → SPIKE → agent cuts in: breathing pacer up + calmer track queued, reason cites the vitals → judge's BR visibly converges to the pacer → judge picks up phone → attention tile flips to DISTRACTED, agent nudges with a reason → judge looks back, tile recovers → timeline shows recovery → stop session → report card (on-task %, look-aways, best track). **Backup:** `VITALS=mock replay` of a real recorded session, camera preview still live, SIMULATED badge shown — narrate honestly.

## 10. Build plan

**M0 — "hello, everything" (2–3 h, fully parallel):**
- [ ] A: clone SmartSpectra `electron-quickstart`, try self-serve key at physiology.presagetech.com (free, no CC per their site) → vitals numbers on screen. No key → build `mock.ts` first, adapter later.
- [ ] B: Spotify dev app + PKCE + allowlist; read now-playing; queue one hardcoded track.
- [ ] C: Anthropic key smoke test — toolRunner with search + a couple of action tools stubbed.
- [ ] D: demo-laptop sweep — grant camera, Screen Recording, Automation now (never on stage); build the "Attune DND" Shortcut and verify `shortcuts run "Attune DND"` toggles Focus without a confirmation dialog.

**M1 — closed loop on mock vitals** ← *the MVP heartbeat; nothing else matters until this works end-to-end.* Estimator + triggers + agent + real Spotify queueing, console-grade UI.
**M2 — dashboard** (§6 panels over the IPC events).
**M3 — real vitals + face:** drop in `smartspectra.ts` with the face group requested, calibrate arousal *and* attention thresholds on humans, test venue lighting early. Verify the free tier actually returns `face.*` (§13) in the first 10 minutes.
**M3b — attention:** `face.ts` math + `fuse.ts` state machine on mock face samples first (hotkeys), then real; `screen.ts` is independent of Presage and can be built in parallel by whoever finishes M0-C.
**M4 — demo layer:** pick from §9 — suggested order: breathing pacer → flow protection → phone/look-away polish → timeline → report card (pacer first: S effort, biggest visible payoff).
**M5 — rehearse the script; record a replay session as backup.**

Cutline logic: real vitals slipping ⇒ demo runs on mock/replay (badge shown, interface on screen — "adapter is a drop-in"); everything else stays intact. The sponsor-prize angle wants real vitals, so M3 gets priority over M4 polish.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Presage key late / SDK fights arm64 Electron | Mock provider is first-class from hour one; quickstart sample validates the SDK before any product code touches it |
| Venue lighting / camera confidence low | Confidence gating + `low-confidence` UI state; test in venue light at M3; replay fallback |
| HR barely moves in a 3-min demo | Stress-induction beat in the script; thresholds tuned down for demo; replay backup |
| Spotify "no active device" mid-demo | Keep desktop app foregrounded and playing; UI prompt on 404 |
| Agent latency at a track boundary | Deliberate at T−25 s; effort low; "DJ is thinking…" state |
| Wi-Fi (Presage cloud? + Spotify + Anthropic all need net) | Phone hotspot on the demo laptop; verify whether SmartSpectra processes on-device (open question) |
| Screen capture feels creepy / macOS permission dialog mid-demo | Grant Screen Recording permission at setup, not on stage; visible indicator + pause button; downscaled, never persisted; say the privacy stance in the pitch |
| Face metrics drop out (glasses glare, judge turns to talk) | That *is* the away/distracted signal — state machine treats lost tracking as `AWAY`, not error; hysteresis stops flicker |
| The agent becomes the distraction (nag fatigue) | Anti-nag limits in §5: 90 s cooldown, ≤1 break/25 min, ≤1 pacer/10 min; `do_nothing` is the default in FOCUSED; overlays suppressed while AWAY; `say` nudges default-off |
| Over-claiming health science | Say "wellness proxy, listener-relative baseline, not medical" — Presage's HR/BR are FDA-cleared; **our arousal/attention interpretation is a heuristic and we say so** — "looking at the right screen" is not "learning" |

## 12. Not building

Accounts/multi-user, mobile, persistence beyond a session JSON, our own ML (attention is geometry + thresholds, not a trained model), gaze-to-pixel eye tracking, screen *recording* (we take throttled thumbnails, never video), medical claims, playlist generation, offline mode. Intervention flex shelf (only if hours appear): Hue/LIFX lights shifting with state, grayscale toggle for doomscroll pages, website blockers, posture coaching.

## 13. Open questions

- [ ] Presage free-tier: does it include HRV + face metrics? rate limits? (ask the sponsor table; answer changes nothing structural). Processing is **on-device** per their site — resolves the Wi-Fi question in §11 for vitals
- [ ] Face landmark frame rate through the Node SDK on an M-series laptop — enough for blink edges at 10 Hz? (M0-A)
- [ ] Screen check: does the judge's laptop have Screen Recording granted, or do we demo on ours only?
- [ ] Confirm exact `'metrics'` payload field names + `validationStatus` semantics from the quickstart run (M0-A)
- [ ] `shortcuts run` DND toggle: confirm no per-run confirmation on the demo laptop's macOS version (M0-D)
- [ ] Pacer defaults: 6 breaths/min × 90 s — right for a stage demo, or shorter?
- [ ] Team size / who takes M0-A vs M0-B vs M0-C vs M0-D
- [ ] Name: ship as Attune?
