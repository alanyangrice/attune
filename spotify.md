# `src/adapters/spotify/` — real desktop Spotify behind `SpotifyPort`

Implements WORKPLAN lane 3 / design.md §8. The agent core only sees
`SpotifyPort` (`search`, `queue`, `nowPlaying`, `hasQueued`). Stub and real
adapters both emit `trackchange` / `ending` so `src/dev/run-loop.ts` can swap
them with `SPOTIFY=stub|real`.

## Layout

| File | Role |
|---|---|
| `auth.ts` | Authorization Code + PKCE, loopback `127.0.0.1:8888/callback`, refresh |
| `client.ts` | search / queue / next / player / top artists |
| `real.ts` | `RealSpotify` — 5 s poll → events + `SpotifyPort` |
| `stub.ts` | Canned catalog + fake player (default) |
| `index.ts` | `createSpotify()` factory |

## Run

```bash
# stub (default) — no Spotify account needed
npm run loop:fake

# real desktop Spotify (Premium, app playing, SPOTIFY_CLIENT_ID in .env)
npm run loop:real:fake    # scripted LLM + real music
npm run loop:real         # real Claude + real music
```

Redirect URI must be exactly `http://127.0.0.1:8888/callback`. Dev-mode
allowlist every account that will log in.

## Notes

- No `/recommendations` / audio-features — agent picks tracks.
- Interrupt = `queue` then `next`. `hasQueued()` gates TRACK_ENDING pings.
- `no-device` event → harness prints “Poke play in Spotify”.
- Electron IPC (lane 7) should import `createSpotify` the same way the console harness does — do not fork a second client.
