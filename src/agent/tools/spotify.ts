// Music integration: the backbone lever (search is info, queue is the action).
// Also the sensor role for the player: it turns the port's trackchange /
// ending events into ledger updates and TRACK_ENDING pings, so entry points
// never wire the player themselves.

import { z } from "zod";
import { CONFIG } from "../../config.js";
import { errMsg, mmss } from "../../util.js";
import { decide, defineTool, type Integration, type PingRuntime } from "./types.js";

const UNAVAILABLE = "Music is unavailable right now (no active Spotify device) — use a non-music lever if one fits, or do_nothing.";

async function search(query: string, limit: number, rt: PingRuntime): Promise<string> {
  rt.searches += 1;
  const results = await rt.spotify.search(query, limit);
  for (const t of results) rt.seen.set(t.uri, t);
  rt.feed({ ts: Date.now(), phase: "tool", text: `⌕ search "${query}" → ${results.length} result(s)` });
  if (!results.length) return "No results — try different terms.";
  const nudge = rt.searches >= CONFIG.softSearchBudget ? `\n(${rt.searches} searches this ping — decide with what you have.)` : "";
  return (
    JSON.stringify(
      results.map((t) => ({
        uri: t.uri,
        name: t.name,
        artists: t.artists,
        durationSec: t.durationSec,
        popularity: t.popularity,
        alreadyPlayed: rt.session.alreadyPlayed(t.uri) || undefined,
      })),
    ) + nudge
  );
}

async function queue(uri: string, reason: string, interrupt: boolean, rt: PingRuntime): Promise<string> {
  const track = rt.seen.get(uri);
  if (!track) return "Unknown uri — only uris returned by search_spotify_tracks this ping can be queued.";
  const blocker = rt.session.queueBlocker(track);
  if (blocker) return blocker;
  if (!rt.spotify.available()) return UNAVAILABLE;
  let note = "";
  if (interrupt && !rt.interruptAllowed) {
    interrupt = false;
    note = " Interrupt not allowed for this event — queued for the next boundary instead.";
  }
  rt.session.pendingQueue = { track, reason, pingId: rt.pingId };
  try {
    await rt.spotify.queue(track, interrupt);
  } catch (err) {
    rt.session.pendingQueue = null;
    rt.feed({ ts: Date.now(), phase: "error", text: `✗ queue failed: ${errMsg(err)}` });
    return `Could not queue (${errMsg(err)}). ${UNAVAILABLE}`;
  }
  rt.feed({
    ts: Date.now(),
    phase: "decision",
    text: `♫ ${interrupt ? "cutting to" : "queued"} "${track.name}" — ${track.artists.join(", ")}: ${reason}`,
  });
  decide(rt, { action: "queue_track", interrupted: interrupt });
  return `Queued.${note}`;
}

const integration: Integration = {
  name: "spotify",
  order: 10,
  doctrine:
    "Music is the backbone lever. Verify tracks via search_spotify_tracks before queueing — only searched uris are queueable; keep searches to two or three, then act. For focus: instrumental bias, steady energy, no jarring transitions. Never repeat a track this session; avoid the same artist back-to-back. On DISTRACTED prefer a track with a clear onset; if the ledger shows a lane that pulled attention back, favour it.",
  tools: [
    defineTool({
      name: "search_spotify_tracks",
      description:
        "Search Spotify for real, playable tracks. Returns uri, name, artists, durationSec, popularity. Only uris returned here can be queued this ping.",
      inputSchema: z.object({
        query: z.string().describe("free-text search: vibe, genre, artist, or title"),
        limit: z.number().int().min(1).max(8).default(5),
      }),
      run: (i, rt) => search(i.query, i.limit, rt),
    }),
    defineTool({
      name: "queue_track",
      description:
        "Queue the chosen track. reason is shown to the listener (≤2 sentences, cite the evidence). interrupt=true skips the current track immediately (only when the EVENT allows interrupts).",
      inputSchema: z.object({
        uri: z.string(),
        reason: z.string(),
        interrupt: z.boolean(),
      }),
      run: (i, rt) => queue(i.uri, i.reason, i.interrupt, rt),
    }),
  ],
  leverStatus: (_session, deps) => [deps.spotify.available() ? "queue_track ✓" : "queue_track ✗ (no active Spotify device)"],
  contextLine: (session, deps) => {
    const np = deps.spotify.nowPlaying();
    const now = np
      ? `NOW_PLAYING: "${np.track.name}" — ${np.track.artists.join(", ")} (${mmss(np.positionSec)} / ${mmss(np.track.durationSec)})`
      : "NOW_PLAYING: nothing yet";
    const last = session.lastArtists();
    return `${now} · no repeats this session; avoid same artist back-to-back${last.length ? ` (last: ${last.join(", ")})` : ""}`;
  },
  events: (emit, session, { spotify, feed }) => {
    const onChange = (t: Parameters<typeof session.onTrackChange>[0]) => {
      session.onTrackChange(t);
      feed({ ts: Date.now(), phase: "info", text: `▶ now playing "${t.name}" — ${t.artists.join(", ")}` });
    };
    const onEnding = (t: { name: string }, secondsLeft: number) =>
      emit({ kind: "TRACK_ENDING", at: Date.now(), detail: `"${t.name}" ends in ~${Math.round(secondsLeft)}s` });
    spotify.on("trackchange", onChange);
    spotify.on("ending", onEnding);
    return () => {
      spotify.off("trackchange", onChange);
      spotify.off("ending", onEnding);
    };
  },
};

export default integration;
