import { PushSource } from './push.js';
import { SpotifySource } from './spotify.js';

// Neutral blue: the Mac source covers every app, so no single brand color fits.
const MAC_BLUE = 0x5b8def;

/** Each source is enabled by its credentials. List order breaks ties when several start together. */
export function createSources(config, tokenStore) {
  const sources = [];

  if (config.push.token) {
    sources.push(
      new PushSource({
        name: 'mac',
        label: 'Mac Now Playing',
        accent: MAC_BLUE,
        ttlMs: config.push.ttlMs,
      })
    );
  }

  if (config.spotify.clientId && config.spotify.clientSecret) {
    sources.push(
      new SpotifySource({
        clientId: config.spotify.clientId,
        clientSecret: config.spotify.clientSecret,
        redirectUri: config.spotify.redirectUri,
        tokenStore,
      })
    );
  }

  return sources;
}
