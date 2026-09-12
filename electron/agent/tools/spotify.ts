// Music integration: the backbone lever (search is info, queue is the action).

import { z } from "zod";
import { ALREADY_ACTED, decide, defineTool, type Integration, type PingRuntime } from "./types.js";

async function search(query: string, limit: number, rt: PingRuntime): Promise<string> {
  if (rt.actionTaken) return ALREADY_ACTED;
  if (rt.searchesLeft <= 0) return "Search budget exhausted — decide now with what you have.";
  rt.searchesLeft -= 1;
  const results = await rt.spotify.search(query, limit);
  for (const t of results) rt.seen.set(t.uri, t);
  rt.feed({ ts: Date.now(), phase: "tool", text: `⌕ search "${query}" → ${results.length} result(s)` });
  if (!results.length) return "No results — try different terms.";
  return JSON.stringify(
    results.map((t) => ({
      uri: t.uri,
      name: t.name,
      artists: t.artists,
      durationSec: t.durationSec,
      popularity: t.popularity,
      alreadyPlayed: rt.session.alreadyPlayed(t.uri) || undefined,
    })),
  );
}

async function queue(uri: string, reason: string, interrupt: boolean, rt: PingRuntime): Promise<string> {
  if (rt.actionTaken) return ALREADY_ACTED;
  const track = rt.seen.get(uri);
  if (!track) return "Unknown uri — only uris returned by search_spotify_tracks this ping can be queued.";
  if (rt.session.alreadyPlayed(uri)) return "Already played this session — pick another track.";
  const last = rt.session.lastArtists();
  if (track.artists.some((a) => last.includes(a)))
    return `Same artist back-to-back (${last.join(", ")}) — pick a different artist.`;
  let note = "";
  if (interrupt && !rt.interruptAllowed) {
    interrupt = false;
    note = " Interrupt not allowed for this event — queued for the next boundary instead.";
  }
  rt.session.pendingQueue = { track, reason };
  await rt.spotify.queue(track, interrupt);
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
    "Music is the backbone lever. Verify tracks via search_spotify_tracks before queueing — only searched uris are queueable, at most 3 searches, then act. For focus: instrumental bias, steady energy, no jarring transitions. Never repeat a track this session; avoid the same artist back-to-back. On DISTRACTED prefer a track with a clear onset; if the ledger shows a lane that pulled attention back, favour it.",
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
        "Queue the chosen track as your one action. reason is shown to the listener (≤2 sentences, cite the evidence). interrupt=true skips the current track immediately (only when the EVENT allows interrupts).",
      inputSchema: z.object({
        uri: z.string(),
        reason: z.string(),
        interrupt: z.boolean(),
      }),
      run: (i, rt) => queue(i.uri, i.reason, i.interrupt, rt),
    }),
  ],
  leverStatus: () => ["queue_track ✓"],
};

export default integration;
