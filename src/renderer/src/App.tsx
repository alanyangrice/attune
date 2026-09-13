// The dashboard (design.md §6). Thin: every panel reads UIState and sends
// SessionCommands; nothing here decides anything.

import { useEffect, useRef, useState } from "react";
import type { Target } from "../../core/types";
import { AgentLog } from "./panels/AgentLog";
import { AttentionTile, VitalsTiles } from "./panels/Tiles";
import { NowPlaying } from "./panels/NowPlaying";
import { DemoControls, SessionControls } from "./panels/Controls";
import { BreakCard, PacerOverlay } from "./panels/Overlays";
import { Timeline } from "./panels/Timeline";
import { mmss, useSession } from "./state";

const TARGETS: Target[] = ["focus", "calm", "energize"];

export function App() {
  const [ui, dispatch, send] = useSession();
  const session = ui.session;
  const running = session?.phase === "calibrating" || session?.phase === "running";

  // 1 Hz clock for the elapsed timer / on-task % while a session runs
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const dnd = ui.ledger.findLast((e) => e.kind === "dnd");
  const latestWarning = ui.warnings[ui.warnings.length - 1];
  const warningFresh = latestWarning && now - latestWarning.ts < 8000;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          ATTUNE
          <span className="tagline">the agent that watches you work</span>
        </div>
        <div className="phase-block">
          <span className={`pill phase-${session?.phase ?? "idle"}`}>{session?.phase ?? "connecting"}</span>
          <span className="elapsed">{session?.startedAt && running ? mmss((now - session.startedAt) / 1000) : "--:--"}</span>
        </div>
        <div className="modes">
          {session && (
            <span className={`pill mode ${session.vitals === "mock" ? "warn" : "ok"}`}>
              vitals: {session.vitals === "mock" ? "SIMULATED" : "camera"}
            </span>
          )}
          {session && <span className={`pill mode ${session.spotify === "stub" ? "warn" : "ok"}`}>spotify: {session.spotify}</span>}
          {dnd?.kind === "dnd" && dnd.on && <span className="pill dnd">DND on</span>}
          {!ui.connected && <span className="pill danger">not in Electron</span>}
        </div>
      </header>

      <main className="layout">
        <aside className="left">
          <SessionControls ui={ui} send={send} targets={TARGETS} />
          <VitalsTiles ui={ui} />
          <AttentionTile ui={ui} now={now} dispatch={dispatch} send={send} />
          <NowPlaying ui={ui} />
          {session?.vitals === "mock" && <DemoControls send={send} running={running} />}
        </aside>
        <section className="right">
          <Timeline ui={ui} now={now} />
          <AgentLog feed={ui.feed} startedAt={session?.startedAt ?? null} />
        </section>
      </main>

      {warningFresh && latestWarning && (
        <div className="toast">
          <span className="toast-source">{latestWarning.source}</span> {latestWarning.message}
        </div>
      )}

      {ui.breakCard && (
        <BreakCard
          card={ui.breakCard}
          respond={(response) => {
            send({ type: "break:respond", response });
            dispatch({ type: "local:dismissBreak" });
          }}
        />
      )}
      {ui.pacer && <PacerOverlay pacer={ui.pacer} onDone={() => dispatch({ type: "local:pacerDone" })} />}
    </div>
  );
}
