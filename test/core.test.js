import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processRgb16x16, ArtworkProcessor } from '../src/artwork.js';
import { sanitizeMatrixText, safeTrackId } from '../src/text.js';
import { SpotifySource, pickSmallestCoverImage } from '../src/sources/spotify.js';
import { PushSource } from '../src/sources/push.js';
import { createSources } from '../src/sources/index.js';
import { SourceManager, pickActive, DEFAULT_ACCENT } from '../src/manager.js';
import { TokenStore } from '../src/store.js';
import { AwtrixCoordinator } from '../src/awtrix.js';
import { createBridgeServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { parseNowPlaying } from '../agent/mac-now-playing-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeSource {
  canControl = true;
  constructor(name, { accent = 0x123456 } = {}) {
    this.name = name;
    this.label = name.toUpperCase();
    this.accent = accent;
    this.result = { playing: false, id: '' };
    this.controls = [];
  }
  async isReady() { return true; }
  async status() { return { ready: true, detail: 'ok' }; }
  async poll() {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async control(action) {
    this.controls.push(action);
    return { ok: true };
  }
}

function track(id, overrides = {}) {
  return { playing: true, id, title: `Title ${id}`, artist: 'Artist', album: 'Album', progressMs: 1000, durationMs: 60000, art: null, ...overrides };
}

function makeManager(sources, opts = {}) {
  const snapshots = [];
  const manager = new SourceManager({
    sources,
    artwork: opts.artwork ?? { getArtwork: async () => ({ pixels: new Array(256).fill(1), accent: 0xabcdef }) },
    onSnapshot: async (s) => { snapshots.push(s); },
    ...opts,
  });
  return { manager, snapshots };
}

test('sanitizeMatrixText cleans smart quotes, dashes, and diacritics for LED fonts', () => {
  assert.equal(
    sanitizeMatrixText('Sigur Rós — “Hoppípolla” (Don’t Stop…)'),
    'Sigur Ros - "Hoppipolla" (Don\'t Stop...)'
  );
  assert.equal(sanitizeMatrixText('Beyoncé', { asciiTransliterate: false }), 'Beyoncé');
});

test('safeTrackId is URL-safe, namespaced per source, and empty for no track', () => {
  const id = safeTrackId('mac', 'ABC123:Some/Radio?Title&x=1');
  assert.match(id, /^mac_[0-9a-f]{16}$/);
  assert.notEqual(id, safeTrackId('spotify', 'ABC123:Some/Radio?Title&x=1'));
  assert.equal(safeTrackId('spotify', ''), '');
});

test('pickSmallestCoverImage chooses compact >=64px Spotify cover over 640px', () => {
  const images = [
    { url: 'https://i.scdn.co/image/640', width: 640, height: 640 },
    { url: 'https://i.scdn.co/image/300', width: 300, height: 300 },
    { url: 'https://i.scdn.co/image/64', width: 64, height: 64 },
  ];
  assert.equal(pickSmallestCoverImage(images), 'https://i.scdn.co/image/64');
});

test('processRgb16x16 clamps near-black LED floor and extracts vibrant accent color', () => {
  const buf = Buffer.alloc(16 * 16 * 3, 0);
  for (let i = 0; i < 128; i++) {
    buf[i * 3] = 3;
    buf[i * 3 + 1] = 4;
    buf[i * 3 + 2] = 2;
  }
  for (let i = 128; i < 256; i++) {
    buf[i * 3] = 15;
    buf[i * 3 + 1] = 180;
    buf[i * 3 + 2] = 240;
  }

  const { pixels, accent } = processRgb16x16(buf);
  assert.equal(pixels.length, 256);
  assert.equal(pixels[0], 0x000000);
  assert.ok(pixels[200] > 0);

  const r = (accent >> 16) & 0xff;
  const g = (accent >> 8) & 0xff;
  const b = accent & 0xff;
  assert.ok(b > 200 && g > 140 && r < 120, `Unexpected accent RGB: ${r},${g},${b}`);
});

test('processRgb16x16 leaves accent null on grayscale covers so the source color applies', () => {
  const { accent } = processRgb16x16(Buffer.alloc(16 * 16 * 3, 120));
  assert.equal(accent, null);
});

test('ArtworkProcessor caches by key, accepts buffers, and keeps URLs out of errors', async () => {
  let fetchCalls = 0;
  let status = 200;
  const processor = new ArtworkProcessor({
    fetchFn: async () => {
      fetchCalls++;
      return { ok: status === 200, status, arrayBuffer: async () => new ArrayBuffer(16) };
    },
    decodeToRgb16x16: async () => Buffer.alloc(16 * 16 * 3, 200),
  });

  const a1 = await processor.getArtwork({ key: 'k', url: 'https://example.com/a.jpg' });
  const a2 = await processor.getArtwork({ key: 'k', url: 'https://example.com/a.jpg' });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(a1, a2);

  await processor.getArtwork({ key: 'buf', buffer: Buffer.alloc(4) });
  assert.equal(fetchCalls, 1);

  status = 403;
  await assert.rejects(
    processor.getArtwork({ key: 'x', url: 'https://example.com/a.jpg?token=secret' }),
    (err) => !err.message.includes('secret')
  );
});

test('SpotifySource refreshes expired tokens, persists rotated refresh_token, and parses playback', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc002-spotify-test-'));
  try {
    const store = new TokenStore(tmpDir);
    await store.save({ accessToken: 'expired', refreshToken: 'initial', expiresAtMs: Date.now() - 5000 });

    const spotify = new SpotifySource({
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'http://127.0.0.1:8765/callback',
      tokenStore: store,
      fetchFn: async (url) => {
        if (url.includes('/api/token')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            is_playing: true,
            progress_ms: 42000,
            item: {
              id: 'track123',
              type: 'track',
              name: 'Instant Crush',
              duration_ms: 337000,
              artists: [{ name: 'Daft Punk' }, { name: 'Julian Casablancas' }],
              album: { name: 'RAM', images: [{ url: 'https://i.scdn.co/image/64', width: 64, height: 64 }] },
            },
          }),
        };
      },
    });

    const result = await spotify.poll();
    assert.equal(result.playing, true);
    assert.equal(result.id, 'track123');
    assert.equal(result.artist, 'Daft Punk, Julian Casablancas');
    assert.deepEqual(result.art, { key: 'https://i.scdn.co/image/64', url: 'https://i.scdn.co/image/64' });

    const stored = await store.load();
    assert.equal(stored.refreshToken, 'rotated');
    assert.equal(stored.accessToken, 'fresh');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('SpotifySource rejects an OAuth callback with a missing or wrong state', async () => {
  const spotify = new SpotifySource({ clientId: 'c', clientSecret: 's', redirectUri: 'r', tokenStore: {} });
  await assert.rejects(spotify.exchangeCode('code', 'anything'), /state mismatch/);
  spotify.createAuthorizeUrl();
  await assert.rejects(spotify.exchangeCode('code', null), /state mismatch/);
  await assert.rejects(spotify.exchangeCode('code', 'wrong'), /state mismatch/);
});

test('createSources enables each source only when its credentials are set', () => {
  const names = (env) => createSources(loadConfig(env), null).map((s) => s.name);
  assert.deepEqual(names({}), []);
  assert.deepEqual(names({ PUSH_TOKEN: 't' }), ['mac']);
  assert.deepEqual(names({ SPOTIFY_CLIENT_ID: 'a' }), []);
  assert.deepEqual(names({ PUSH_TOKEN: 't', SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' }), ['mac', 'spotify']);
});

test('PushSource asks for art once per track, and art survives repeat pushes', async () => {
  const src = new PushSource({ name: 'mac', label: 'AM', accent: 1 });

  const first = src.ingest({ id: 'a', playing: true, title: 'A' });
  assert.equal(first.needArt, true);

  const second = src.ingest({ id: 'a', playing: true, title: 'A', art: Buffer.from('jpeg').toString('base64') });
  assert.equal(second.needArt, false);

  assert.equal(src.ingest({ id: 'a', playing: true, title: 'A' }).needArt, false);
  assert.equal((await src.poll()).art.buffer.toString(), 'jpeg');

  // A new track drops the old cover, and art: null records that this one has none.
  assert.equal(src.ingest({ id: 'b', playing: true, title: 'B' }).needArt, true);
  assert.equal((await src.poll()).art, null);
  assert.equal(src.ingest({ id: 'b', playing: true, title: 'B', art: null }).needArt, false);

  // Idle needs no art.
  assert.equal(src.ingest({ id: '', playing: false }).needArt, false);
  assert.throws(() => src.ingest({ id: 'c', art: 42 }), /Invalid push/);
});

test('PushSource goes idle when pushes stop and drops stale commands', async () => {
  let nowMs = 1000;
  const src = new PushSource({ name: 'am', label: 'AM', accent: 1, ttlMs: 5000, now: () => nowMs });

  assert.equal((await src.control('pause')).ok, false);

  src.ingest({ id: 'a', playing: true, title: 'A' });
  assert.equal((await src.poll()).playing, true);

  assert.equal((await src.control('pause')).ok, true);
  assert.deepEqual(src.ingest({ id: 'a', playing: true }).commands, ['pause']);
  assert.deepEqual(src.ingest({ id: 'a', playing: true }).commands, []);

  await src.control('next');
  nowMs += 11_000;
  assert.deepEqual(src.ingest({ id: 'a', playing: true }).commands, []);

  nowMs += 6000;
  assert.deepEqual(await src.poll(), { playing: false, id: '' });
  assert.equal((await src.control('play')).ok, false);
});

test('parseNowPlaying maps system Now Playing and advances elapsed time', () => {
  const state = (o) => JSON.stringify({ now: 1000, playing: true, bundleId: 'com.google.Chrome', app: 'YouTube', ...o });
  const video = parseNowPlaying(state({
    title: 'Talk', trackArtistName: 'Channel', duration: 600, elapsedTime: 100, elapsedTimeTimestamp: 990, playbackRate: 1,
  }));
  assert.deepEqual(video, {
    playing: true,
    id: ['com.google.Chrome', 'Talk', 'Channel', ''].join('\u001f'),
    title: 'Talk',
    artist: 'Channel',
    album: '',
    progressMs: 110_000,
    durationMs: 600_000,
    art: null,
  });

  // Paused: the snapshot is not advanced. No artist falls back to the app name.
  const paused = parseNowPlaying(state({ playing: false, title: 'Talk', elapsedTime: 100, elapsedTimeTimestamp: 990, playbackRate: 0 }));
  assert.equal(paused.playing, false);
  assert.equal(paused.progressMs, 100_000);
  assert.equal(paused.artist, 'YouTube');
  assert.equal(paused.durationMs, 1);

  // 2x speed, clamped to the duration
  assert.equal(parseNowPlaying(state({ title: 'T', duration: 105, elapsedTime: 100, elapsedTimeTimestamp: 990, playbackRate: 2 })).progressMs, 105_000);

  for (const output of [state({}), state({ title: '  ' }), 'garbage', '']) {
    assert.deepEqual(parseNowPlaying(output), { playing: false, id: '' });
  }
});

test('pickActive prefers the latest started source, then list order, and keeps a paused current', () => {
  const entry = (name, playing, startedSeq = 0) => ({ source: { name }, startedSeq, track: { id: `${name}_1`, playing } });

  assert.equal(pickActive([]), null);
  assert.equal(pickActive([{ source: { name: 'a' }, startedSeq: 0, track: { id: '', playing: false } }]), null);

  assert.equal(pickActive([entry('a', true), entry('b', true)]).source.name, 'a');
  assert.equal(pickActive([entry('a', true, 1), entry('b', true, 2)]).source.name, 'b');
  assert.equal(pickActive([entry('a', true, 2), entry('b', false, 3)]).source.name, 'a');

  assert.equal(pickActive([entry('a', false), entry('b', false)], 'b').source.name, 'b');
  assert.equal(pickActive([entry('a', false), entry('b', false)], 'gone').source.name, 'a');
});

test('SourceManager hands the clock to whichever source starts most recently', async () => {
  const a = new FakeSource('a');
  const b = new FakeSource('b');
  const { manager } = makeManager([a, b]);

  a.result = track('1');
  await manager.triggerPoll('a');
  await manager.triggerPoll('b');
  assert.equal(manager.getSnapshot().source, 'a');

  b.result = track('2');
  await manager.triggerPoll('b');
  assert.equal(manager.getSnapshot().source, 'b');

  // A's track change is not a new start, so it doesn't take the clock back.
  a.result = track('3');
  await manager.triggerPoll('a');
  assert.equal(manager.getSnapshot().source, 'b');

  // B pausing returns the clock to A, which is still playing.
  b.result = track('2', { playing: false });
  await manager.triggerPoll('b');
  assert.equal(manager.getSnapshot().source, 'a');

  // A pausing and resuming counts as a new start, and takes over from B once B plays again.
  b.result = track('2');
  await manager.triggerPoll('b');
  a.result = track('3', { playing: false });
  await manager.triggerPoll('a');
  a.result = track('3');
  await manager.triggerPoll('a');
  assert.equal(manager.getSnapshot().source, 'a');
  manager.stop();
});

test('SourceManager keeps state through brief failures and goes idle after repeated ones', async () => {
  const a = new FakeSource('a');
  const { manager } = makeManager([a], { maxFailures: 3 });
  a.result = track('1');
  await manager.triggerPoll('a');

  a.result = new Error('network down');
  await manager.triggerPoll('a');
  await manager.triggerPoll('a');
  assert.equal(manager.getSnapshot().playing, true);
  assert.equal((await manager.sourceStatuses())[0].lastError, 'network down');

  await manager.triggerPoll('a');
  assert.equal(manager.getSnapshot().playing, false);
  // The last title stays for the pause grace period instead of blanking at once.
  assert.equal(manager.getSnapshot().title, 'Title 1');

  a.result = track('1');
  await manager.triggerPoll('a');
  assert.equal((await manager.sourceStatuses())[0].lastError, null);
  assert.equal(manager.getSnapshot().playing, true);
  manager.stop();
});

test('SourceManager keeps prior state when a source returns null (rate limited)', async () => {
  const a = new FakeSource('a');
  const { manager } = makeManager([a]);
  a.result = track('1');
  await manager.triggerPoll('a');
  a.result = null;
  await manager.triggerPoll('a');
  assert.equal(manager.getSnapshot().playing, true);
  manager.stop();
});

test('SourceManager publishes text first, then art, and applies the art accent', async () => {
  const a = new FakeSource('a', { accent: 0x111111 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const artwork = {
    getArtwork: async () => {
      await gate;
      return { pixels: new Array(256).fill(7), accent: 0x222222 };
    },
  };
  const { manager } = makeManager([a], { artwork });

  a.result = track('1', { art: { key: 'k', buffer: Buffer.alloc(1) } });
  await manager.triggerPoll('a');
  assert.equal(manager.getSnapshot().art, null);
  assert.equal(manager.getSnapshot().accent, 0x111111);

  release();
  await flush();
  assert.equal(manager.getSnapshot().art.length, 256);
  assert.equal(manager.getSnapshot().accent, 0x222222);
  manager.stop();
});

test('SourceManager discards art that finishes after the track changed, and limits retries', async () => {
  const a = new FakeSource('a');
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const artwork = {
    getArtwork: async ({ key }) => {
      calls += 1;
      if (key === 'slow') {
        await gate;
        return { pixels: new Array(256).fill(1), accent: 1 };
      }
      throw new Error('bad image');
    },
  };
  const { manager } = makeManager([a], { artwork });

  a.result = track('1', { art: { key: 'slow', buffer: Buffer.alloc(1) } });
  await manager.triggerPoll('a');
  a.result = track('2');
  await manager.triggerPoll('a');
  release();
  await flush();
  assert.equal(manager.getSnapshot().art, null);

  calls = 0;
  a.result = track('3', { art: { key: 'broken', buffer: Buffer.alloc(1) } });
  for (let i = 0; i < 6; i++) {
    await manager.triggerPoll('a');
    await flush();
  }
  assert.equal(calls, 3);
  manager.stop();
});

test('SourceManager coalesces snapshots while the clock is slow', async () => {
  const a = new FakeSource('a');
  const seen = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const manager = new SourceManager({
    sources: [a],
    artwork: {},
    onSnapshot: async (s) => {
      seen.push(s.title);
      await gate;
    },
  });

  for (const id of ['1', '2', '3', '4']) {
    a.result = track(id);
    await manager.triggerPoll('a');
  }
  release();
  await flush();
  assert.deepEqual(seen, ['Title 1', 'Title 4']);
  manager.stop();
});

test('SourceManager.control targets the active source and resolves toggle', async () => {
  const a = new FakeSource('a');
  const { manager } = makeManager([a]);

  assert.equal((await manager.control('toggle')).ok, false);

  a.result = track('1');
  await manager.triggerPoll('a');
  assert.deepEqual(await manager.control('toggle'), { ok: true, action: 'pause' });

  a.result = track('1', { playing: false });
  await manager.triggerPoll('a');
  assert.deepEqual(await manager.control('toggle'), { ok: true, action: 'play' });
  assert.deepEqual(a.controls, ['pause', 'play']);

  assert.deepEqual(await manager.control('explode'), { ok: false, error: 'Invalid action' });
  manager.stop();
});

test('AwtrixCoordinator enables app, switches on track change, and hides on pause', async () => {
  const actions = [];
  const mockClient = {
    scripts: {
      getSource: async () => null,
      install: async (name) => {
        actions.push(['install', name]);
        return {};
      },
      getConfig: async () => ({}),
      updateConfig: async (name, cfg) => {
        actions.push(['updateConfig', name, cfg.server_url]);
      },
    },
    apps: {
      setEnabled: async (name, enabled) => {
        actions.push(['setEnabled', name, enabled]);
      },
      switchTo: async (name) => {
        actions.push(['switchTo', name]);
      },
    },
  };

  const coord = new AwtrixCoordinator({
    host: '192.168.1.50',
    pauseGraceMs: 0,
    serverLanUrl: 'http://192.168.1.100:8765',
    client: mockClient,
  });

  await coord.onPlaybackState({ playing: true, id: 't1', title: 'Song 1', artist: 'Artist 1' });
  await coord.onPlaybackState({ playing: true, id: 't1', title: 'Song 1', artist: 'Artist 1' });
  await coord.onPlaybackState({ playing: true, id: 't2', title: 'Song 2', artist: 'Artist 2' });
  await coord.onPlaybackState({ playing: false, id: 't2', title: 'Song 2', artist: 'Artist 2' });

  assert.deepEqual(actions, [
    ['install', 'now-playing'],
    ['updateConfig', 'now-playing', 'http://192.168.1.100:8765'],
    ['setEnabled', 'now-playing', true],
    ['switchTo', 'now-playing'],
    ['switchTo', 'now-playing'],
    ['setEnabled', 'now-playing', false],
  ]);
  coord.dispose();
});

async function withServer(env, fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc002-srv-test-'));
  const config = loadConfig({ PORT: '0', DATA_DIR: tmpDir, SERVER_LAN_URL: 'http://192.168.1.100:8765', ...env });
  const sources = createSources(config, new TokenStore(tmpDir));
  const artwork = new ArtworkProcessor({ decodeToRgb16x16: async () => Buffer.alloc(16 * 16 * 3, 200) });
  const manager = new SourceManager({ sources, artwork });
  const awtrix = new AwtrixCoordinator({ host: '', serverLanUrl: config.serverLanUrl });
  const server = createBridgeServer({ config, manager, awtrix, sources });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, manager, sources });
  } finally {
    manager.stop();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const push = (base, token, body) =>
  fetch(`${base}/api/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('Push endpoint rejects bad tokens and malformed bodies, and is off without a token', async () => {
  await withServer({ PUSH_TOKEN: 'sekret' }, async ({ base }) => {
    assert.equal((await push(base, 'wrong', { id: 'a' })).status, 401);
    assert.equal((await fetch(`${base}/api/push`, { method: 'POST', body: '{}' })).status, 401);

    const res = await fetch(`${base}/api/push`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sekret' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
  });

  await withServer({}, async ({ base }) => {
    assert.equal((await push(base, 'anything', { id: 'a' })).status, 404);
  });
});

test('A pushed track reaches the clock payload, with art deltas and hasArt', async () => {
  await withServer({ PUSH_TOKEN: 'sekret' }, async ({ base }) => {
    const nowPlaying = async (trackId = '') => (await fetch(`${base}/api/now-playing?track=${trackId}`)).json();

    const res = await push(base, 'sekret', {
      id: 'PID:1',
      playing: true,
      title: 'Hoppípolla',
      artist: 'Sigur Rós',
      progressMs: 1000,
      durationMs: 60000,
    });
    assert.equal((await res.json()).needArt, true);
    await flush();

    const textOnly = await nowPlaying();
    assert.equal(textOnly.source, 'mac');
    assert.equal(textOnly.title, 'Hoppipolla');
    assert.equal(textOnly.artist, 'Sigur Ros');
    assert.match(textOnly.id, /^mac_[0-9a-f]{16}$/);
    assert.equal(textOnly.hasArt, false);
    assert.equal(textOnly.art, undefined);

    await push(base, 'sekret', { id: 'PID:1', playing: true, title: 'Hoppípolla', art: Buffer.from('x').toString('base64') });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const withArt = await nowPlaying();
    assert.equal(withArt.hasArt, true);
    assert.equal(withArt.art.length, 256);

    const delta = await nowPlaying(withArt.id);
    assert.equal(delta.hasArt, true);
    assert.equal(delta.art, undefined);

    // A track with no cover tells the clock to drop the previous one.
    await push(base, 'sekret', { id: 'PID:2', playing: true, title: 'No Cover', art: null });
    await flush();
    const noCover = await nowPlaying(withArt.id);
    assert.equal(noCover.title, 'No Cover');
    assert.equal(noCover.hasArt, false);
  });
});

test('Clock actions queue for the agent, and return 409 with nothing to control', async () => {
  await withServer({ PUSH_TOKEN: 'sekret' }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/action/toggle`)).status, 409);

    await push(base, 'sekret', { id: 'a', playing: true, title: 'A' });
    await flush();

    assert.equal((await fetch(`${base}/api/action/explode`)).status, 400);
    const res = await fetch(`${base}/api/action/toggle`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).action, 'pause');

    const pushed = await (await push(base, 'sekret', { id: 'a', playing: true, title: 'A', art: null })).json();
    assert.deepEqual(pushed.commands, ['pause']);
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
});

