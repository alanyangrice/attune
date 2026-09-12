/**
 * M0-C smoke — Anthropic toolRunner + real Spotify search/queue (design.md §10).
 *
 * Prerequisites:
 *   1. Same Spotify setup as smoke:spotify (.env SPOTIFY_CLIENT_ID, desktop playing)
 *   2. ANTHROPIC_API_KEY in .env
 *
 * Run: npm run smoke:agent
 */
import path from 'path';
import { app, BrowserWindow } from 'electron';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import { authenticate } from '../spotify/auth';
import { spotifyClient } from '../spotify/client';
import { playerEvents, startPolling, stopPolling } from '../spotify/player';
import { musicTools } from '../agent/tools';
import { DJ_SYSTEM_PROMPT } from '../agent/prompts';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

function log(tag: string, payload?: unknown) {
  const ts = new Date().toISOString().slice(11, 19);
  if (payload === undefined) console.log(`[${ts}] ${tag}`);
  else console.log(`[${ts}] ${tag}`, payload);
}

function formatNowPlaying(state: {
  track_name: string;
  progress_ms: number;
  duration_ms: number;
}): string {
  const cur = Math.floor(state.progress_ms / 1000);
  const tot = Math.floor(state.duration_ms / 1000);
  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `"${state.track_name}" (${fmt(cur)} / ${fmt(tot)})`;
}

async function deliberate(nowPlaying: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set (add it to .env)');
  }

  const client = new Anthropic({ apiKey });

  // Fake SESSION_START context — enough for M0-C without vitals/estimator.
  const userContent = `EVENT: SESSION_START
TARGET: focus
TASTE: mostly instrumental ok; likes ambient / downtempo; no country
NOW_PLAYING: ${nowPlaying}
VITALS: (mock) baseline HR 71 / BR 13 · now HR 72 / BR 13 · arousal 0.02 (calm)
ATTENTION: FOCUSED · on-task 80%
LEDGER (this session): (empty — opening track)
CONSTRAINTS: no repeats this session; verify via search before queueing

Pick an opening focus track. Search ≤3 times, then call queue_track once with interrupt=false and a short reason.`;

  log('agent:start', { model: MODEL });

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 2048,
    max_iterations: 6,
    system: DJ_SYSTEM_PROMPT,
    tools: musicTools,
    messages: [{ role: 'user', content: userContent }],
  });

  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === 'text') {
        log('agent:text', block.text);
      } else if (block.type === 'tool_use') {
        log('agent:tool_use', { name: block.name, input: block.input });
      }
    }
  }

  const final = await runner;
  log('agent:done', final.content);
  return final;
}

async function runSmoke() {
  const win = new BrowserWindow({
    width: 440,
    height: 220,
    title: 'Attune — Agent smoke (M0-C)',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        `<body style="font:14px system-ui;padding:1.5rem;background:#111;color:#eee">
         <h1 style="margin:0 0 .5rem">Agent + Spotify smoke</h1>
         <p>Watch the terminal. Close to quit.</p>
         <p id="s">Starting…</p>
         <script>window.setStatus = (t) => { document.getElementById('s').textContent = t }</script>
        </body>`,
      ),
  );
  const setStatus = (t: string) => {
    win.webContents
      .executeJavaScript(`window.setStatus(${JSON.stringify(t)})`)
      .catch(() => {});
  };

  log('auth:start');
  setStatus('Spotify login…');
  await authenticate();
  log('auth:ok');

  // One player snapshot so the agent has NOW_PLAYING (and we know a device is live).
  setStatus('Reading now-playing…');
  let nowPlaying = '(unknown — no active track)';
  try {
    const state = await spotifyClient.getPlayerState();
    if (state?.item) {
      nowPlaying = `"${state.item.name}" — ${state.item.artists
        ?.map((a: { name: string }) => a.name)
        .join(', ')} (${Math.floor(state.progress_ms / 1000)}s)`;
      log('player:snapshot', nowPlaying);
    } else {
      log('player:no-device', 'Poke play in Spotify, then re-run');
      setStatus('No active device — poke play in Spotify');
      return;
    }
  } catch (err) {
    log('player:error', err);
    setStatus('Player read failed — is Spotify playing?');
    return;
  }

  startPolling();
  playerEvents.on('state', (s) => log('player:state', formatNowPlaying(s)));
  playerEvents.on('no-device', () =>
    log('player:no-device', 'Poke play in Spotify'),
  );
  playerEvents.on('error', (e) => log('player:error', e));

  setStatus('Claude deliberating…');
  await deliberate(nowPlaying);
  setStatus('Done — check terminal + Spotify queue');
  log('smoke:ok', 'If queue_track ran, the track is in Spotify’s queue');
}

app.whenReady().then(() => {
  runSmoke().catch((err) => {
    console.error('[smoke:agent] fatal', err);
    app.exit(1);
  });
});

app.on('window-all-closed', () => {
  stopPolling();
  app.quit();
});
