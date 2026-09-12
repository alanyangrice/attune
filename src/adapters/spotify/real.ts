// Real Spotify adapter — implements SpotifyPort over the Web API with a 5 s
// poll for playback state (design.md §8, WORKPLAN lane 3).

import { EventEmitter } from "node:events";
import { CONFIG } from "../../config.js";
import type { SpotifyEvents, SpotifyPort } from "../../ports.js";
import type { NowPlaying, TrackResult } from "../../types.js";
import { errMsg } from "../../util.js";
import { authenticate } from "./auth.js";
import { api, mapTrack, NoActiveDeviceError } from "./client.js";

const POLL_MS = 5000;

export class RealSpotify extends EventEmitter<SpotifyEvents> implements SpotifyPort {
  private pollTimer: NodeJS.Timeout | null = null;
  private now: NowPlaying | null = null;
  /** URI we queued for the upcoming boundary (cleared on track change). */
  private queuedUri: string | null = null;
  private endingEmittedForUri: string | null = null;
  private lastUri: string | null = null;
  private connected = false;
  private deviceMissing = false;

  /** PKCE login — call once before start(), or use createSpotify(). */
  async connect(): Promise<void> {
    if (this.connected) return;
    await authenticate();
    this.connected = true;
  }

  start(): void {
    if (this.pollTimer) return;
    void this.checkAccount(); // listeners exist by now; informational only
    void this.tick(); // immediate snapshot, then poll
    this.pollTimer = setInterval(() => void this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.endingEmittedForUri = null;
  }

  search(query: string, limit: number): Promise<TrackResult[]> {
    return api.search(query, limit);
  }

  async queue(track: TrackResult, interrupt: boolean): Promise<void> {
    await api.queue(track.uri);
    this.queuedUri = track.uri; // only once the API accepted it — a failed queue must not block TRACK_ENDING
    if (interrupt) await api.next();
  }

  nowPlaying(): NowPlaying | null {
    return this.now;
  }

  hasQueued(): boolean {
    return this.queuedUri !== null;
  }

  available(): boolean {
    return this.connected && !this.deviceMissing;
  }

  private async checkAccount(): Promise<void> {
    try {
      const me = await api.me();
      if (me.product && me.product !== "premium") {
        this.emit("warning", `Spotify account "${me.display_name}" is ${me.product} — playback control needs Premium; search still works`);
      }
    } catch (err) {
      this.emit("warning", `could not read Spotify account: ${errMsg(err)}`);
    }
  }

  /** emit once per outage, not once per poll */
  private noDevice(): void {
    this.now = null;
    if (this.deviceMissing) return;
    this.deviceMissing = true;
    this.emit("no-device", "No active Spotify device — press play in the desktop app");
  }

  private async tick(): Promise<void> {
    try {
      const state = await api.getPlayerState();
      if (!state?.item) return this.noDevice();
      if (this.deviceMissing) {
        this.deviceMissing = false;
        this.emit("device", "Spotify is back");
      }

      const track = mapTrack(state.item);
      if (this.lastUri !== track.uri) {
        this.queuedUri = null;
        this.endingEmittedForUri = null;
        this.emit("trackchange", track);
      }
      this.lastUri = track.uri;
      this.now = { track, positionSec: Math.floor(state.progress_ms / 1000), startedAt: Date.now() - state.progress_ms };

      // the poll can be up to POLL_MS late, so fire one poll early to protect the deliberation budget
      const secondsLeft = (state.item.duration_ms - state.progress_ms) / 1000;
      const lead = CONFIG.trackEndLeadSec + POLL_MS / 1000;
      if (state.is_playing && secondsLeft <= lead && this.endingEmittedForUri !== track.uri) {
        this.endingEmittedForUri = track.uri;
        this.emit("ending", track, secondsLeft);
      }
    } catch (err) {
      if (err instanceof NoActiveDeviceError) this.noDevice();
      else this.emit("warning", `poll failed: ${errMsg(err)}`);
    }
  }
}
