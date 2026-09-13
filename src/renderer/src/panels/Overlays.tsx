import { useEffect, useState } from "react";

interface BreakCardProps {
  card: { kind: string; minutes: number; reason: string };
  respond: (response: "accepted" | "snoozed" | "ignored") => void;
}

export function BreakCard({ card, respond }: BreakCardProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="break suggestion">
      <div className="modal">
        <div className="modal-kicker">the agent suggests a break</div>
        <div className="modal-title">
          {card.kind} · {card.minutes} min
        </div>
        <div className="modal-reason">“{card.reason}”</div>
        <div className="row">
          <button className="btn start" onClick={() => respond("accepted")}>
            Accept
          </button>
          <button className="btn" onClick={() => respond("snoozed")}>
            Snooze
          </button>
          <button className="btn ghost" onClick={() => respond("ignored")}>
            Ignore
          </button>
        </div>
      </div>
    </div>
  );
}

interface PacerProps {
  pacer: { seconds: number; bpm: number; startedAt: number };
  onDone: () => void;
}

/** a circle that expands/contracts at `bpm` breaths per minute until main says pacer:end (or the time runs out) */
export function PacerOverlay({ pacer, onDone }: PacerProps) {
  const [left, setLeft] = useState(pacer.seconds);
  useEffect(() => {
    const t = setInterval(() => {
      const remaining = Math.ceil(pacer.seconds - (Date.now() - pacer.startedAt) / 1000);
      setLeft(Math.max(0, remaining));
      if (remaining <= 0) onDone(); // local fallback; pacer:end normally arrives first
    }, 250);
    return () => clearInterval(t);
  }, [pacer, onDone]);
  const half = 30 / pacer.bpm; // alternate direction: one iteration = inhale or exhale, half a breath
  return (
    <div className="pacer-backdrop" role="dialog" aria-label="breathing pacer">
      <div className="pacer-circle" style={{ animationDuration: `${half}s` }} />
      <div className="pacer-text">
        <div className="pacer-title">breathe with the circle</div>
        <div className="pacer-sub">
          {pacer.bpm} breaths / min · {left}s left
        </div>
      </div>
    </div>
  );
}
