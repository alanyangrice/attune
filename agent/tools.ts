import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { spotifyClient } from '../spotify/client';

/**
 * Spotify-facing agent tools (design.md §5).
 * Other intervention tools (pacer, break, dnd, …) land here later.
 */

export const searchSpotifyTracks = betaZodTool({
  name: 'search_spotify_tracks',
  description:
    'Search Spotify for real, playable tracks. Returns name, artists, uri, duration, popularity.',
  inputSchema: z.object({
    query: z.string().describe('Search query, e.g. "ambient piano instrumental"'),
    limit: z.number().max(10).default(5).describe('Max results (≤10)'),
  }),
  run: async (input) => {
    const results = await spotifyClient.search(input.query, input.limit ?? 5);
    return JSON.stringify(results);
  },
});

export const queueTrack = betaZodTool({
  name: 'queue_track',
  description:
    'Queue the chosen track. reason is shown to the listener (≤2 sentences, cite the vitals evidence). interrupt=true skips the current track immediately.',
  inputSchema: z.object({
    uri: z.string().describe('Spotify track URI from search_spotify_tracks'),
    reason: z
      .string()
      .describe('Listener-visible reason, ≤2 sentences, cite evidence'),
    interrupt: z
      .boolean()
      .describe('If true, queue then skip now; if false, queue only'),
  }),
  run: async (input) => {
    if (input.interrupt) {
      await spotifyClient.interrupt(input.uri, input.reason);
      return JSON.stringify({
        ok: true,
        interrupted: true,
        uri: input.uri,
        reason: input.reason,
      });
    }
    await spotifyClient.queue(input.uri);
    return JSON.stringify({
      ok: true,
      interrupted: false,
      uri: input.uri,
      reason: input.reason,
    });
  },
});

/** Music tools only — expand with the rest of the §5 toolbox in M1. */
export const musicTools = [searchSpotifyTracks, queueTrack];
