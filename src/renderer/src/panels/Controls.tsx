import { useEffect, useState } from "react";
import type { SessionCommand } from "../../../core/session/events";
import type { Target } from "../../../core/types";
import type { UIState } from "../state";

const DEFAULT_TASK = "orgo chapter 7 problem set";
const DEFAULT_TASTE = "mostly instrumental; likes Bonobo and film scores; no country";

interface ControlsProps {
  ui: UIState;
  send: (cmd: SessionCommand) => void;
  targets: Target[];
}

export function SessionControls({ ui, send, targets }: ControlsProps) {
  const session = ui.session;
  const running = session?.phase === "calibrating" || session?.phase === "running";
  const [target, setTarget] = useState<Target>("focus");
  const [task, setTask] = useState(DEFAULT_TASK);
  const [taste, setTaste] = useState(DEFAULT_TASTE);

  // main is the source of truth once a session exists (e.g. after a reload)
  useEffect(() => {
    if (!session) return;
    setTarget(session.target);
    if (session.task) setTask(session.task);
    if (session.taste) setTaste(session.taste);
  }, [session?.startedAt, session?.target]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickTarget = (t: Target) => {
    setTarget(t);
    if (running) send({ type: "session:setTarget", target: t });
  };
  const commitTask = () => {
    if (running && task !== session?.task) send({ type: "session:setTask", task });
  };

  return (
    <section className="panel controls">
      <div className="seg" role="radiogroup" aria-label="target">
        {targets.map((t) => (
          <button key={t} className={`seg-btn ${target === t ? "on" : ""}`} onClick={() => pickTarget(t)} aria-pressed={target === t}>
            {t}
          </button>
        ))}
      </div>
      <label className="field">
        <span>task</span>
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onBlur={commitTask}
          onKeyDown={(e) => e.key === "Enter" && commitTask()}
          placeholder="what are you working on?"
        />
      </label>
      <label className="field">
        <span>taste</span>
        <input value={taste} onChange={(e) => setTaste(e.target.value)} disabled={running} placeholder="what should the agent know?" />
      </label>
      <div className="row">
        {running ? (
          <button className="btn stop" onClick={() => send({ type: "session:stop" })}>
            Stop session
          </button>
        ) : (
          <button className="btn start" disabled={!ui.connected} onClick={() => send({ type: "session:start", target, task, taste })}>
            Start session
          </button>
        )}
      </div>
      <button className="btn nudge" disabled={!running} onClick={() => send({ type: "user:nudge" })} title="tell the agent this isn't working">
        Not vibing
      </button>
    </section>
  );
}

export function DemoControls({ send, running }: { send: (cmd: SessionCommand) => void; running: boolean }) {
  return (
    <section className="panel demo">
      <h3>
        demo controls <span className="muted">(mock sensors only)</span>
      </h3>
      <div className="row label-row">
        <span className="muted">stress</span>
        <button className="btn sm" disabled={!running} onClick={() => send({ type: "demo:stress", level: "calm" })}>
          calm
        </button>
        <button className="btn sm" disabled={!running} onClick={() => send({ type: "demo:stress", level: "rising" })}>
          rising
        </button>
        <button className="btn sm hot" disabled={!running} onClick={() => send({ type: "demo:stress", level: "spike" })}>
          spike
        </button>
      </div>
      <div className="row label-row">
        <span className="muted">attention</span>
        <button
          className="btn sm"
          disabled={!running}
          onClick={() => send({ type: "demo:attention", state: "DISTRACTED", reason: "looking down 12s (phone signature)" })}
        >
          phone
        </button>
        <button className="btn sm" disabled={!running} onClick={() => send({ type: "demo:attention", state: "DROWSY" })}>
          drowsy
        </button>
        <button className="btn sm" disabled={!running} onClick={() => send({ type: "demo:attention", state: "AWAY" })}>
          away
        </button>
        <button className="btn sm good" disabled={!running} onClick={() => send({ type: "demo:attention", state: "FOCUSED", reason: "back on task" })}>
          back
        </button>
      </div>
    </section>
  );
}
