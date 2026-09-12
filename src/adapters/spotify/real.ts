// Real Spotify adapter — implements SpotifyPort + the same events the stub
// emits so run-loop / Electron can swap SPOTIFY=stub|real without changes.
// (design.md §8, WORKPLAN lane 3)

import { EventEmitter } from "node:events";
import { CONFIG } from "../../config.js";
import type { NowPlaying, TrackResult } from "../../types.js";
import type { SpotifyPort } from "../../ports.js";
import { authenticate } from "./auth.js";
import { api, NoActiveDeviceError } from "./client.js";

export declare interface RealSpotify {
  on(event: "trackchange", listener: (t: TrackResult) => void): this;
  on(event: "ending", listener: (t: TrackResult) => void): this;
  on(event: "no-device", listener: (message: string) => void): this;
  on(event: "error", listener: (err: unknown) => void): this;
}

export class RealSpotify extends EventEmitter implements SpotifyPort {
  private pollTimer: NodeJS.Timeout | null = null;
  private now: NowPlaying | null = null;
  /** URI we queued for the upcoming boundary (cleared on track change). */
  private queuedUri: string | null = null;
  private endingEmittedForUri: string | null = null;
  private lastUri: string | null = null;
  private connected = false;

  /** PKCE login — call once before start(), or use createSpotify(). */
  async connect(): Promise<void> {
    if (this.connected) return;
    await authenticate();
    this.connected = true;
  }

  start(): void {
    if (this.pollTimer) return;
    // immediate snapshot, then 5 s poll (design.md §8)
    void this.tick();
    this.pollTimer = setInterval(() => void this.tick(), 5000);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.endingEmittedForUri = null;
  }

  async search(query: string, limit: number): Promise<TrackResult[]> {
    return api.search(query, limit);
  }

  async queue(track: TrackResult, interrupt: boolean): Promise<void> {
    this.queuedUri = track.uri;
    if (interrupt) {
      await api.queue(track.uri);
      await api.next();
    } else {
      await api.queue(track.uri);
    }
  }

  nowPlaying(): NowPlaying | null {
    return this.now;
  }

  hasQueued(): boolean {
    return this.queuedUri !== null;
  }

  /** Optional TASTE seed (scope user-top-read). */
  async topArtists(limit = 10) {
    return api.getTopArtists(limit);
  }

  private async tick(): Promise<void> {
    try {
      const state = await api.getPlayerState();
      if (!state?.item) {
        this.now = null;
        this.emit("no-device", "Poke play in Spotify");
        return;
      }

      const track: TrackResult = {
        uri: state.item.uri,
        name: state.item.name,
        artists: state.item.artists.map((a) => a.name),
        durationSec: Math.round(state.item.duration_ms / 1000),
      };
      const positionSec = Math.floor(state.progress_ms / 1000);

      if (this.lastUri && this.lastUri !== track.uri) {
        this.queuedUri = null;
        this.endingEmittedForUri = null;
        this.emit("trackchange", track);
      } else if (!this.lastUri) {
        this.emit("trackchange", track);
      }
      this.lastUri = track.uri;

      this.now = {
        track,
        positionSec,
        startedAt: Date.now() - state.progress_ms,
      };

      const lead = CONFIG.trackEndLeadSec;
      const msLeft = state.item.duration_ms - state.progress_ms;
      if (
        state.is_playing &&
        msLeft <= lead * 1000 &&
        this.endingEmittedForUri !== track.uri
      ) {
        this.endingEmittedForUri = track.uri;
        this.emit("ending", track);
      }
    } catch (err) {
      if (err instanceof NoActiveDeviceError) {
        this.now = null;
        this.emit("no-device", "Poke play in Spotify");
      } else {
        this.emit("error", err);
      }
    }
  }
}
