# `spotify/` — playback control for Attune

This module gives the Attune main process control over the listener's desktop
Spotify app: OAuth login, a thin API wrapper, and a poll loop that turns
Spotify's player state into events the rest of the app (state estimator,
agent, UI) can react to.

Design reference: `design.md`, §8 "Spotify integration" (and the
`queue_track` tool in §5) for the product rationale behind the choices below.

## Why this exists

Attune's agent doesn't generate audio or manage a queue of its own — it
drives the listener's **real, already-open, Premium Spotify desktop app**
over the Web API. That's the cheapest path to real sound on a laptop during
a live demo, and it means the "instrument" the DJ agent plays is an app the
listener already trusts.

## Files

| File | Responsibility |
|---|---|
| `auth.ts` | Authorization Code + PKCE login flow, one-shot loopback callback server, token exchange |
| `client.ts` | Thin authenticated `fetch` wrapper + the four Spotify endpoints Attune uses |
| `player.ts` | 5 s poll loop over player state, emits `PlayerState` and `track_ending` events |

Nothing here talks to Electron's renderer directly — `ipc.ts` (outside this
folder) is expected to relay `playerEvents` out over IPC and to call
`spotifyClient` methods on behalf of the agent's tools.

## `auth.ts` — Authorization Code + PKCE

```ts
export async function authenticate(): Promise<void>
export async function refreshAccessToken(): Promise<void>
export async function ensureAccessToken(): Promise<string>
export function getAccessToken(): string
```

- Generates a PKCE `code_verifier` / `code_challenge` pair (`crypto`,
  `S256`), opens the Spotify authorize URL in the system browser
  (`shell.openExternal`), and spins up a **one-shot** `http` server on
  `127.0.0.1:8888` to catch the redirect.
- **Redirect URI is `http://127.0.0.1:8888/callback` — an IP literal, not
  `localhost`.** Spotify rejects `localhost` redirect URIs; this must match
  exactly what's registered in the Spotify Developer Dashboard for the app.
- Scopes requested: `user-read-playback-state`, `user-modify-playback-state`,
  `user-read-currently-playing`, `user-top-read`, `playlist-read-private`,
  `user-library-read`. (`user-top-read` exists so the TASTE block in the
  agent's context can be seeded from the listener's actual top artists —
  see design.md §5.)
- `exchangeToken` posts the code + verifier to `/api/token` and stores
  `accessToken` / `refreshToken` in module-level variables.

### Token refresh

`refreshAccessToken()` POSTs `grant_type=refresh_token`. `ensureAccessToken()`
refreshes ~60 s before expiry and is what `fetchSpotify` calls; `getAccessToken()`
remains a sync peek of the current token.

## `client.ts` — API wrapper

```ts
spotifyClient.search(query, limit = 5)   // GET /v1/search?type=track
spotifyClient.queue(uri)                 // POST /v1/me/player/queue
spotifyClient.next()                     // POST /v1/me/player/next
spotifyClient.interrupt(uri, reason?)    // queue + next (design.md §5 interrupt)
spotifyClient.getPlayerState()           // GET /v1/me/player
spotifyClient.getTopArtists(limit = 10)  // GET /v1/me/top/artists → TASTE seed
```

All requests go through `fetchSpotify`, which attaches
`Authorization: Bearer <accessToken>` (via `ensureAccessToken`) and throws on
non-2xx responses. `GET /me/player` → `204`/`404` become `NoActiveDeviceError`.
`POST` queue/next → `204` is success (empty body).

### Constraints this wrapper is designed around (see design.md §8)

- Spotify killed `/recommendations`, `/audio-features`, and
  `/audio-analysis` for apps created after Nov 2024 — there is deliberately
  no recommendation call here. Track selection is the agent's job; this
  client only **verifies** picks exist via `search`.
- The queue **cannot be cleared** through the API. The intended usage
  pattern is: queue at most one track ahead (at T−25 s before the current
  track ends), and if the agent needs to interrupt immediately, call
  `interrupt(uri)` (queue then `next()`).
- No active device → `NoActiveDeviceError`. `player.ts` emits `'no-device'`
  so the UI can prompt "poke play in Spotify" instead of a hard error.
- Requires Spotify **Premium** on the account being controlled.
- In dev mode, every account that will touch the demo (teammates + the demo
  account, ≤25 total) must be added to the Spotify app's allowlist in the
  Developer Dashboard, or auth will fail for them.

## `player.ts` — poll loop

```ts
export const playerEvents: EventEmitter
export function startPolling(): void
export function stopPolling(): void
```

Polls `getPlayerState()` every 5 s and emits:

- `'state'` — `{ progress_ms, duration_ms, is_playing, track_uri, track_name }`,
  once per poll while a track is active.
- `'track_ending'` — fired **once per track** when playback is within 25 s of
  the end (`duration_ms - progress_ms <= 25000`) and `is_playing` is true.
  Re-arms when the track URI changes. This is the trigger the agent's ping
  loop listens for to decide the next track (design.md §1, §5).
- `'no-device'` — no active device/track (`!state.item` or `NoActiveDeviceError`).
  Wire the UI to "poke play in Spotify".
- `'error'` — other fetch / API failures.

`startPolling` / `stopPolling` are idempotent guards around a single
`setInterval`; nothing here is scoped to a session, so call `stopPolling()`
when a `DJSession` ends to avoid a dangling timer.

## Environment / setup

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add `http://127.0.0.1:8888/callback` as a Redirect URI on that app —
   exactly, IP literal, no trailing slash mismatch.
3. Copy `.env.example` → `.env` and set `SPOTIFY_CLIENT_ID` (no client
   secret — PKCE doesn't use one).
4. In dev mode, add every account that will authenticate (teammates, the
   demo account) under the app's user allowlist.
5. Have the desktop Spotify app open and logged in on the machine before
   calling `authenticate()` — control only works while it's the active
   device.

## M0-B smoke test

```bash
cp .env.example .env   # then paste Client ID
npm install
npm run smoke:spotify
```

Opens a browser for PKCE login, polls now-playing every 5 s, and queues one
hardcoded track (`SMOKE_TRACK_URI`, default Blinding Lights). Watch the
terminal for `player:state` / `queue:ok` / `player:no-device`.

## Suggested next steps for this branch

- [x] Implement `refreshAccessToken()` / `ensureAccessToken()` and wire into
      `fetchSpotify`.
- [x] Special-case 204/404 "no active device" → `NoActiveDeviceError` +
      `'no-device'` event.
- [x] Add `interrupt(uri, reason?)` (queue then next).
- [x] Add `getTopArtists()` for TASTE seeding.
- [x] M0-B Electron smoke harness (`electron/smoke-main.ts`, `npm run smoke:spotify`).
- [x] Agent music tools + M0-C smoke (`agent/tools.ts`, `npm run smoke:agent`).
- [x] Typed `ipc.ts` + preload + player UI smoke (`npm run smoke:ipc`).
- [ ] Persist tokens across main-process restarts if demos need re-auth-free
      relaunches (in-memory is fine for a single session).
- [ ] Mock vitals + estimator → ping agent on `track_ending` (M1).
