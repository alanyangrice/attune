import type { UIState } from "../state";
import { mmss } from "../state";

export function NowPlaying({ ui }: { ui: UIState }) {
  const p = ui.player;
  const np = p?.nowPlaying ?? null;
  const entry = np ? ui.ledger.findLast((e) => e.kind === "track" && e.track.uri === np.track.uri) : undefined;
  const reason = entry?.kind === "track" ? entry.reason : null;
  const tracks = ui.ledger.filter((e) => e.kind === "track").length;
  const pct = np ? Math.min(100, (np.positionSec / Math.max(1, np.track.durationSec)) * 100) : 0;
  return (
    <section className="panel player">
      <div className="panel-head">
        <h3>now playing</h3>
        {p && !p.available && <span className="badge low">no device</span>}
        {tracks > 0 && <span className="muted small">{tracks} track{tracks === 1 ? "" : "s"} this session</span>}
      </div>
      {np ? (
        <>
          <div className="track-name">{np.track.name}</div>
          <div className="track-artist">{np.track.artists.join(", ")}</div>
          <div className="progress" aria-hidden>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="row between muted small">
            <span>{mmss(np.positionSec)}</span>
            <span>{mmss(np.track.durationSec)}</span>
          </div>
          {reason && <div className="track-reason">“{reason}”</div>}
        </>
      ) : (
        <div className="muted">{p?.message ?? "nothing playing"}</div>
      )}
      {p?.message && np && <div className="muted small">{p.message}</div>}
    </section>
  );
}
