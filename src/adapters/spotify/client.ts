// Thin Spotify Web API wrapper (design.md §8). No /recommendations.

import { ensureAccessToken } from "./auth.js";
import type { TrackResult } from "../../types.js";

export class NoActiveDeviceError extends Error {
  constructor(message = "No active Spotify device") {
    super(message);
    this.name = "NoActiveDeviceError";
  }
}

export interface SpotifyPlayerState {
  progress_ms: number;
  is_playing: boolean;
  item: {
    uri: string;
    name: string;
    duration_ms: number;
    artists: { name: string }[];
  } | null;
}

async function fetchSpotify(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const token = await ensureAccessToken();
  const method = (options.method ?? "GET").toUpperCase();
  const res = await fetch(`https://api.spotify.com${endpoint}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 404) throw new NoActiveDeviceError(`Spotify API 404: ${endpoint}`);

  // 204: GET /me/player → no device; POST queue/next → success
  if (res.status === 204) {
    if (method === "GET" && endpoint.startsWith("/v1/me/player")) throw new NoActiveDeviceError();
    return null;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Spotify API error: ${res.status} ${res.statusText}${errBody ? ` — ${errBody}` : ""}`);
  }

  const text = await res.text();
  if (!text) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  return JSON.parse(text) as unknown;
}

function mapTrack(t: {
  name: string;
  uri: string;
  duration_ms: number;
  popularity?: number;
  artists: { name: string }[];
}): TrackResult {
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
    const data = (await fetchSpotify(
      `/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(query)}`,
    )) as { tracks: { items: Parameters<typeof mapTrack>[0][] } };
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

  async getTopArtists(limit = 10): Promise<{ name: string; id: string; genres: string[] }[]> {
    const data = (await fetchSpotify(
      `/v1/me/top/artists?limit=${limit}&time_range=medium_term`,
    )) as { items: { name: string; id: string; genres: string[] }[] };
    return data.items.map((a) => ({ name: a.name, id: a.id, genres: a.genres }));
  },
};
