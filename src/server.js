import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderDashboardHtml } from './dashboard.js';
import { PushSource } from './sources/push.js';
import { SpotifySource } from './sources/spotify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '../berry/now_playing.be');

const MAX_PUSH_BYTES = 512 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function readBody(req, maxBytes = 16384) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tokenMatches(provided, expected) {
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

function interpolatedProgress(snap) {
  return snap.playing
    ? Math.min(snap.durationMs, snap.progressMs + Math.max(0, Date.now() - snap.updatedAtMs))
    : snap.progressMs;
}

export function createBridgeServer({ config, manager, awtrix, sources }) {
  const spotify = sources.find((s) => s instanceof SpotifySource) ?? null;
  const pushSource = sources.find((s) => s instanceof PushSource) ?? null;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname;

      if (pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/now-playing' && req.method === 'GET') {
        const clientTrackId = url.searchParams.get('track') || '';
        const snap = manager.getSnapshot();
        const payload = {
          playing: snap.playing,
          source: snap.source,
          id: snap.id,
          title: snap.title,
          artist: snap.artist,
          progressMs: interpolatedProgress(snap),
          durationMs: snap.durationMs,
          accent: snap.accent,
          hasArt: Boolean(snap.art),
        };
        if (snap.art && snap.id && snap.id !== clientTrackId) {
          payload.art = snap.art;
        }
        return sendJson(res, 200, payload);
      }

      if (pathname === '/api/preview' && req.method === 'GET') {
        const snap = manager.getSnapshot();
        return sendJson(res, 200, { ...snap, progressMs: interpolatedProgress(snap) });
      }

      if (pathname === '/api/push' && req.method === 'POST') {
        if (!pushSource) {
          return sendJson(res, 404, { error: 'Push source disabled; set PUSH_TOKEN' });
        }
        const provided = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!tokenMatches(provided, config.push.token)) {
          return sendJson(res, 401, { error: 'Invalid push token' });
        }

        let body;
        try {
          body = JSON.parse(await readBody(req, MAX_PUSH_BYTES));
          const response = pushSource.ingest(body);
          manager.triggerPoll(pushSource.name).catch(() => {});
          return sendJson(res, 200, response);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname.startsWith('/api/action/')) {
        const result = await manager.control(pathname.slice('/api/action/'.length));
        if (!result.ok) {
          return sendJson(res, result.error === 'Invalid action' ? 400 : 409, result);
        }
        setTimeout(() => {
          manager.triggerPoll().catch(() => {});
        }, 250);
        return sendJson(res, 200, result);
      }

      if (pathname === '/berry/now_playing.be' && req.method === 'GET') {
        const content = await fs.readFile(SCRIPT_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(content);
      }

      if (spotify && pathname === '/auth/login' && req.method === 'GET') {
        return redirect(res, spotify.createAuthorizeUrl());
      }

      if (spotify && pathname === '/callback' && req.method === 'GET') {
        const errParam = url.searchParams.get('error');
        if (errParam) {
          return redirect(res, '/?error=' + encodeURIComponent(`Spotify authorization declined: ${errParam}`));
        }
        await spotify.exchangeCode(url.searchParams.get('code'), url.searchParams.get('state'));
        manager.triggerPoll(spotify.name).catch(() => {});
        return redirect(res, '/?msg=' + encodeURIComponent('Spotify connected! Play a song to see it on your TC002.'));
      }

      if (spotify && pathname === '/auth/manual-callback' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const parsedUrl = new URL((form.get('callbackUrl') || '').trim());
        await spotify.exchangeCode(parsedUrl.searchParams.get('code'), parsedUrl.searchParams.get('state'));
        manager.triggerPoll(spotify.name).catch(() => {});
        return redirect(res, '/?msg=' + encodeURIComponent('Spotify connected via manual callback!'));
      }

      if (spotify && pathname === '/auth/logout' && req.method === 'POST') {
        await spotify.tokenStore.clear();
        return redirect(res, '/?msg=' + encodeURIComponent('Disconnected Spotify tokens.'));
      }

      if (pathname === '/' && req.method === 'GET') {
        return sendHtml(res, 200, renderDashboardHtml({
          config,
          statuses: await manager.sourceStatuses(),
          hasSpotify: Boolean(spotify),
          awtrixStatus: {
            configured: awtrix.isConfigured(),
            scriptSynced: awtrix.scriptSynced,
            lastError: awtrix.lastError,
          },
          message: url.searchParams.get('msg') || '',
          error: url.searchParams.get('error') || '',
        }));
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[server] Request error:', err.message);
      if (req.url?.startsWith('/callback') || req.url?.startsWith('/auth/')) {
        return redirect(res, '/?error=' + encodeURIComponent(err.message));
      }
      return sendJson(res, 500, { error: err.message });
    }
  });
}
