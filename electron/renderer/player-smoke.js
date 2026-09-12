/** Renderer script for IPC player smoke (no bundler). */
(() => {
  const attune = window.attune;
  if (!attune) {
    document.getElementById('status').textContent =
      'window.attune missing — preload failed';
    return;
  }

  const trackEl = document.getElementById('track');
  const metaEl = document.getElementById('meta');
  const bannerEl = document.getElementById('banner');
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function log(line) {
    const ts = new Date().toISOString().slice(11, 19);
    logEl.textContent = `[${ts}] ${line}\n` + logEl.textContent;
  }

  attune.onPlayerState((state) => {
    bannerEl.classList.remove('show');
    trackEl.textContent = state.track_name;
    metaEl.textContent = `${fmt(state.progress_ms)} / ${fmt(state.duration_ms)} · ${
      state.is_playing ? 'playing' : 'paused'
    }`;
    log(`player:state ${state.track_name}`);
  });

  attune.onPlayerNoDevice(() => {
    bannerEl.classList.add('show');
    trackEl.textContent = '—';
    metaEl.textContent = 'No active device';
    log('player:no-device → poke play in Spotify');
  });

  attune.onPlayerError((payload) => {
    statusEl.textContent = `Error: ${payload.message}`;
    log(`player:error ${payload.message}`);
  });

  attune.onSessionState((s) => {
    statusEl.textContent = s.running
      ? `Session running · target=${s.target || '?'} · ${s.task || ''}`
      : 'Session stopped';
    log(`session:state running=${s.running}`);
  });

  document.getElementById('start').onclick = async () => {
    statusEl.textContent = 'Starting…';
    await attune.startSession({
      target: 'focus',
      task: 'IPC smoke test',
      tastePrompt: 'instrumental ok',
    });
  };

  document.getElementById('stop').onclick = async () => {
    await attune.stopSession();
  };

  document.getElementById('nudge').onclick = async () => {
    await attune.nudge();
    log('user:nudge');
  };
})();
