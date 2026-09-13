// A single-series strip: arousal (vs. baseline) over the last 10 minutes,
// with the agent's tracks and pacers laid under it as faint bands. One
// series, so no legend; the band labels are text, not just color.

import { HISTORY_MS, type UIState } from "../state";

const W = 1000;
const H = 96;
const PAD = { l: 8, r: 8, t: 10, b: 18 };
const Y_MIN = -0.2;
const Y_MAX = 0.4;
// arousal bands from config.ts (calmBelow / highAtOrAbove) — mirrored here for the guide lines only
const ELEVATED_AT = 0.05;
const HIGH_AT = 0.15;

export function Timeline({ ui, now }: { ui: UIState; now: number }) {
  const start = now - HISTORY_MS;
  const x = (ts: number) => PAD.l + ((ts - start) / HISTORY_MS) * (W - PAD.l - PAD.r);
  const y = (v: number) => {
    const c = Math.max(Y_MIN, Math.min(Y_MAX, v));
    return PAD.t + (1 - (c - Y_MIN) / (Y_MAX - Y_MIN)) * (H - PAD.t - PAD.b);
  };
  const pts = ui.history.filter((s) => s.calibrated && s.ts >= start);
  const path = pts.map((s, i) => `${i ? "L" : "M"}${x(s.ts).toFixed(1)},${y(s.arousal).toFixed(1)}`).join(" ");

  const tracks = ui.ledger.filter((e) => e.kind === "track");
  const pacers = ui.ledger.filter((e) => e.kind === "pacer");

  return (
    <section className="panel timeline">
      <div className="panel-head">
        <h3>last 10 minutes · arousal vs. baseline</h3>
        <span className="muted small">{pts.length ? `${pts.length} samples` : "no calibrated samples yet"}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="tl-svg" aria-label="arousal timeline">
        {tracks.map((t, i) => {
          if (t.kind !== "track") return null;
          const x0 = Math.max(PAD.l, x(t.startedAt));
          const x1 = Math.min(W - PAD.r, x(t.endedAt ?? now));
          if (x1 <= x0) return null;
          return <rect key={`t${i}`} x={x0} y={PAD.t} width={x1 - x0} height={H - PAD.t - PAD.b} className={`tl-track ${i % 2 ? "b" : "a"}`} />;
        })}
        {pacers.map((p, i) => {
          if (p.kind !== "pacer") return null;
          const x0 = Math.max(PAD.l, x(p.startedAt));
          const x1 = Math.min(W - PAD.r, x(p.startedAt + p.seconds * 1000));
          if (x1 <= x0) return null;
          return <rect key={`p${i}`} x={x0} y={PAD.t} width={x1 - x0} height={H - PAD.t - PAD.b} className="tl-pacer" />;
        })}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} className="tl-zero" />
        <line x1={PAD.l} x2={W - PAD.r} y1={y(ELEVATED_AT)} y2={y(ELEVATED_AT)} className="tl-guide" />
        <line x1={PAD.l} x2={W - PAD.r} y1={y(HIGH_AT)} y2={y(HIGH_AT)} className="tl-guide" />
        <text x={W - PAD.r - 4} y={y(ELEVATED_AT) - 3} className="tl-label">
          elevated
        </text>
        <text x={W - PAD.r - 4} y={y(HIGH_AT) - 3} className="tl-label">
          high
        </text>
        {path && <path d={path} className="tl-line" vectorEffect="non-scaling-stroke" />}
        {pts.length > 0 && (
          <circle cx={x(pts[pts.length - 1]!.ts)} cy={y(pts[pts.length - 1]!.arousal)} r={4} className="tl-now" vectorEffect="non-scaling-stroke" />
        )}
        <text x={PAD.l} y={H - 4} className="tl-label left">
          −10 min
        </text>
        <text x={W - PAD.r - 4} y={H - 4} className="tl-label">
          now
        </text>
      </svg>
      <div className="tl-legend muted small">
        <span className="swatch track" /> tracks <span className="swatch pacer" /> pacer
      </div>
    </section>
  );
}
