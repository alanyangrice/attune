# Attune — HackRice 16

Study-session agent: webcam vitals + attention (Presage SmartSpectra) → Claude deliberates → Spotify / pacer / DND / breaks.
`design.md` is the source of truth; section numbers in code comments refer to it.

## Run
- `npm run ping:fake -- --fixture=<name> --kind=<PING> [--detail=...] [--show-context]` — fire ONE ping at a fixture session and see the context, tool calls, and decision. Seconds, no keys. **Use this to iterate on prompts and tools.** Fixtures live in `src/dev/fixtures/`.
- `npm run ping -- ...` — same with real Claude (`ANTHROPIC_API_KEY` in `.env`).
- `npm run loop:fake:auto` — full closed loop with mock sensors, scripted policy, exits after ~2.5 min. Run before every commit.
- `npm run loop:fake` — interactive hotkeys (s/r/c stress, p phone, b back, n not-vibing, t target, q quit). `npm run loop` for real Claude.
- `npm run loop:vitals` — same loop on the real camera (`VITALS=real`, needs `PRESAGE_API_KEY`). `npm run vitals:smoke -- --seconds=20` prints raw camera output through the port.
- `npm run typecheck` — must be clean.

## Layout (src/) — the backend; plain Node, zero Electron imports
- `types.ts` — data contracts: events, ledger, samples, decisions.
- `ports.ts` — every boundary interface: `SpotifyPort`, `ActuatorPort`, `VitalsProvider`, `AttentionProvider`, `SessionStore`. Core code imports outside services only through here.
- `agent/` — `index.ts` (`createAgent()`, the only import for entry points) → `loop.ts` (the gate: priority, cooldowns, one deliberation in flight) → `deliberate.ts` (one bounded tool-runner call, or the fake policy) → `tools/` (one integration per file: tools + doctrine + lever status) + `prompts/` (stable system prompt, per-ping context).
- `memory/session.ts` — `DJSession`: per-session durable state; the ledger is the agent's memory. `toSnapshot()` / `fromSnapshot()` are the persistence and fixture surface.
- `adapters/` — implementations of ports: `spotify/` (stub + real behind `createSpotify()`), `actuators-console.ts`; real ones drop in beside them.
- `sensors/` — what produces samples and pings: `index.ts` (`createVitals()`, mock|real), `vitals-mock.ts`, `smartspectra.ts` (real camera, 1 Hz samples + ~10 Hz face), `estimator.ts`, `attention/face.ts` (landmarks → features; `fuse.ts` next).
- `dev/` — `ping.ts` (one-shot harness), `run-loop.ts` (full demo), `fixtures/`.

## Adding things
- **A tool / lever:** one file in `agent/tools/` default-exporting an `Integration` (tools + doctrine + `leverStatus` + optional `contextLine` / `events`). Guards go in the tool's `run`, not the prompt.
- **A sensor:** implement `VitalsProvider` or `AttentionProvider` from `ports.ts`, emit pings into `agent.handle()`.
- **A service:** implement its port in `adapters/`, wire it in the entry point. Never import an adapter from `agent/` or `memory/`.
- **A scenario to test against:** a JSON fixture in `dev/fixtures/` (timestamps in seconds since session start).

## Rules
- The model runs until it ends its own turn (hard stop: `maxIterationsPerPing`). It may compose several actions; the prompt asks for the lightest lever, usually one. Tools enforce facts (cooldowns, no repeats, interrupt permission); the prompt only describes them. Every ledger entry carries the `pingId` that produced it, so effects are attributed per ping.
- Keep `SYSTEM_PROMPT` byte-stable (prompt cache). Volatile state goes in `serializeContext`, never the system prompt.
- All thresholds live in `config.ts`; two timing profiles (`demo` / `real`).
- Never fake vitals silently: mock mode is labelled.
- Secrets only in `.env` (gitignored). See `.env.example`.
