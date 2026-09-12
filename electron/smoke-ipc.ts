/**
 * IPC smoke — auth Spotify, bridge playerEvents → renderer (design.md §7).
 *
 * Run: npm run smoke:ipc
 */
import path from 'path';
import { app, BrowserWindow } from 'electron';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import { authenticate } from '../spotify/auth';
import {
  attachPlayerBridge,
  registerIpc,
  setIpcWindow,
} from './ipc';

function log(tag: string, payload?: unknown) {
  const ts = new Date().toISOString().slice(11, 19);
  if (payload === undefined) console.log(`[${ts}] ${tag}`);
  else console.log(`[${ts}] ${tag}`, payload);
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 560,
    title: 'Attune — IPC smoke',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setIpcWindow(win);
  attachPlayerBridge();
  registerIpc({
    onStart: async (payload) => {
      log('session:start', payload);
      // Auth once per app life; polling starts inside registerIpc handler.
    },
    onStop: () => log('session:stop'),
    onNudge: () => log('user:nudge'),
  });

  // Authenticate before UI so session:start only needs to poll.
  log('auth:start');
  await authenticate();
  log('auth:ok');

  // Load HTML from source tree (not dist) so we can iterate without copying assets.
  const html = path.join(__dirname, '..', '..', 'electron', 'renderer', 'player-smoke.html');
  await win.loadFile(html);
}

app.whenReady().then(() => {
  createWindow().catch((err) => {
    console.error('[smoke:ipc] fatal', err);
    app.exit(1);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
