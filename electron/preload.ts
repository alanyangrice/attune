import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { MainToRenderer, RendererToMain } from './channels';

type Unsub = () => void;

function on<C extends keyof MainToRenderer>(
  channel: C,
  listener: (payload: MainToRenderer[C]) => void,
): Unsub {
  const handler = (_event: IpcRendererEvent, payload: MainToRenderer[C]) => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

async function invoke<C extends keyof RendererToMain>(
  channel: C,
  ...args: RendererToMain[C] extends void ? [] : [RendererToMain[C]]
): Promise<unknown> {
  return ipcRenderer.invoke(channel, ...args);
}

export type AttuneApi = {
  onPlayerState: (
    cb: (payload: MainToRenderer['player:state']) => void,
  ) => Unsub;
  onPlayerNoDevice: (
    cb: (payload: MainToRenderer['player:no-device']) => void,
  ) => Unsub;
  onPlayerError: (
    cb: (payload: MainToRenderer['player:error']) => void,
  ) => Unsub;
  onSessionState: (
    cb: (payload: MainToRenderer['session:state']) => void,
  ) => Unsub;
  onAgentEvent: (
    cb: (payload: MainToRenderer['agent:event']) => void,
  ) => Unsub;
  startSession: (payload: RendererToMain['session:start']) => Promise<unknown>;
  stopSession: () => Promise<unknown>;
  nudge: () => Promise<unknown>;
};

const api: AttuneApi = {
  onPlayerState: (cb) => on('player:state', cb),
  onPlayerNoDevice: (cb) => on('player:no-device', cb),
  onPlayerError: (cb) => on('player:error', cb),
  onSessionState: (cb) => on('session:state', cb),
  onAgentEvent: (cb) => on('agent:event', cb),
  startSession: (payload) => invoke('session:start', payload),
  stopSession: () => invoke('session:stop'),
  nudge: () => invoke('user:nudge'),
};

contextBridge.exposeInMainWorld('attune', api);
