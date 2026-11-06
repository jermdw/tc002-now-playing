#!/usr/bin/env node
// Runs on the Mac, not in Docker: reads macOS's system-wide Now Playing and pushes it to the bridge.
// That covers any app that shows in Control Center's Now Playing: Music, Spotify, YouTube in a browser, podcasts.
//
// MediaRemote is a private framework. Since macOS 15.4 only Apple-signed processes may read it, so the
// agent goes through Apple's own osascript (JavaScript for Automation) rather than a compiled helper.
// That path can't fetch artwork, so the clock shows a music-note icon instead of a cover.
// Zero dependencies: it needs only Node 22+ and macOS's osascript.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FRAMEWORK_PRELUDE = `
ObjC.import('Foundation');
$.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/').load;
`;

// Metadata only answers through valueForKey; plain property access returns null.
const STATE_SCRIPT = `${FRAMEWORK_PRELUDE}
const R = $.NSClassFromString('MRNowPlayingRequest');
const out = { now: $.NSDate.date.timeIntervalSinceReferenceDate, playing: !!ObjC.unwrap(R.localIsPlaying) };
const item = R.localNowPlayingItem;
const md = item.isNil() ? null : item.metadata;
if (md && !md.isNil()) {
  for (const k of ['title', 'trackArtistName', 'albumName', 'duration', 'elapsedTime', 'elapsedTimeTimestamp', 'playbackRate']) {
    const v = md.valueForKey(k);
    out[k] = v.isNil() ? null : ObjC.unwrap(v);
  }
}
const player = R.localNowPlayingPlayerPath;
const client = player.isNil() ? null : player.client;
if (client && !client.isNil()) {
  out.bundleId = ObjC.unwrap(client.bundleIdentifier);
  out.app = ObjC.unwrap(client.displayName);
}
JSON.stringify(out);
`;

// MRMediaRemoteCommand values
const COMMAND_CODES = { play: 0, pause: 1, next: 4, previous: 5 };

const COMMAND_SCRIPT = `${FRAMEWORK_PRELUDE}
ObjC.bindFunction('MRMediaRemoteSendCommand', ['bool', ['int', 'id']]);
function run(argv) { return String($.MRMediaRemoteSendCommand(Number(argv[0]), $())); }
`;

const IDLE = Object.freeze({ playing: false, id: '' });

/** Converts the state script's JSON into the bridge's push payload. */
export function parseNowPlaying(output) {
  let s;
  try {
    s = JSON.parse(output);
  } catch {
    return { ...IDLE };
  }
  const title = typeof s?.title === 'string' ? s.title.trim() : '';
  if (!title) return { ...IDLE };

  const rate = Number(s.playbackRate);
  const playing = Boolean(s.playing) || rate > 0;

  // elapsedTime is a snapshot taken at elapsedTimeTimestamp, so advance it by the time since then.
  let elapsed = Number(s.elapsedTime) || 0;
  const stamp = Number(s.elapsedTimeTimestamp);
  const now = Number(s.now);
  if (playing && stamp > 0 && now > stamp) elapsed += (now - stamp) * (rate > 0 ? rate : 1);

  const durationMs = Math.round((Number(s.duration) || 0) * 1000);
  let progressMs = Math.max(0, Math.round(elapsed * 1000));
  if (durationMs > 0) progressMs = Math.min(progressMs, durationMs);

  const artist = typeof s.trackArtistName === 'string' ? s.trackArtistName : '';
  const album = typeof s.albumName === 'string' ? s.albumName : '';
  return {
    playing,
    // The bridge hashes this, so it only has to change when the item does.
    id: [s.bundleId ?? '', title, artist, album].join('\u001f'),
    title,
    // Browsers often send no artist, so fall back to the app's name: "YouTube", "Safari".
    artist: artist || (typeof s.app === 'string' ? s.app : ''),
    album,
    progressMs,
    durationMs: durationMs || 1,
    art: null,
  };
}

async function readNowPlaying() {
  const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', STATE_SCRIPT], { timeout: 5000 });
  return parseNowPlaying(stdout);
}

async function runCommand(action) {
  const code = COMMAND_CODES[action];
  if (code === undefined) return;
  await run('osascript', ['-l', 'JavaScript', '-e', COMMAND_SCRIPT, String(code)], { timeout: 5000 });
}

async function pushState(bridgeUrl, token, payload) {
  const res = await fetch(`${bridgeUrl}/api/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Bridge returned HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const bridgeUrl = (process.env.BRIDGE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  const token = process.env.PUSH_TOKEN || '';
  const intervalMs = Number(process.env.PUSH_INTERVAL_MS) || 2000;
  if (!token) {
    console.error('[agent] PUSH_TOKEN is required and must match the bridge.');
    process.exit(1);
  }

  let lastProblem = '';

  async function tick() {
    let immediately = false;
    try {
      const response = await pushState(bridgeUrl, token, await readNowPlaying());
      for (const action of response.commands ?? []) {
        await runCommand(action);
        immediately = true;
      }
      if (lastProblem) console.log('[agent] Recovered');
      lastProblem = '';
    } catch (err) {
      // Log once per distinct problem: the Mac sleeping or the bridge restarting are routine.
      const problem = err.message;
      if (problem !== lastProblem) console.warn(`[agent] ${problem}`);
      lastProblem = problem;
    }
    // After a command, push again straight away so the clock reflects it.
    setTimeout(tick, immediately ? 300 : intervalMs);
  }

  console.log(`[agent] Pushing macOS Now Playing to ${bridgeUrl} every ${intervalMs}ms`);
  await tick();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
