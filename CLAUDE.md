# Attune — HackRice 16

Study-session agent: webcam vitals + attention (Presage SmartSpectra) → Claude deliberates → Spotify / pacer / DND / breaks.
`design.md` is the source of truth; section numbers in code comments refer to it.

## Run
- `npm run loop:fake:auto` — full closed loop, scripted policy, no keys, exits after ~2.5 min. Run this before every commit.
- `npm run loop:fake` — same, interactive hotkeys (s/r/c stress, p phone, b back, n not-vibing, t target, q quit).
- `npm run loop` — real Claude (`claude-opus-5` via `@anthropic-ai/sdk` tool runner). Needs `ANTHROPIC_API_KEY` in `.env`.
- `npm run typecheck` — must be clean.

## Layout (electron/)
- `types.ts` — every contract (ports, ping events, ledger). Change here first, then implementations.
- `agent/` — `index.ts` (`createAgent()`, the only thing entry points import) → `loop.ts` (the gate: priority, cooldowns, one deliberation in flight) → `deliberate.ts` (one bounded tool-runner call, or the fake policy) → `tools/` (one integration per file: tools + doctrine + lever status) + `prompts/` (stable system prompt, per-ping context).
- `state/` — `estimator.ts` (arousal vs. baseline, SPIKE), `session.ts` (durable per-session state; the ledger is the agent's memory).
- `vitals/mock.ts`, `spotify/stub.ts`, `interventions/stub.ts` — first-class stand-ins behind the ports; real adapters drop in without touching the loop.
- `dev/run-loop.ts` — console harness; the Electron renderer replaces it at M2.

## Rules
- The agent takes exactly one action tool per ping; tools enforce cooldowns/no-repeats, the prompt only describes them.
- Keep `SYSTEM_PROMPT` byte-stable (prompt cache). Volatile state goes in `serializeContext`, never the system prompt.
- All thresholds live in `config.ts`; two timing profiles (`demo` / `real`).
- Never fake vitals silently: mock mode is labelled.
- Secrets only in `.env` (gitignored). See `.env.example`.
