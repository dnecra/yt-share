// Floating Lyrics integration (CLIENT-SIDE)
//
// A browser cannot inspect local files/processes. To make detection per-client, the
// Floating Lyrics Tauri app exposes a tiny localhost API:
//
//   GET  http://127.0.0.1:32145/floating-lyrics/status   -> { running: true }
//   POST http://127.0.0.1:32145/floating-lyrics/toggle   -> toggles/quit (we use as stop)
//
// This module provides:
// - initFloatingLyricsToggleButton(): start/stop toggle based on localhost reachability
// - initFloatingLyricsDownloadButton(): label-less download icon button (/download)

const LOCAL_API_BASE = 'http://127.0.0.1:32145';
let statusPollTimer = null;
let lastReachable = false;

function triggerDownload() {
  const a = document.createElement('a');
  a.href = '/download';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { document.body.removeChild(a); } catch (_) {}
  }, 500);
}

function setToggleBtnState(btn, reachable) {
  const lbl = btn.querySelector('.stream-label');
  const icon = btn.querySelector('.material-icons.stream-icon');

  if (reachable) {
    if (icon) icon.textContent = 'stop_circle';
    btn.title = 'Stop Floating Lyrics (this PC)';
    btn.classList.add('active');
    btn.dataset.mode = 'stop';
  } else {
    if (icon) icon.textContent = 'play_circle';
    btn.title = 'Start Floating Lyrics (this PC)';
    btn.classList.remove('active');
    btn.dataset.mode = 'start';
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 1200) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

async function isLocalApiReachable() {
  try {
    const r = await fetchWithTimeout(`${LOCAL_API_BASE}/floating-lyrics/status`, {}, 900);
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function stopLocalApp() {
  const r = await fetchWithTimeout(`${LOCAL_API_BASE}/floating-lyrics/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }, 1200);
  if (!r.ok) throw new Error(`toggle_failed_${r.status}`);
}

// Starting an EXE from a browser is not possible.
// The lightest way is a custom URL protocol registered by the app/installer.
// If you register e.g. "floatinglyrics://open", this will launch the app.
function tryStartViaProtocol() {
  try {
    window.location.href = 'floatinglyrics://open';
  } catch (_) {
    // Ignore
  }
}

async function refreshToggleState(btn) {
  const reachable = await isLocalApiReachable();
  lastReachable = reachable;
  setToggleBtnState(btn, reachable);
  
  // Also update download button active state
  const dlBtn = document.getElementById('floating-lyrics-download-btn');
  if (dlBtn) {
    if (reachable) dlBtn.classList.add('active');
    else dlBtn.classList.remove('active');
  }
}

export function initFloatingLyricsToggleButton() {
  const btn = document.getElementById('floating-lyrics-btn');
  if (!btn) return;

  // Remove old listeners by cloning
  const cloned = btn.cloneNode(true);
  btn.parentNode.replaceChild(cloned, btn);
  const toggleBtn = document.getElementById('floating-lyrics-btn');

  toggleBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    const mode = toggleBtn.dataset.mode || 'start';
    if (mode === 'stop') {
      try { await stopLocalApp(); } catch (_) {}
    } else {
      // Best-effort: attempt to start via custom protocol (if registered)
      tryStartViaProtocol();
    }

    // Refresh quickly a few times (app may need a moment to come up/down)
    for (const delay of [250, 600, 1200]) {
      await new Promise(r => setTimeout(r, delay));
      await refreshToggleState(toggleBtn);
      if (lastReachable && mode === 'start') break;
      if (!lastReachable && mode === 'stop') break;
    }
  });

  (async () => {
    await refreshToggleState(toggleBtn);

    // Adaptive polling: when the local app is not running, avoid spamming the console
    // (many browsers log failed localhost requests even if we catch the error).
    if (statusPollTimer) clearTimeout(statusPollTimer);

    let pollDelayMs = 2000;
    const pollMinMs = 2000;
    const pollMaxMs = 60000;

    const pollOnce = async () => {
      const r = await isLocalApiReachable();
      if (r !== lastReachable) {
        lastReachable = r;
        setToggleBtnState(toggleBtn, r);

        // Keep download button state in sync
        const dlBtn = document.getElementById('floating-lyrics-download-btn');
        if (dlBtn) {
          if (r) dlBtn.classList.add('active');
          else dlBtn.classList.remove('active');
        }
      }

      // Backoff when unreachable; reset when reachable
      if (lastReachable) pollDelayMs = pollMinMs;
      else pollDelayMs = Math.min(pollMaxMs, Math.round(pollDelayMs * 1.8));

      statusPollTimer = setTimeout(pollOnce, pollDelayMs);
    };

    statusPollTimer = setTimeout(pollOnce, pollDelayMs);
})();
}

export function initFloatingLyricsDownloadButton() {
  const btn = document.getElementById('floating-lyrics-download-btn');
  if (!btn) return;

  // Remove old listeners by cloning
  const cloned = btn.cloneNode(true);
  btn.parentNode.replaceChild(cloned, btn);
  const dlBtn = document.getElementById('floating-lyrics-download-btn');

  dlBtn.addEventListener('click', (e) => {
    e.preventDefault();
    triggerDownload();
  });
}
