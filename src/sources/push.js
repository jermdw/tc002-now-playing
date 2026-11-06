const MAX_QUEUED_COMMANDS = 8;
const COMMAND_TTL_MS = 10_000;

/**
 * A source that can't be polled from the bridge, such as macOS Now Playing (Docker can't reach it).
 * An agent POSTs state to /api/push, and queued playback commands go back in the response,
 * so the agent's machine needs no inbound port.
 */
export class PushSource {
  canControl = true;

  constructor({ name, label, accent, ttlMs = 15_000, now = Date.now }) {
    this.name = name;
    this.label = label;
    this.accent = accent;
    this.ttlMs = ttlMs;
    this.now = now;

    this.state = null;
    this.lastPushMs = 0;
    this.art = null;
    this.artKnown = false;
    this.commands = [];
  }

  isOnline() {
    return this.lastPushMs > 0 && this.now() - this.lastPushMs <= this.ttlMs;
  }

  async isReady() {
    return true;
  }

  async status() {
    return this.isOnline()
      ? { ready: true, detail: 'Agent connected' }
      : { ready: false, detail: 'Waiting for agent' };
  }

  /** Throws on a malformed payload. Returns the body of the push response. */
  ingest(body) {
    const id = typeof body?.id === 'string' ? body.id.slice(0, 512) : '';
    if (body === null || typeof body !== 'object' || (body.art !== undefined && body.art !== null && typeof body.art !== 'string')) {
      throw new Error('Invalid push payload');
    }

    if (id !== this.state?.id) {
      this.art = null;
      this.artKnown = false;
    }
    if (typeof body.art === 'string') {
      this.art = { key: `${this.name}:${id}`, buffer: Buffer.from(body.art, 'base64') };
      this.artKnown = true;
    } else if (body.art === null) {
      this.art = null;
      this.artKnown = true;
    }

    this.state = {
      id,
      playing: Boolean(body.playing) && Boolean(id),
      title: String(body.title ?? '').slice(0, 300),
      artist: String(body.artist ?? '').slice(0, 300),
      album: String(body.album ?? '').slice(0, 300),
      progressMs: Math.max(0, Number(body.progressMs) || 0),
      durationMs: Math.max(1, Number(body.durationMs) || 1),
    };
    this.lastPushMs = this.now();

    const cutoff = this.now() - COMMAND_TTL_MS;
    const commands = this.commands.filter((c) => c.atMs >= cutoff).map((c) => c.action);
    this.commands = [];

    return { ok: true, needArt: Boolean(id) && !this.artKnown, commands };
  }

  async poll() {
    if (!this.state || !this.isOnline() || !this.state.id) {
      return { playing: false, id: '' };
    }
    return { ...this.state, art: this.art };
  }

  async control(action) {
    if (!this.isOnline()) {
      return { ok: false, error: `${this.label} agent is offline` };
    }
    this.commands.push({ action, atMs: this.now() });
    this.commands = this.commands.slice(-MAX_QUEUED_COMMANDS);
    return { ok: true };
  }
}
