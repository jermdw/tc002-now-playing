import { loadConfig } from './config.js';
import { TokenStore } from './store.js';
import { createSources } from './sources/index.js';
import { ArtworkProcessor } from './artwork.js';
import { AwtrixCoordinator } from './awtrix.js';
import { SourceManager } from './manager.js';
import { createBridgeServer } from './server.js';

async function main() {
  const config = loadConfig();
  const sources = createSources(config, new TokenStore(config.dataDir));

  if (sources.length === 0) {
    console.warn('[now-playing] No sources enabled. Set PUSH_TOKEN and/or the SPOTIFY_* variables in .env.');
  }

  const artwork = new ArtworkProcessor({
    gamma: config.display.ledGamma,
    saturation: config.display.ledSaturation,
  });

  const awtrix = new AwtrixCoordinator({
    host: config.awtrix.host,
    port: config.awtrix.port,
    username: config.awtrix.username,
    password: config.awtrix.password,
    appName: config.awtrix.appName,
    autoInstallScript: config.awtrix.autoInstallScript,
    switchOnTrackChange: config.awtrix.switchOnTrackChange,
    pauseGraceMs: config.polling.pauseGraceMs,
    serverLanUrl: config.serverLanUrl,
    pollActiveMs: config.polling.activeMs,
  });

  const manager = new SourceManager({
    sources,
    artwork,
    onSnapshot: (snapshot) => awtrix.onPlaybackState(snapshot),
    activeMs: config.polling.activeMs,
    idleMs: config.polling.idleMs,
    asciiTransliterate: config.display.asciiTransliterate,
  });

  const server = createBridgeServer({ config, manager, awtrix, sources });

  server.listen(config.port, '0.0.0.0', async () => {
    console.log(`[now-playing] Dashboard & API listening on http://127.0.0.1:${config.port}`);
    console.log(`[now-playing] TC002 LAN endpoint: ${config.serverLanUrl}/api/now-playing`);
    console.log(`[now-playing] Sources: ${sources.map((s) => s.label).join(', ') || 'none'}`);

    await awtrix.ensureScriptInstalled();
    await manager.start();
  });

  let stopped = false;
  function shutdown(signal) {
    if (stopped) return;
    stopped = true;
    console.log(`[now-playing] Caught ${signal}, shutting down...`);
    manager.stop();
    awtrix.dispose();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[now-playing] Fatal startup error:', err);
  process.exit(1);
});
