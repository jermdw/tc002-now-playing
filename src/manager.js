import { safeTrackId, sanitizeMatrixText } from './text.js';

export const PLAYBACK_ACTIONS = ['play', 'pause', 'next', 'previous'];
export const DEFAULT_ACCENT = 0x5b8def;

const MAX_ART_ATTEMPTS = 3;
const IDLE_TRACK = { playing: false, id: '' };

/**
 * Chooses the source to display. The most recently started playing source wins, so starting
 * music somewhere takes over the clock; a track change doesn't count as a start. startedSeq ties
 * (sources already playing at boot) fall back to list order. With nothing playing, the current
 * source stays on so a paused track remains visible until the clock hides it.
 */
export function pickActive(entries, currentName = null) {
  const playing = entries.filter((e) => e.track?.playing && e.track.id);
  if (playing.length > 0) {
    return playing.reduce((best, e) => (e.startedSeq > best.startedSeq ? e : best));
  }
  const withTrack = entries.filter((e) => e.track?.id);
  return withTrack.find((e) => e.source.name === currentName) || withTrack[0] || null;
}

export class SourceManager {
  constructor({
    sources,
    artwork,
    onSnapshot = async () => {},
    activeMs = 2000,
    idleMs = 5000,
    maxFailures = 3,
    asciiTransliterate = true,
  }) {
    this.entries = sources.map((source) => ({
      source,
      track: null,
      startedSeq: 0,
      polledOnce: false,
      failures: 0,
      lastError: null,
      artFor: '',
      art: null,
      artAttempts: 0,
      artPending: false,
      timer: null,
      inFlight: false,
    }));
    this.artwork = artwork;
    this.onSnapshot = onSnapshot;
    this.activeMs = activeMs;
    this.idleMs = idleMs;
    this.maxFailures = maxFailures;
    this.asciiTransliterate = asciiTransliterate;

    this.seq = 0;
    this.stopped = true;
    this.activeName = null;
    this.snapshot = {
      source: '',
      sourceLabel: '',
      playing: false,
      id: '',
      title: 'Now Playing',
      artist: 'Idle',
      album: '',
      progressMs: 0,
      durationMs: 1,
      accent: DEFAULT_ACCENT,
      art: null,
      updatedAtMs: Date.now(),
    };

    this.emitting = false;
    this.pendingEmit = null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  start() {
    this.stopped = false;
    return Promise.all(this.entries.map((entry) => this._pollEntry(entry)));
  }

  stop() {
    this.stopped = true;
    for (const entry of this.entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /** Polls now rather than at the next tick; used after a push or a playback action. */
  async triggerPoll(name = this.activeName) {
    const entry = this.entries.find((e) => e.source.name === name);
    if (entry) await this._pollEntry(entry);
  }

  async control(action) {
    const entry = this.entries.find((e) => e.source.name === this.activeName);
    if (!entry) return { ok: false, error: 'Nothing is playing' };
    if (!entry.source.canControl) {
      return { ok: false, error: `${entry.source.label} does not support playback control` };
    }

    const resolved = action === 'toggle' ? (this.snapshot.playing ? 'pause' : 'play') : action;
    if (!PLAYBACK_ACTIONS.includes(resolved)) return { ok: false, error: 'Invalid action' };

    try {
      const result = await entry.source.control(resolved);
      return { ...result, action: resolved };
    } catch (err) {
      return { ok: false, error: err.message, action: resolved };
    }
  }

  async _pollEntry(entry) {
    if (entry.inFlight) return;
    entry.inFlight = true;

    try {
      if (await entry.source.isReady()) {
        const track = await entry.source.poll();
        if (track) {
          entry.failures = 0;
          entry.lastError = null;
          this._applyTrack(entry, track);
          this._publish();
        }
      }
    } catch (err) {
      // A brief outage shouldn't blank the clock, or count as a restart when the source returns.
      entry.failures += 1;
      entry.lastError = err.message;
      console.warn(`[${entry.source.name}] Poll error: ${err.message}`);
      if (entry.failures >= this.maxFailures) {
        this._applyTrack(entry, IDLE_TRACK);
        this._publish();
      }
    } finally {
      entry.inFlight = false;
      this._schedule(entry);
    }
  }

  _schedule(entry) {
    if (this.stopped) return;
    if (entry.timer) clearTimeout(entry.timer);
    const delay = entry.track?.playing ? this.activeMs : this.idleMs;
    entry.timer = setTimeout(() => this._pollEntry(entry), delay);
    entry.timer.unref?.();
  }

  _applyTrack(entry, raw) {
    const clean = (value) => sanitizeMatrixText(value, { asciiTransliterate: this.asciiTransliterate });
    const id = safeTrackId(entry.source.name, raw.id);
    const playing = Boolean(raw.playing && id);

    if (playing && !entry.track?.playing) {
      entry.startedSeq = entry.polledOnce ? ++this.seq : 0;
    }
    entry.polledOnce = true;

    if (id !== entry.artFor) {
      entry.artFor = id;
      entry.art = null;
      entry.artAttempts = 0;
    }

    entry.track = {
      id,
      playing,
      title: clean(raw.title),
      artist: clean(raw.artist),
      album: clean(raw.album),
      progressMs: raw.progressMs ?? 0,
      durationMs: raw.durationMs ?? 1,
      artRef: raw.art ?? null,
    };
  }

  _publish({ loadArt = true } = {}) {
    const active = pickActive(this.entries, this.activeName);
    this.activeName = active?.source.name ?? null;

    if (!active) {
      if (this.snapshot.playing) {
        this.snapshot = { ...this.snapshot, playing: false, updatedAtMs: Date.now() };
      }
      this._emit(this.snapshot);
      return;
    }

    const { source, track, art } = active;
    // Publish text at once; art follows on the next clock poll rather than delaying the new title.
    this.snapshot = {
      source: source.name,
      sourceLabel: source.label,
      playing: track.playing,
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      progressMs: track.progressMs,
      durationMs: track.durationMs,
      accent: art?.accent ?? source.accent ?? DEFAULT_ACCENT,
      art: art?.pixels ?? null,
      updatedAtMs: Date.now(),
    };
    this._emit(this.snapshot);

    if (loadArt && track.artRef && !art && !active.artPending && active.artAttempts < MAX_ART_ATTEMPTS) {
      this._loadArt(active, track);
    }
  }

  async _loadArt(entry, track) {
    entry.artPending = true;
    entry.artAttempts += 1;
    try {
      const art = await this.artwork.getArtwork(track.artRef);
      if (entry.track?.id === track.id) entry.art = art;
    } catch (err) {
      console.warn(`[artwork] Failed processing cover art: ${err.message}`);
    } finally {
      entry.artPending = false;
      this._publish({ loadArt: false });
    }
  }

  /** Coalesces updates: an offline clock takes seconds per call, and polls mustn't queue behind it. */
  async _emit(snapshot) {
    this.pendingEmit = snapshot;
    if (this.emitting) return;

    this.emitting = true;
    while (this.pendingEmit) {
      const next = this.pendingEmit;
      this.pendingEmit = null;
      try {
        await this.onSnapshot(next);
      } catch (err) {
        console.warn(`[manager] Snapshot handler failed: ${err.message}`);
      }
    }
    this.emitting = false;
  }

  async sourceStatuses() {
    return Promise.all(
      this.entries.map(async ({ source, lastError }) => ({
        name: source.name,
        label: source.label,
        active: source.name === this.activeName,
        lastError,
        ...(await source.status()),
      }))
    );
  }
}
