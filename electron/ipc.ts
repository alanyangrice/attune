import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron';
import type {
  MainToRenderer,
  MainToRendererChannel,
  RendererToMain,
  RendererToMainChannel,
} from './channels';
import { playerEvents, startPolling, stopPolling } from '../spotify/player';

type SessionStart = RendererToMain['session:start'];

export type SessionHandlers = {
  onStart?: (payload: SessionStart) => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onSetTarget?: (target: string) => void;
  onSetTask?: (task: string) => void;
  onNudge?: () => void;
};

let targetWindow: BrowserWindow | null = null;
let playerBridgeAttached = false;
let handlersRegistered = false;

/** Send a typed event to the bound renderer window. */
export function sendToRenderer<C extends MainToRendererChannel>(
  channel: C,
  payload: MainToRenderer[C],
): void {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  targetWindow.webContents.send(channel, payload);
}

/** Bind the BrowserWindow that should receive main→renderer pushes. */
export function setIpcWindow(win: BrowserWindow): void {
  targetWindow = win;
  win.on('closed', () => {
    if (targetWindow === win) targetWindow = null;
  });
}

/**
 * Forward spotify/player events over IPC (design.md §7 + §8 no-device UX).
 * Idempotent — safe to call once at boot.
 */
export function attachPlayerBridge(): void {
  if (playerBridgeAttached) return;
  playerBridgeAttached = true;

  playerEvents.on('state', (state) => {
    sendToRenderer('player:state', state);
  });

  playerEvents.on('no-device', (err) => {
    const message =
      typeof err === 'string'
        ? err
        : err instanceof Error
          ? err.message
          : 'No active Spotify device';
    sendToRenderer('player:no-device', {
      message: 'Poke play in Spotify',
      // keep raw detail in logs via main console
    });
    console.warn('[ipc] player:no-device', message);
  });

  playerEvents.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    sendToRenderer('player:error', { message });
    console.error('[ipc] player:error', err);
  });

  playerEvents.on('track_ending', (item) => {
    // Not in §7 channel list yet — surface via agent path later.
    console.log('[ipc] track_ending', item?.name, item?.uri);
  });
}

/**
 * Register renderer→main invoke handlers.
 * Session start/stop hook into Spotify polling by default; override via `handlers`.
 */
export function registerIpc(session: SessionHandlers = {}): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  const handle = <C extends RendererToMainChannel>(
    channel: C,
    fn: (
      event: IpcMainInvokeEvent,
      payload: RendererToMain[C],
    ) => unknown | Promise<unknown>,
  ) => {
    ipcMain.handle(channel, fn);
  };

  handle('session:start', async (_e, payload) => {
    console.log('[ipc] session:start', payload);
    await session.onStart?.(payload);
    startPolling();
    sendToRenderer('session:state', {
      running: true,
      target: payload.target,
      task: payload.task,
    });
    return { ok: true };
  });

  handle('session:stop', async () => {
    console.log('[ipc] session:stop');
    stopPolling();
    await session.onStop?.();
    sendToRenderer('session:state', { running: false });
    return { ok: true };
  });

  handle('session:setTarget', (_e, payload) => {
    session.onSetTarget?.(payload.target);
    return { ok: true };
  });

  handle('session:setTask', (_e, payload) => {
    session.onSetTask?.(payload.task);
    return { ok: true };
  });

  handle('user:nudge', () => {
    session.onNudge?.();
    return { ok: true };
  });

  // Stubs — filled when attention / demo / breaks land.
  handle('screen:pause', () => ({ ok: true }));
  handle('screen:resume', () => ({ ok: true }));
  handle('break:response', (_e, payload) => {
    console.log('[ipc] break:response', payload);
    return { ok: true };
  });
  handle('demo:setMode', (_e, payload) => {
    console.log('[ipc] demo:setMode', payload);
    return { ok: true };
  });
  handle('demo:stress', () => {
    console.log('[ipc] demo:stress');
    return { ok: true };
  });
  handle('demo:attention', (_e, payload) => {
    console.log('[ipc] demo:attention', payload);
    return { ok: true };
  });
}
