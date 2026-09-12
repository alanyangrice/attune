import { ensureAccessToken } from './auth';

/** Thrown when Spotify has no active playback device (404 / empty player). */
export class NoActiveDeviceError extends Error {
  constructor(message = 'No active Spotify device') {
    super(message);
    this.name = 'NoActiveDeviceError';
  }
}

async function fetchSpotify(endpoint: string, options: RequestInit = {}) {
  const token = await ensureAccessToken();
  const res = await fetch(`https://api.spotify.com${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  // GET /me/player returns 204 when nothing is playing / no device.
  // Control endpoints often return 404 for the same condition.
  if (res.status === 204) {
    throw new NoActiveDeviceError();
  }
  if (res.status === 404) {
    throw new NoActiveDeviceError(`Spotify API 404: ${endpoint}`);
  }
  if (!res.ok) {
    throw new Error(`Spotify API error: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const spotifyClient = {
  async search(query: string, limit: number = 5) {
    const data = await fetchSpotify(
      `/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(query)}`,
    );
    return data.tracks.items.map((t: any) => ({
      name: t.name,
      artists: t.artists.map((a: any) => a.name).join(', '),
      uri: t.uri,
      duration: t.duration_ms,
      popularity: t.popularity,
    }));
  },

  async queue(uri: string) {
    await fetchSpotify(`/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, {
      method: 'POST',
    });
  },

  async next() {
    await fetchSpotify('/v1/me/player/next', { method: 'POST' });
  },

  /**
   * Interrupt = queue then skip now (API can't clear/replace the queue).
   * Matches queue_track(..., interrupt=true) in design.md §5.
   * `reason` is for callers/UI; Spotify does not receive it.
   */
  async interrupt(uri: string, _reason?: string) {
    await spotifyClient.queue(uri);
    await spotifyClient.next();
  },

  async getPlayerState() {
    return fetchSpotify('/v1/me/player');
  },

  /** Seed the agent's TASTE block (design.md §5 / §8 scopes). */
  async getTopArtists(limit: number = 10) {
    const data = await fetchSpotify(
      `/v1/me/top/artists?limit=${limit}&time_range=medium_term`,
    );
    return data.items.map((a: any) => ({
      name: a.name,
      id: a.id,
      genres: a.genres as string[],
    }));
  },
};
