// Per-ping context serializer (design.md §5 payload). Lever status and
// extra context lines come from the integration registry, so new
// integrations show up here without touching this file.

import { collectContextLines, collectLeverStatus } from "../tools/index.js";
import type { DJSession } from "../../memory/session.js";
import type { LedgerEntry, PingEvent } from "../../types.js";
import type { SpotifyPort } from "../../ports.js";

function fmtTrackRow(e: Extract<LedgerEntry, { kind: "track" }>, current: boolean): string {
  const bits = [`"${e.track.name}" — ${e.track.artists.join(", ")}`];
  if (e.meanArousal !== undefined) bits.push(`arousal ${e.meanArousal.toFixed(2)}`);
  if (e.deltaVsPrev !== undefined) bits.push(`Δ ${e.deltaVsPrev >= 0 ? "+" : ""}${e.deltaVsPrev.toFixed(2)}`);
  if (e.onTaskFraction !== undefined) bits.push(`on-task ${Math.round(e.onTaskFraction * 100)}%`);
  if (e.pulledBack) bits.push("pulled them back ✓");
  if (current) bits.push("← current");
  return bits.join(" · ");
}

function fmtLedger(session: DJSession): string {
  const rows = session.ledger.slice(-10).map((e) => {
    switch (e.kind) {
      case "track":
        return fmtTrackRow(e, e === session.currentTrackEntry());
      case "pacer": {
        const bits = [`[pacer ${e.seconds}s @ ${e.bpm}/min]`];
        if (e.brAfter !== undefined) bits.push(`BR ${e.brBefore.toFixed(0)}→${e.brAfter.toFixed(0)}`);
        if (e.arousalDelta !== undefined)
          bits.push(`arousal Δ ${e.arousalDelta >= 0 ? "+" : ""}${e.arousalDelta.toFixed(2)}`);
        return bits.join(" · ");
      }
      case "break":
        return `[break ${e.breakKind} ${e.minutes} min] · ${e.response}`;
      case "dnd":
        return `[dnd ${e.on ? "on" : "off"}]`;
      case "nothing":
        return `[held steady: ${e.reason}]`;
    }
  });
  return rows.length ? rows.map((r, i) => `  ${i + 1}. ${r}`).join("\n") : "  (empty — session just started)";
}

function fmtLastAction(session: DJSession): string {
  const stamp = (e: LedgerEntry) => ("startedAt" in e ? e.startedAt : e.at);
  const last = session.ledger.reduce<LedgerEntry | null>((best, e) => (!best || stamp(e) > stamp(best) ? e : best), null);
  if (!last) return "LAST ACTION: none yet";
  const at = stamp(last);
  const ago = Math.max(0, Math.round((Date.now() - at) / 1000));
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

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function serializeContext(
  session: DJSession,
  event: PingEvent,
  spotify: SpotifyPort,
  interruptAllowed: boolean,
): string {
  const v = session.latest;
  const np = spotify.nowPlaying();
  const lines: string[] = [];

  lines.push(`EVENT: ${event.kind} — ${event.detail}`);
  lines.push(`TARGET: ${session.target}            TASK: "${session.task}"`);
  lines.push(`TASTE: "${session.taste}"`);
  lines.push(
    np
      ? `NOW_PLAYING: "${np.track.name}" — ${np.track.artists.join(", ")} (${mmss(np.positionSec)} / ${mmss(np.track.durationSec)})`
      : "NOW_PLAYING: nothing yet",
  );
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
  for (const line of collectContextLines(session)) lines.push(line);
  lines.push(`LEDGER (this session):\n${fmtLedger(session)}`);
  lines.push(`AVAILABLE LEVERS: ${collectLeverStatus(session).join(" · ")}`);

  const lastArtists = session.lastArtists();
  lines.push(
    `CONSTRAINTS: no repeats this session; avoid same artist back-to-back${lastArtists.length ? ` (last: ${lastArtists.join(", ")})` : ""}; interrupt allowed for this event: ${interruptAllowed ? "YES" : "NO"}`,
  );
  return lines.join("\n");
}
