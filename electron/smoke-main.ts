/**
 * M0-B smoke harness — design.md §10
 * Auth → poll now-playing → queue one hardcoded track.
 *
 * Prerequisites:
 *   1. Spotify desktop app open (start playing something — needs an active device)
 *   2. .env with SPOTIFY_CLIENT_ID (copy from .env.example)
 *   3. Redirect URI exactly: http://127.0.0.1:8888/callback
 *   4. Your Spotify account allowlisted on the app (dev mode)
 *
 * Run: npm run smoke:spotify
 */
import path from 'path';
import { app, BrowserWindow } from 'electron';
import dotenv from 'dotenv';

// dist/electron → repo root .env
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import { authenticate } from '../spotify/auth';
import { spotifyClient } from '../spotify/client';
import { playerEvents, startPolling, stopPolling } from '../spotify/player';

/** The Weeknd — Blinding Lights (known-good URI). Override with SMOKE_TRACK_URI. */
const SMOKE_TRACK_URI =
  process.env.SMOKE_TRACK_URI || 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b';

let queued = false;

function log(tag: string, payload?: unknown) {
  const ts = new Date().toISOString().slice(11, 19);
  if (payload === undefined) console.log(`[${ts}] ${tag}`);
  else console.log(`[${ts}] ${tag}`, payload);
}

async function runSmoke() {
  const win = new BrowserWindow({
    width: 420,
    height: 200,
    title: 'Attune — Spotify smoke (M0-B)',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        `<body style="font:14px system-ui;padding:1.5rem;background:#111;color:#eee">
         <h1 style="margin:0 0 .5rem">Spotify smoke</h1>
         <p>Watch the terminal. Close this window to quit.</p>
         <p id="s">Authenticating…</p>
         <script>window.setStatus = (t) => { document.getElementById('s').textContent = t }</script>
        </body>`,
      ),
  );

  const setStatus = (t: string) => {
    win.webContents
      .executeJavaScript(`window.setStatus(${JSON.stringify(t)})`)
      .catch(() => {});
  };

  log('auth:start', 'Opening browser — log in to Spotify…');
  setStatus('Waiting for Spotify login in browser…');
  await authenticate();
  log('auth:ok');
  setStatus('Authenticated. Polling player…');

  playerEvents.on('state', async (state) => {
    log('player:state', state);
    setStatus(
      `Now: ${state.track_name} (${Math.floor(state.progress_ms / 1000)}s)`,
    );

    if (!queued) {
      queued = true;
      try {
        log('queue:start', SMOKE_TRACK_URI);
        await spotifyClient.queue(SMOKE_TRACK_URI);
        log(
          'queue:ok',
          'Queued — plays after current track (check Spotify queue)',
        );
        setStatus('Queued smoke track ✓ — see terminal');
      } catch (err) {
        log('queue:error', err);
        setStatus(
          `Queue failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        queued = false;
      }
    }
  });

  playerEvents.on('track_ending', (item) => {
    log('player:track_ending', { name: item?.name, uri: item?.uri });
  });

  playerEvents.on('no-device', (err) => {
    log('player:no-device', 'Poke play in the Spotify desktop app');
    setStatus('No active device — poke play in Spotify');
    if (err && typeof err !== 'string') log('player:no-device:detail', err);
  });

  playerEvents.on('error', (err) => {
    log('player:error', err);
  });

  startPolling();
  log('poll:start', 'Every 5s — leave Spotify playing');
}

app.whenReady().then(() => {
  runSmoke().catch((err) => {
    console.error('[smoke] fatal', err);
    app.exit(1);
  });
});

app.on('window-all-closed', () => {
  stopPolling();
  app.quit();
});
