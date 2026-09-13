// Thin Spotify Web API wrapper (design.md §8). No /recommendations.

import { ensureAccessToken } from "./auth.js";
import type { TrackResult } from "../../types.js";

export class NoActiveDeviceError extends Error {
  constructor(message = "No active Spotify device") {
    super(message);
    this.name = "NoActiveDeviceError";
  }
}

interface SpotifyTrackItem {
  uri: string;
  name: string;
  duration_ms: number;
  popularity?: number;
  artists: { name: string }[];
}

export interface SpotifyPlayerState {
  progress_ms: number;
  is_playing: boolean;
  item: SpotifyTrackItem | null;
}

async function fetchSpotify(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const token = await ensureAccessToken();
  const method = (options.method ?? "GET").toUpperCase();
  const res = await fetch(`https://api.spotify.com${endpoint}`, {
    ...options,
    headers: { Accept: "application/json", ...options.headers, Authorization: `Bearer ${token}` },
  });

  // GET /me/player answers 204 (nothing playing) or 404 (no device) — both mean "no active device";
  // POST queue/next answer 200/204 on success.
  const playerGet = method === "GET" && endpoint.startsWith("/v1/me/player");
  if (playerGet && (res.status === 204 || res.status === 404)) throw new NoActiveDeviceError();
  if (res.status === 204) return null;

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Spotify API error: ${res.status} ${res.statusText}${errBody ? ` — ${errBody}` : ""}`);
  }

  const text = await res.text();
  if (!text || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
  return JSON.parse(text) as unknown;
}

export function mapTrack(t: SpotifyTrackItem): TrackResult {
  return {
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => a.name),
    durationSec: Math.round(t.duration_ms / 1000),
    popularity: t.popularity,
  };
}

export const api = {
  async search(query: string, limit = 5): Promise<TrackResult[]> {
    const data = (await fetchSpotify(`/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(query)}`)) as {
      tracks: { items: SpotifyTrackItem[] };
    };
    return data.tracks.items.map(mapTrack);
  },

  async queue(uri: string): Promise<void> {
    await fetchSpotify(`/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: "POST" });
  },

  async next(): Promise<void> {
    await fetchSpotify("/v1/me/player/next", { method: "POST" });
  },

  async getPlayerState(): Promise<SpotifyPlayerState | null> {
    return (await fetchSpotify("/v1/me/player")) as SpotifyPlayerState | null;
  },

  /** product is "premium" | "free" | …; undefined if the token predates the user-read-private scope */
  async me(): Promise<{ display_name: string; product?: string }> {
    return (await fetchSpotify("/v1/me")) as { display_name: string; product?: string };
  },

  /** TASTE seed (WORKPLAN lane 3), scope user-top-read */
  async getTopArtists(limit = 10): Promise<{ name: string; id: string; genres: string[] }[]> {
    const data = (await fetchSpotify(`/v1/me/top/artists?limit=${limit}&time_range=medium_term`)) as {
      items: { name: string; id: string; genres: string[] }[];
    };
    return data.items.map((a) => ({ name: a.name, id: a.id, genres: a.genres }));
  },
};