test('Dashboard renders with no sources and escapes source errors', async () => {
  await withServer({}, async ({ base }) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /No sources enabled/);
    assert.ok(!html.includes('/auth/login'));
    assert.equal((await fetch(`${base}/auth/login`)).status, 404);
  });

  await withServer({ PUSH_TOKEN: 't', SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' }, async ({ base, manager }) => {
    manager.entries[0].lastError = '<img src=x>';
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Mac Now Playing/);
    assert.match(html, /Connect Spotify/);
    assert.ok(html.includes('&lt;img src=x&gt;'));
    assert.ok(!html.includes('<img src=x>'));
  });
});

test('Default accent is exposed before any source has played', async () => {
  await withServer({}, async ({ base }) => {
    const body = await (await fetch(`${base}/api/now-playing`)).json();
    assert.equal(body.accent, DEFAULT_ACCENT);
    assert.equal(body.id, '');
    assert.equal(body.hasArt, false);
  });
});

test('Berry script passes structural balance & AWTRIX NG conventions check', async () => {
  const src = await fs.readFile(path.resolve(__dirname, '../berry/now_playing.be'), 'utf8');

  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    assert.ok(!trimmed.startsWith('//'), `Berry script must use # comments, found: ${trimmed}`);
  }

  const stripped = src
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').replace(/"[^"]*"/g, '""'))
    .join('\n');

  const openers = (stripped.match(/\b(class|def|if|for|while|try)\b/g) || []).length;
  const closers = (stripped.match(/\bend\b/g) || []).length;
  assert.equal(openers, closers, `Unbalanced Berry blocks: ${openers} openers vs ${closers} 'end's`);
  assert.match(src, /return NowPlaying\(\)/);
  assert.match(src, /hasArt/);
});
