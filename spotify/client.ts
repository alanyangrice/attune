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
  const method = (options.method ?? 'GET').toUpperCase();
  const res = await fetch(`https://api.spotify.com${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  // 404 → usually no active device on player endpoints.
  if (res.status === 404) {
    throw new NoActiveDeviceError(`Spotify API 404: ${endpoint}`);
  }

  // 204 No Content:
  //   GET  /me/player  → nothing playing / no device
  //   POST /queue|/next → success (empty body) — must NOT treat as an error
  if (res.status === 204) {
    if (method === 'GET' && endpoint.startsWith('/v1/me/player')) {
      throw new NoActiveDeviceError();
    }
    return null;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(
      `Spotify API error: ${res.status} ${res.statusText}${errBody ? ` — ${errBody}` : ''}`,
    );
  }

  const text = await res.text();
  if (!text) return null;

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    // Success with a non-JSON body (some player POSTs) — treat as empty.
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Spotify returned invalid JSON (${res.status}): ${text.slice(0, 80)}`,
    );
  }
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
