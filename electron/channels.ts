/**
 * Typed IPC channel contract (design.md §7).
 * Payloads here are the source of truth for main ↔ renderer.
 */

/** Emitted by spotify/player.ts on each successful poll. */
export type PlayerStatePayload = {
  progress_ms: number;
  duration_ms: number;
  is_playing: boolean;
  track_uri: string;
  track_name: string;
};

export type VitalsStatus = 'calibrating' | 'ok' | 'low-confidence' | 'simulated';

export type AttentionStateName =
  | 'AWAY'
  | 'DISTRACTED'
  | 'OFF_TASK'
  | 'DROWSY'
  | 'FOCUSED';

export type AgentEventPhase = 'thinking' | 'tool_call' | 'decision' | 'error';

export type InterventionKind =
  | 'track'
  | 'pacer'
  | 'break'
  | 'dnd'
  | 'duck'
  | 'say'
  | 'do_nothing';

/** main → renderer */
export type MainToRenderer = {
  'vitals:sample': {
    ts: number;
    hr: number;
    br: number;
    hrv?: number;
    confidence: number;
  };
  'vitals:status': VitalsStatus;
  'attention:sample': {
    score: number;
    features: Record<string, number>;
  };
  'attention:state': {
    state: AttentionStateName;
    reason?: string;
  };
  'screen:verdict': {
    on_task: boolean;
    activity: string;
    ts: number;
  };
  'screen:permission': { granted: boolean; status: string };
  'player:state': PlayerStatePayload;
  'player:no-device': { message: string };
  'player:error': { message: string };
  'agent:event': {
    phase: AgentEventPhase;
    detail?: string;
    tool?: string;
    reason?: string;
  };
  'intervention:event': {
    kind: InterventionKind;
    phase: 'start' | 'accepted' | 'snoozed' | 'done';
    params?: Record<string, unknown>;
  };
  'dnd:state': { on: boolean };
  'ledger:update': unknown;
  'session:state': {
    running: boolean;
    target?: string;
    task?: string;
  };
};

/** renderer → main (invoke) */
export type RendererToMain = {
  'session:start': {
    target: string;
    task: string;
    tastePrompt: string;
  };
  'session:stop': void;
  'session:setTarget': { target: string };
  'session:setTask': { task: string };
  'screen:pause': void;
  'screen:resume': void;
  'user:nudge': void;
  'break:response': { accept: boolean } | { snooze: boolean };
  'demo:setMode': { mode: 'scripted' | 'replay' | 'manual' };
  'demo:stress': void;
  'demo:attention': { lookAway: true } | { phone: true } | { back: true };
};

export type MainToRendererChannel = keyof MainToRenderer;
export type RendererToMainChannel = keyof RendererToMain;
