// Spotify adapter factory (WORKPLAN lane 3). CONFIG.spotify picks the mode:
//   stub (default) — canned catalog, fake player
//   real           — desktop Spotify via Web API + PKCE (login runs before this returns)

import { CONFIG } from "../../config.js";
import type { SpotifyPort } from "../../ports.js";
import { RealSpotify } from "./real.js";
import { StubSpotify } from "./stub.js";

export async function createSpotify(): Promise<SpotifyPort> {
  if (CONFIG.spotify === "real") {
    const real = new RealSpotify();
    await real.connect();
    return real;
  }
  return new StubSpotify();
}

export { StubSpotify } from "./stub.js";
export { RealSpotify } from "./real.js";
