// Agent log — the star of the demo (design.md §9): every FeedEvent, newest at the
// bottom, phases styled so a judge can read ping → search → decision.

import { useEffect, useRef, useState } from "react";
import type { FeedEvent } from "../../../core/types";
import { clockOf } from "../state";

const GLYPH: Record<FeedEvent["phase"], string> = {
  ping: "●",
  thinking: "…",
  tool: "⌕",
  decision: "▶",
  skip: "○",
  error: "✗",
  info: "·",
};

export function AgentLog({ feed, startedAt }: { feed: FeedEvent[]; startedAt: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true); // follow the newest line unless the user scrolled up

  useEffect(() => {
    if (pinned && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [feed.length, pinned]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  return (
    <section className="panel feed">
      <div className="panel-head">
        <h3>Agent log</h3>
        <span className="muted small">{feed.length ? `${feed.length} lines` : "waiting for the first ping"}</span>
        {!pinned && (
          <button className="btn xs" onClick={() => setPinned(true)}>
            jump to latest
          </button>
        )}
      </div>
      <div className="feed-scroll" ref={box} onScroll={onScroll}>
        {feed.length === 0 && (
          <div className="feed-empty">
            Start a session. Every ping the agent gets — track ending, stress spike, look-away, your “Not vibing” — shows up here with
            its searches, its decision, and the reason it gives you.
          </div>
        )}
        {feed.map((e, i) => (
          <div key={i} className={`line ${e.phase}`}>
            <span className="ts">{clockOf(e.ts, startedAt)}</span>
            <span className="glyph" aria-hidden>
              {GLYPH[e.phase]}
            </span>
            <span className="text">{e.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
