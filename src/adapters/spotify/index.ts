// Spotify adapter factory (WORKPLAN lane 3).
//   SPOTIFY=stub  (default) — canned catalog, fake player
//   SPOTIFY=real            — desktop Spotify via Web API + PKCE

import type { NowPlaying, TrackResult } from "../../types.js";
import type { SpotifyPort } from "../../ports.js";
import { RealSpotify } from "./real.js";
import { StubSpotify } from "./stub.js";

/** What the harness / Electron need beyond the agent-facing SpotifyPort. */
export interface SpotifyRuntime extends SpotifyPort {
  start(): void;
  stop(): void;
  on(event: "trackchange", listener: (t: TrackResult) => void): this;
  on(event: "ending", listener: (t: TrackResult) => void): this;
  on(event: string, listener: (...args: never[]) => void): this;
  nowPlaying(): NowPlaying | null;
}

export type SpotifyMode = "stub" | "real";

export function spotifyMode(): SpotifyMode {
  const raw = (process.env.SPOTIFY ?? "stub").toLowerCase();
  return raw === "real" ? "real" : "stub";
}

/**
 * Build the Spotify runtime. Real mode runs PKCE before returning —
 * have the desktop app open and ready to play.
 */
export async function createSpotify(): Promise<SpotifyRuntime> {
  if (spotifyMode() === "real") {
    const real = new RealSpotify();
    await real.connect();
    return real as unknown as SpotifyRuntime;
  }
  return new StubSpotify() as unknown as SpotifyRuntime;
}

export { StubSpotify } from "./stub.js";
export { RealSpotify } from "./real.js";
