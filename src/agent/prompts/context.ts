// Per-ping context serializer (design.md §5 payload). Lever status and
// context lines come from the integration registry, so new integrations
// show up here without touching this file. Music-specific lines
// (NOW_PLAYING, repeat rules) come from the spotify integration.

import type { DJSession } from "../../memory/session.js";
import { entryTime, type LedgerEntry, type PingEvent } from "../../types.js";
import { collectContextLines, collectLeverStatus } from "../tools/index.js";
import type { AgentDeps } from "../tools/types.js";

const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

/** One ledger entry as a human-readable row. Shared by the prompt and the console summary. */
export function formatLedgerEntry(e: LedgerEntry, current = false): string {
  switch (e.kind) {
    case "track": {
      const bits = [`"${e.track.name}" — ${e.track.artists.join(", ")}`];
      if (e.meanArousal !== undefined) bits.push(`arousal ${e.meanArousal.toFixed(2)}`);
      if (e.deltaVsPrev !== undefined) bits.push(`Δ ${signed(e.deltaVsPrev)}`);
      if (e.onTaskFraction !== undefined) bits.push(`on-task ${Math.round(e.onTaskFraction * 100)}%`);
      if (e.pulledBack) bits.push("pulled them back ✓");
      if (current) bits.push("← current");
      return bits.join(" · ");
    }
    case "pacer": {
      const bits = [`[pacer ${e.seconds}s @ ${e.bpm}/min]`];
      if (e.brAfter !== undefined) bits.push(`BR ${e.brBefore.toFixed(0)}→${e.brAfter.toFixed(0)}`);
      if (e.arousalDelta !== undefined) bits.push(`arousal Δ ${signed(e.arousalDelta)}`);
      return bits.join(" · ");
    }
    case "break":
      return `[break ${e.breakKind} ${e.minutes} min] · ${e.response}`;
    case "dnd":
      return `[dnd ${e.on ? "on" : "off"}]`;
    case "nothing":
      return `[held steady: ${e.reason}]`;
  }
}

function fmtLedger(session: DJSession): string {
  const current = session.currentTrackEntry();
  const rows = session.ledger.slice(-10).map((e, i) => `  ${i + 1}. ${formatLedgerEntry(e, e === current)}`);
  return rows.length ? rows.join("\n") : "  (empty — session just started)";
}

function fmtLastAction(session: DJSession): string {
  const last = session.ledger.at(-1); // ledger is chronological
  if (!last) return "LAST ACTION: none yet";
  const ago = Math.max(0, Math.round((Date.now() - entryTime(last)) / 1000));
  const what =
    last.kind === "track"
      ? `queued "${last.track.name}"${last.endedAt === undefined ? " (now playing)" : ""}`
      : last.kind === "pacer"
        ? `started a ${last.seconds}s pacer`
        : last.kind === "break"
          ? `suggested a ${last.breakKind} break`
          : last.kind === "dnd"
            ? `turned DND ${last.on ? "on" : "off"}`
            : `held steady (${last.reason})`;
  return `LAST ACTION: ${what} · ${ago}s ago`;
}

export function serializeContext(session: DJSession, event: PingEvent, deps: AgentDeps, interruptAllowed: boolean): string {
  const v = session.latest;
  const lines: string[] = [];

  lines.push(`EVENT: ${event.kind} — ${event.detail}`);
  lines.push(`TARGET: ${session.target}            TASK: "${session.task}"`);
  lines.push(`TASTE: "${session.taste}"`);
  if (v) {
    const cal = v.calibrated
      ? `baseline HR ${v.baselineHr.toFixed(0)} / BR ${v.baselineBr.toFixed(0)}`
      : "still calibrating baseline";
    lines.push(
      `VITALS: ${cal} · now HR ${v.hr.toFixed(0)} / BR ${v.br.toFixed(0)} · arousal ${v.arousal.toFixed(2)} (${v.band}) · trend ${session.trend()}`,
    );
  } else {
    lines.push("VITALS: no signal yet");
  }
  const onTask = session.currentOnTask();
  lines.push(
    `ATTENTION: ${session.attention}${onTask !== undefined ? ` · on-task ${Math.round(onTask * 100)}% this track` : ""} · DND ${session.dndOn ? "on" : "off"}`,
  );
  lines.push(fmtLastAction(session));
  lines.push(...collectContextLines(session, deps));
  lines.push(`LEDGER (this session):\n${fmtLedger(session)}`);
  lines.push(`AVAILABLE LEVERS: ${collectLeverStatus(session, deps).join(" · ")}`);
  lines.push(`CONSTRAINTS: interrupt allowed for this event: ${interruptAllowed ? "YES" : "NO"}`);
  return lines.join("\n");
}
