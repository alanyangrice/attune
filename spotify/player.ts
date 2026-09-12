import { EventEmitter } from 'events';
import { NoActiveDeviceError, spotifyClient } from './client';

export const playerEvents = new EventEmitter();

let pollInterval: NodeJS.Timeout | null = null;
/** Track URI we already fired `track_ending` for this boundary. */
let endingEmittedForUri: string | null = null;

export function startPolling() {
  if (pollInterval) return;

  pollInterval = setInterval(async () => {
    try {
      const state = await spotifyClient.getPlayerState();
      if (!state || !state.item) {
        playerEvents.emit('no-device', 'No active device or track');
        return;
      }

      const trackUri: string = state.item.uri;

      // New track → clear the once-per-boundary guard.
      if (endingEmittedForUri !== null && trackUri !== endingEmittedForUri) {
        endingEmittedForUri = null;
      }

      playerEvents.emit('state', {
        progress_ms: state.progress_ms,
        duration_ms: state.item.duration_ms,
        is_playing: state.is_playing,
        track_uri: trackUri,
        track_name: state.item.name,
      });

      // Once per track boundary (design.md §5 TRACK_ENDING).
      const msLeft = state.item.duration_ms - state.progress_ms;
      if (
        state.is_playing &&
        msLeft <= 25_000 &&
        endingEmittedForUri !== trackUri
      ) {
        endingEmittedForUri = trackUri;
        playerEvents.emit('track_ending', state.item);
      }
    } catch (err) {
      if (err instanceof NoActiveDeviceError) {
        playerEvents.emit('no-device', err);
      } else {
        playerEvents.emit('error', err);
      }
    }
  }, 5000);
}

export function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  endingEmittedForUri = null;
}
