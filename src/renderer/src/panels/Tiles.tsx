import type { SessionCommand } from "../../../core/session/events";
import type { Action, UIState } from "../state";
import { onTaskFraction } from "../state";

const fmt = (n: number | undefined | null, digits = 0) => (n === undefined || n === null || Number.isNaN(n) ? "—" : n.toFixed(digits));

/** the badge is never optional: mock data always says so (CLAUDE.md "never fake vitals silently") */
function vitalsBadge(ui: UIState): { text: string; cls: string } | null {
  const status = ui.vitalsStatus ?? (ui.session?.vitals === "mock" ? "simulated" : null);
  if (!status) return null;
  if (status === "simulated") return { text: "SIMULATED", cls: "badge sim" };
  if (status === "calibrating" || (ui.sample && !ui.sample.calibrated)) return { text: "CALIBRATING", cls: "badge calib" };
  if (status === "low-confidence") return { text: "LOW CONFIDENCE", cls: "badge low" };
  return { text: "LIVE", cls: "badge live" };
}

export function VitalsTiles({ ui }: { ui: UIState }) {
  const s = ui.sample;
  const badge = vitalsBadge(ui);
  const band = s?.calibrated ? s.band : null;
  return (
    <section className="panel vitals">
      <div className="panel-head">
        <h3>vitals</h3>
        {badge && <span className={badge.cls}>{badge.text}</span>}
      </div>
      {ui.vitalsMessage && <div className="muted small">{ui.vitalsMessage}</div>}
      <div className="tiles">
        <div className="tile">
          <div className="tile-label">HR</div>
          <div className="tile-value">
            {fmt(s?.hr)}
            <span className="unit">bpm</span>
          </div>
          <div className="tile-sub">baseline {s?.calibrated ? fmt(s.baselineHr) : "…"}</div>
        </div>
        <div className="tile">
          <div className="tile-label">BR</div>
          <div className="tile-value">
            {fmt(s?.br)}
            <span className="unit">/min</span>
          </div>
          <div className="tile-sub">baseline {s?.calibrated ? fmt(s.baselineBr) : "…"}</div>
        </div>
        <div className={`tile band band-${band ?? "none"}`}>
          <div className="tile-label">arousal</div>
          <div className="tile-value band-text">{band ? band.toUpperCase() : "—"}</div>
          <div className="tile-sub">{s?.calibrated ? `${s.arousal >= 0 ? "+" : ""}${s.arousal.toFixed(2)} vs baseline` : "establishing baseline"}</div>
        </div>
      </div>
    </section>
  );
}

interface AttentionProps {
  ui: UIState;
  now: number;
  dispatch: React.Dispatch<Action>;
  send: (cmd: SessionCommand) => void;
}

export function AttentionTile({ ui, now, dispatch, send }: AttentionProps) {
  const a = ui.attention;
  const state = a?.state ?? "UNKNOWN";
  const onTask = onTaskFraction(ui.attentionLog, now);
  const togglePause = () => {
    const paused = !ui.screenPaused;
    send({ type: paused ? "screen:pause" : "screen:resume" });
    dispatch({ type: "local:screenPaused", paused });
  };
  return (
    <section className={`panel attention attn-${state}`}>
      <div className="panel-head">
        <h3>attention</h3>
        {onTask !== null && <span className="badge neutral">on task {Math.round(onTask * 100)}%</span>}
      </div>
      <div className="attn-state">{state}</div>
      <div className="attn-reason">{a?.reason ?? "no reading yet"}</div>
      <div className="screen-row">
        <span className={`dot ${ui.screenPaused ? "paused" : ui.screen ? (ui.screen.onTask ? "on" : "off") : "idle"}`} aria-hidden />
        <span className="muted small">
          screen check:{" "}
          {ui.screenPaused
            ? "paused"
            : ui.screen
              ? `${ui.screen.onTask ? "on task" : "OFF TASK"} · ${ui.screen.activity} (${ui.screen.confidence})`
              : "no verdict yet"}
        </span>
        <button className="btn xs" onClick={togglePause}>
          {ui.screenPaused ? "resume" : "pause"}
        </button>
      </div>
    </section>
  );
}
