function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderSourceRow(status) {
  const badge = status.active
    ? '<span class="badge ok">Showing</span>'
    : status.ready
      ? '<span class="badge idle">Ready</span>'
      : '<span class="badge pending">Pending</span>';
  const warning = status.lastError
    ? `<div class="source-error">${escapeHtml(status.lastError)}</div>`
    : '';
  return `<div class="source">
      <div><strong>${escapeHtml(status.label)}</strong> <span class="muted">${escapeHtml(status.detail)}</span>${warning}</div>
      ${badge}
    </div>`;
}

export function renderDashboardHtml({ config, statuses, hasSpotify, awtrixStatus, message = '', error = '' }) {
  const isLoopbackLan =
    config.serverLanUrl.includes('127.0.0.1') || config.serverLanUrl.includes('localhost');
  const spotifyConnected = statuses.find((s) => s.name === 'spotify')?.ready;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TC002 Now Playing</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #5b8def;
      --ok: #3fb950;
      --warn: #d29922;
      --err: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      max-width: 780px;
      margin-inline: auto;
      line-height: 1.5;
    }
    h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
    .sub, .muted { color: var(--muted); }
    .sub { margin-bottom: 1.5rem; font-size: 0.95rem; }
    .muted { font-size: 0.85rem; margin-left: 0.35rem; }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .ok { background: rgba(63, 185, 80, 0.18); color: var(--ok); border: 1px solid rgba(63, 185, 80, 0.4); }
    .idle { background: rgba(139, 148, 158, 0.15); color: var(--muted); border: 1px solid var(--border); }
    .pending { background: rgba(210, 153, 34, 0.18); color: #e3b341; border: 1px solid rgba(210, 153, 34, 0.4); }
    .source { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding: 0.55rem 0; border-top: 1px solid var(--border); }
    .source:first-of-type { border-top: 0; }
    .source-error { color: var(--warn); font-size: 0.85rem; overflow-wrap: anywhere; }
    .alert { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.9rem; }
    .alert.msg { background: rgba(63, 185, 80, 0.15); border: 1px solid var(--ok); }
    .alert.err { background: rgba(248, 81, 73, 0.15); border: 1px solid var(--err); }
    .alert.warn { background: rgba(210, 153, 34, 0.15); border: 1px solid var(--warn); }
    .matrix-wrap {
      background: #050709;
      border: 2px solid #22272e;
      border-radius: 10px;
      padding: 14px;
      display: flex;
      justify-content: center;
      margin: 0.75rem 0;
    }
    canvas { width: 100%; max-width: 624px; aspect-ratio: 52 / 16; image-rendering: pixelated; }
    .btn {
      display: inline-block;
      background: var(--accent);
      color: #000;
      font-weight: 700;
      text-decoration: none;
      border: none;
      border-radius: 6px;
      padding: 0.55rem 1rem;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .btn.secondary { background: #21262d; color: var(--text); border: 1px solid var(--border); font-weight: 500; }
    .controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
    input[type="text"] {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #0d1117;
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      margin: 0.4rem 0 0.6rem;
    }
    code { background: #0d1117; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.85em; overflow-wrap: anywhere; }
    .kv { display: grid; grid-template-columns: 165px 1fr; gap: 0.35rem 0.75rem; font-size: 0.9rem; }
    .kv div:nth-child(odd) { color: var(--muted); }
    details { margin-top: 0.75rem; color: var(--muted); font-size: 0.88rem; }
    summary { cursor: pointer; color: var(--text); font-weight: 500; }
    @media (max-width: 520px) { .kv { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>TC002 Now Playing</h1>
  <div class="sub">52×16 AWTRIX NG bridge with 16×16 album art and a Berry renderer on the clock</div>

  ${message ? `<div class="alert msg">${escapeHtml(message)}</div>` : ''}
  ${error ? `<div class="alert err">${escapeHtml(error)}</div>` : ''}
  ${isLoopbackLan ? `<div class="alert warn"><strong>Warning:</strong> <code>SERVER_LAN_URL</code> is <code>${escapeHtml(config.serverLanUrl)}</code>. Set it to <code>http://&lt;THIS_MACHINE_LAN_IP&gt;:${config.port}</code> in <code>.env</code> so your TC002 can reach this bridge over Wi-Fi.</div>` : ''}
  ${statuses.length === 0 ? '<div class="alert warn"><strong>No sources enabled.</strong> Set <code>PUSH_TOKEN</code> for Mac Now Playing, or the <code>SPOTIFY_*</code> variables for Spotify, then restart.</div>' : ''}

  <div class="card">
    <div class="row">
      <strong>Live 52×16 Matrix Simulator</strong>
      <span id="trackMeta" style="color:var(--muted); font-size:0.85rem;">Idle</span>
    </div>
    <div class="matrix-wrap">
      <canvas id="matrix" width="520" height="160"></canvas>
    </div>
    <div class="controls">
      <button class="btn secondary" onclick="act('previous')">⏮ Prev</button>
      <button class="btn secondary" onclick="act('toggle')">⏯ Play / Pause</button>
      <button class="btn secondary" onclick="act('next')">⏭ Next</button>
      <a class="btn secondary" href="/berry/now_playing.be" target="_blank">View Berry Script (.be)</a>
    </div>
  </div>

  <div class="card">
    <strong>Sources</strong>
    <div style="margin-top:0.5rem;">
      ${statuses.map(renderSourceRow).join('')}
    </div>
    ${hasSpotify ? `
    <div class="controls">
      <a class="btn" href="/auth/login">${spotifyConnected ? 'Reconnect Spotify' : 'Connect Spotify'}</a>
      ${spotifyConnected ? '<form method="POST" action="/auth/logout" style="margin:0;"><button class="btn secondary" type="submit">Disconnect Spotify</button></form>' : ''}
    </div>
    <details>
      <summary>Running on a headless machine? Paste the Spotify callback URL manually</summary>
      <p style="margin:0.5rem 0;">If you opened this page from another computer and Spotify redirected your browser to <code>http://127.0.0.1:${config.port}/callback?code=...</code>, copy that full URL from the address bar and paste it below:</p>
      <form method="POST" action="/auth/manual-callback">
        <input type="text" name="callbackUrl" placeholder="http://127.0.0.1:${config.port}/callback?code=AQD...&amp;state=..." required />
        <button class="btn secondary" type="submit">Complete Sign-In</button>
      </form>
    </details>` : ''}
  </div>

  <div class="card">
    <div class="row" style="margin-bottom:0.75rem;">
      <strong>Ulanzi TC002 (AWTRIX NG)</strong>
      ${awtrixStatus.configured ? `<span class="badge ${awtrixStatus.lastError ? 'pending' : 'ok'}">${awtrixStatus.lastError ? 'Retrying' : 'Ready'}</span>` : '<span class="badge pending">No Host Set</span>'}
    </div>
    <div class="kv">
      <div>Clock Host:</div>
      <div><code>${escapeHtml(config.awtrix.host || 'Not set')}</code></div>
      <div>Script App Name:</div>
      <div><code>${escapeHtml(config.awtrix.appName)}</code> (${awtrixStatus.scriptSynced ? 'Installed' : 'Pending sync'})</div>
      <div>Bridge Poll URL:</div>
      <div><code>${escapeHtml(config.serverLanUrl)}/api/now-playing</code></div>
      ${awtrixStatus.lastError ? `<div>Last Warning:</div><div style="color:var(--warn)">${escapeHtml(awtrixStatus.lastError)}</div>` : ''}
    </div>
  </div>

  <script>
    const canvas = document.getElementById('matrix');
    const ctx = canvas.getContext('2d');
    const metaEl = document.getElementById('trackMeta');
    const DEFAULT_ACCENT = 0x5b8def;
    let state = { playing: false, title: 'Now Playing', artist: 'Idle', accent: DEFAULT_ACCENT, progressMs: 0, durationMs: 1, art: null, fetchedAt: performance.now() };

    const FONT_3X5 = {
      ' ': [0,0,0,0,0], '!': [2,2,2,0,2], "'": [2,2,0,0,0], '(': [1,2,2,2,1], ')': [4,2,2,2,4],
      '-': [0,0,7,0,0], '.': [0,0,0,0,2], '/': [1,1,2,4,4], ':': [0,2,0,2,0], '?': [6,1,2,0,2],
      '0': [7,5,5,5,7], '1': [2,6,2,2,7], '2': [7,1,7,4,7], '3': [7,1,7,1,7], '4': [5,5,7,1,1],
      '5': [7,4,7,1,7], '6': [7,4,7,5,7], '7': [7,1,1,2,2], '8': [7,5,7,5,7], '9': [7,5,7,1,7],
      'A': [2,5,7,5,5], 'B': [6,5,6,5,6], 'C': [3,4,4,4,3], 'D': [6,5,5,5,6], 'E': [7,4,6,4,7],
      'F': [7,4,6,4,4], 'G': [3,4,5,5,3], 'H': [5,5,7,5,5], 'I': [7,2,2,2,7], 'J': [1,1,1,5,2],
      'K': [5,5,6,5,5], 'L': [4,4,4,4,7], 'M': [5,7,7,5,5], 'N': [5,7,7,7,5], 'O': [2,5,5,5,2],
      'P': [6,5,6,4,4], 'Q': [2,5,5,7,3], 'R': [6,5,6,5,5], 'S': [3,4,2,1,6], 'T': [7,2,2,2,2],
      'U': [5,5,5,5,7], 'V': [5,5,5,5,2], 'W': [5,5,7,7,5], 'X': [5,5,2,5,5], 'Y': [5,5,2,2,2], 'Z': [7,1,2,4,7]
    };

    function hexColor(intVal) {
      return '#' + (intVal >>> 0).toString(16).padStart(6, '0');
    }

    function setLed(fb, x, y, colorInt) {
      if (x < 0 || x >= 52 || y < 0 || y >= 16) return;
      fb[y * 52 + x] = colorInt;
    }

    function drawText(fb, x0, y0, str, colorInt) {
      const upper = String(str || '').toUpperCase();
      let cx = x0;
      for (const ch of upper) {
        const glyph = FONT_3X5[ch] || FONT_3X5['?'];
        const w = ch === ' ' ? 2 : 3;
        for (let r = 0; r < 5; r++) {
          const rowBits = glyph[r];
          for (let c = 0; c < w; c++) {
            if ((rowBits >> (2 - c)) & 1) setLed(fb, cx + c, y0 + r, colorInt);
          }
        }
        cx += w + 1;
      }
    }

    function measureText(str) {
      const upper = String(str || '').toUpperCase();
      if (!upper.length) return 0;
      let w = 0;
      for (const ch of upper) w += (ch === ' ' ? 2 : 3) + 1;
      return w - 1;
    }

    function drawScrolling(fb, xStart, yPos, availW, content, colorInt, phase) {
      const tw = measureText(content);
      if (tw <= availW) {
        drawText(fb, xStart, yPos, content, colorInt);
        return;
      }
      const gap = 14;
      const span = tw + gap;
      const holdMs = 1500;
      const cycle = holdMs + span * 45;
      const t = (performance.now() + phase) % cycle;
      const offset = t > holdMs ? Math.floor((t - holdMs) / 45) : 0;
      const x1 = xStart - offset;
      drawText(fb, x1, yPos, content, colorInt);
      if (x1 + span < xStart + availW) drawText(fb, x1 + span, yPos, content, colorInt);
    }

    function drawNoteIcon(fb, accent) {
      for (let y = 3; y < 11; y++) setLed(fb, 9, y, accent);
      for (let x = 9; x < 13; x++) setLed(fb, x, 3, accent);
      for (let y = 10; y < 13; y++) for (let x = 5; x < 9; x++) setLed(fb, x, y, accent);
    }

    function renderFrame() {
      const fb = new Int32Array(52 * 16).fill(0x090c10);
      const accent = state.accent ?? DEFAULT_ACCENT;
      drawScrolling(fb, 17, 1, 35, state.title || 'Now Playing', 0xffffff, 0);
      drawScrolling(fb, 17, 8, 35, state.artist || '', accent, 600);

      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 17; x++) setLed(fb, x, y, 0x090c10);
      }

      if (Array.isArray(state.art) && state.art.length === 256) {
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const c = state.art[y * 16 + x];
            setLed(fb, x, y, c > 0 ? c : 0x090c10);
          }
        }
      } else {
        drawNoteIcon(fb, accent);
      }

      const elapsed = Math.min(state.durationMs || 1, (state.progressMs || 0) + (state.playing ? performance.now() - state.fetchedAt : 0));
      const fillW = Math.round((elapsed / Math.max(1, state.durationMs)) * 35);
      for (let x = 0; x < 35; x++) {
        setLed(fb, 17 + x, 15, x < fillW ? accent : 0x1e242b);
      }

      ctx.fillStyle = '#050709';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const cell = 10;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 52; x++) {
          ctx.fillStyle = hexColor(fb[y * 52 + x]);
          ctx.beginPath();
          ctx.roundRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2, 2);
          ctx.fill();
        }
      }
      requestAnimationFrame(renderFrame);
    }

    async function pollPreview() {
      try {
        const r = await fetch('/api/preview');
        if (r.ok) {
          const d = await r.json();
          state = { ...d, fetchedAt: performance.now() };
          metaEl.textContent = d.id
            ? (d.playing ? '' : 'Paused: ') + d.artist + ' — ' + d.title + ' (' + d.sourceLabel + ')'
            : 'Idle';
        }
      } catch {}
    }

    async function act(name) {
      await fetch('/api/action/' + name, { method: 'POST' });
      setTimeout(pollPreview, 350);
    }

    pollPreview();
    setInterval(pollPreview, 2000);
    requestAnimationFrame(renderFrame);
  </script>
</body>
</html>`;
}
