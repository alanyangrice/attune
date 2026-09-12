// Stub Spotify — canned catalog + fake player (same SpotifyPort as real.ts).
// Emits "trackchange" and "ending" (at T − trackEndLeadSec).

import { EventEmitter } from "node:events";
import { CONFIG } from "../../config.js";
import type { NowPlaying, TrackResult } from "../../types.js";
import type { SpotifyPort } from "../../ports.js";

interface CatalogRow extends TrackResult {
  tags: string[];
}

const row = (
  name: string,
  artist: string,
  durationSec: number,
  popularity: number,
  tags: string[],
): CatalogRow => ({
  uri: `stub:track:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  name,
  artists: [artist],
  durationSec,
  popularity,
  tags,
});

const CATALOG: CatalogRow[] = [
  row("Weightless", "Marconi Union", 480, 62, ["ambient", "calm", "instrumental", "slow", "anxiety"]),
  row("Avril 14th", "Aphex Twin", 122, 70, ["piano", "instrumental", "calm", "gentle"]),
  row("Saman", "Ólafur Arnalds", 203, 64, ["piano", "ambient", "instrumental", "calm", "strings"]),
  row("Cobblestone", "Bonobo", 260, 55, ["downtempo", "electronic", "instrumental", "focus", "chill"]),
  row("Kiara", "Bonobo", 233, 66, ["electronic", "downtempo", "instrumental", "focus"]),
  row("Gymnopédie No.1", "Erik Satie", 190, 74, ["classical", "piano", "calm", "instrumental", "slow"]),
  row("Spirit Fingers", "Four Tet", 300, 58, ["electronic", "instrumental", "focus", "texture"]),
  row("Music For Airports 1/1", "Brian Eno", 1020, 60, ["ambient", "calm", "instrumental", "slow", "drone"]),
  row("Snowfall", "Øneheart", 130, 78, ["ambient", "lofi", "calm", "instrumental"]),
  row("Lofi Study Beat 42", "Chillhop Collective", 150, 50, ["lofi", "beats", "focus", "instrumental", "study"]),
  row("Night Owl", "Galimatias", 218, 61, ["chill", "electronic", "downtempo", "focus"]),
  row("Time", "Hans Zimmer", 275, 85, ["cinematic", "instrumental", "build", "epic", "focus"]),
  row("Experience", "Ludovico Einaudi", 315, 83, ["piano", "cinematic", "build", "instrumental", "energize"]),
  row("Strobe", "deadmau5", 634, 72, ["electronic", "progressive", "build", "instrumental", "energize", "focus"]),
  row("Midnight City", "M83", 244, 88, ["synth", "upbeat", "energize", "vocal", "hook"]),
  row("Go!", "The Chemical Brothers", 233, 67, ["electronic", "upbeat", "energize", "drums", "hook"]),
  row("Harlem River", "Kevin Morby", 350, 54, ["indie", "vocal", "mellow", "warm"]),
  row("Take Five", "Dave Brubeck", 324, 80, ["jazz", "instrumental", "focus", "classic", "swing"]),
];

export declare interface StubSpotify {
  on(event: "trackchange", listener: (t: TrackResult) => void): this;
  on(event: "ending", listener: (t: TrackResult) => void): this;
}

export class StubSpotify extends EventEmitter implements SpotifyPort {
  private now: { track: TrackResult; startedAt: number; positionSec: number; cap: number; endingEmitted: boolean } | null =
    null;
  private queued: TrackResult | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async search(query: string, limit: number): Promise<TrackResult[]> {
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const scored = CATALOG.map((c) => {
      const hay = [c.name, ...c.artists, ...c.tags].join(" ").toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { c, score };
    })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.c.popularity ?? 0) - (a.c.popularity ?? 0));
    return scored.slice(0, limit).map(({ c }) => ({
      uri: c.uri,
      name: c.name,
      artists: c.artists,
      durationSec: c.durationSec,
      popularity: c.popularity,
    }));
  }

  async queue(track: TrackResult, interrupt: boolean): Promise<void> {
    this.queued = track;
    if (interrupt || !this.now) this.advance();
  }

  /** fixtures / tests: pretend `track` has been playing for positionSec (no clock needed) */
  setNowPlaying(track: TrackResult, positionSec: number, queued: TrackResult | null = null): void {
    this.now = {
      track,
      startedAt: Date.now() - positionSec * 1000,
      positionSec,
      cap: Math.min(track.durationSec, CONFIG.trackSecondsCap),
      endingEmitted: false,
    };
    this.queued = queued;
  }

  nowPlaying(): NowPlaying | null {
    if (!this.now) return null;
    return { track: this.now.track, positionSec: this.now.positionSec, startedAt: this.now.startedAt };
  }

  hasQueued(): boolean {
    return this.queued !== null;
  }

  private advance(): void {
    if (!this.queued) return;
    const track = this.queued;
    this.queued = null;
    this.now = {
      track,
      startedAt: Date.now(),
      positionSec: 0,
      cap: Math.min(track.durationSec, CONFIG.trackSecondsCap),
      endingEmitted: false,
    };
    this.emit("trackchange", track);
  }

  private tick(): void {
    if (!this.now) return;
    this.now.positionSec += 1;
    const { positionSec, cap } = this.now;
    if (!this.now.endingEmitted && positionSec >= cap - CONFIG.trackEndLeadSec) {
      this.now.endingEmitted = true;
      this.emit("ending", this.now.track);
    }
    if (positionSec >= cap) {
      if (this.queued) this.advance();
      else {
        // nothing queued: keep "playing" a little longer and ask again,
        // mirroring real Spotify rolling into its own queue
        this.now.cap += 15;
        this.now.endingEmitted = false;
      }
    }
  }
}
