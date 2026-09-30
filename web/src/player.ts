import { useEffect, useState } from 'preact/hooks';
import { streamUrl, trackCoverUrl, type Album, type Track } from './api';
import { countPlay, resumePosition, saveProgress, usesSermonPlayer } from './me';
import { isDownloaded, readDownload, ready as offlineReady } from './offline';
import { PRELOAD_LEAD_SECONDS, Preloader } from './preload';
import { Queue, type QueueState, type RepeatMode } from './queue';

/** Jeder Eintrag ist ein eigenes Objekt, damit derselbe Titel mehrfach in der Warteschlange stehen kann. */
export interface Entry {
  key: number;
  track: Track;
  /** Wo die Wiedergabe gestartet wurde, z. B. eine Playlist; führt beim Antippen dorthin zurück */
  from?: PlaybackContext;
}

/** Herkunft eines Titels in der Warteschlange, wenn sie vom Album des Titels abweicht */
export interface PlaybackContext {
  title: string;
  href: string;
}

/** Eigene (zusammengestellte) Alben sind Playlists: Titel darin gehören zu anderen Alben. */
export function albumContext(album: Pick<Album, 'id' | 'title' | 'kind'>): PlaybackContext | undefined {
  return album.kind === 'manual' ? { title: album.title, href: `/album/${album.id}` } : undefined;
}

/** Ziel beim Antippen des laufenden Titels: die Playlist, aus der er läuft, sonst sein Album */
export function currentHref(track: Track, from: PlaybackContext | undefined): string | undefined {
  return from?.href ?? (track.albumId ? `/album/${track.albumId}` : undefined);
}

export interface PlayerState {
  current: Track | undefined;
  /** Herkunft des laufenden Titels (Playlist), falls vorhanden */
  from: PlaybackContext | undefined;
  currentKey: number | undefined;
  queue: Entry[];
  index: number;
  playing: boolean;
  loading: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Wiedergabetempo für lange Titel (Predigten); Musik läuft immer normal */
  rate: number;
  error: string | undefined;
}

export const RATES = [1, 1.25, 1.5, 1.75, 2];
/** Wie oft der Hörstand langer Titel beim Server landet */
const PROGRESS_INTERVAL_MS = 15_000;
/** Als gehört zählt ein Titel nach so vielen Sekunden, kurze Titel schon nach der Hälfte. */
const PLAY_COUNT_SECONDS = 30;

const STORAGE_KEY = 'gemeinde.player';
let nextKey = 1;
const entries = (tracks: Track[], from?: PlaybackContext): Entry[] =>
  tracks.map((track) => (from ? { key: nextKey++, track, from } : { key: nextKey++, track }));

function load(): { queue?: QueueState<Entry>; volume?: number; muted?: boolean; position?: number; rate?: number } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export class Player {
  readonly audio: HTMLAudioElement;
  private readonly queue = new Queue<Entry>();
  private readonly listeners = new Set<() => void>();
  private state: PlayerState;
  private saveTimer: number | undefined;
  /** Kopie der Warteschlange, nur bei Änderungen neu, damit Abonnenten sie vergleichen können */
  private queueCopy: Entry[] = [];
  private queueDirty = true;
  private rate = 1;
  /** Entschlüsselte Offline-Kopie des aktuellen Titels; Zähler verwirft veraltete Ladevorgänge */
  private blobUrl: string | undefined;
  private sourceToken = 0;
  private offlineChecked = false;
  /** Nächster Titel, kurz vor dem Ende des aktuellen schon im Speicher */
  private readonly preloader = new Preloader({ isDownloaded, readDownload });
  /** Titel, der gerade im Audio-Element steckt, und wann sein Hörstand zuletzt gespeichert wurde */
  private loaded:
    | {
        track: Track;
        savedAt: number;
        recorded: boolean;
        start?: number;
        /** Tatsächlich gehörte Sekunden (Springen zählt nicht) und ob die Wiedergabe schon gemeldet ist */
        heard: number;
        lastTime?: number;
        counted: boolean;
      }
    | undefined;

  constructor(audio: HTMLAudioElement = new Audio()) {
    this.audio = audio;
    audio.preload = 'auto';
    const saved = load();
    if (saved.queue?.items?.length) {
      this.queue.restore({
        ...saved.queue,
        items: saved.queue.items.map((item) => ({ ...item, key: nextKey++ })),
      });
    }
    audio.volume = saved.volume ?? 1;
    audio.muted = saved.muted ?? false;
    this.rate = RATES.includes(saved.rate ?? 1) ? (saved.rate ?? 1) : 1;
    this.state = this.compute();
    void offlineReady.then(() => (this.offlineChecked = true));

    const current = this.queue.current;
    if (current) {
      // Nach dem Neuladen an derselben Stelle weitermachen, aber nicht von selbst losspielen.
      void this.setSource(current.track);
      this.loaded = { track: current.track, savedAt: Date.now(), recorded: true, heard: 0, counted: false };
      this.applyRate();
      if (saved.position) {
        audio.addEventListener('loadedmetadata', () => (audio.currentTime = saved.position!), { once: true });
      }
      this.updateMediaSession();
    }

    const update = () => this.emit();
    for (const name of ['play', 'pause', 'timeupdate', 'durationchange', 'volumechange', 'loadstart', 'canplay', 'playing']) {
      audio.addEventListener(name, update);
    }
    audio.addEventListener('waiting', () => this.emit({ loading: true }));
    audio.addEventListener('ended', () => this.advance(true));
    audio.addEventListener('durationchange', () => this.applyRate());
    // Hörstand: beim Start (für "Zuletzt gehört"), bei Pause und bei langen Titeln regelmäßig
    audio.addEventListener('playing', () => {
      if (this.loaded && !this.loaded.recorded) this.saveProgress();
    });
    audio.addEventListener('pause', () => this.saveProgress());
    audio.addEventListener('timeupdate', () => {
      const loaded = this.loaded;
      if (loaded && !audio.paused && this.long() && Date.now() - loaded.savedAt > PROGRESS_INTERVAL_MS) this.saveProgress();
      this.trackHeard();
    });
    // Nach einem Sprung von der neuen Stelle aus weiterzählen
    audio.addEventListener('seeking', () => {
      if (this.loaded) this.loaded.lastTime = undefined;
    });
    audio.addEventListener('error', () => {
      if (!audio.src) return;
      this.emit({ error: 'Titel konnte nicht geladen werden' });
    });
    this.setupMediaSession();
  }

  getState(): PlayerState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Liste abspielen, beginnend bei `start` */
  playList(tracks: Track[], start = 0, options: { shuffle?: boolean; from?: PlaybackContext } = {}): void {
    if (!tracks.length) return;
    this.queue.set(entries(tracks, options.from), start, options.shuffle ?? this.queue.shuffle);
    this.queueDirty = true;
    this.loadCurrent(true);
  }

  playNext(tracks: Track[], from?: PlaybackContext): void {
    const wasEmpty = !this.queue.current;
    this.queue.playNext(entries(tracks, from));
    this.queueDirty = true;
    if (wasEmpty) this.loadCurrent(true);
    else this.emit();
  }

  append(tracks: Track[], from?: PlaybackContext): void {
    const wasEmpty = !this.queue.current;
    this.queue.append(entries(tracks, from));
    this.queueDirty = true;
    if (wasEmpty) this.loadCurrent(true);
    else this.emit();
  }

  toggle(): void {
    if (!this.queue.current) return;
    if (this.audio.paused) void this.play();
    else this.audio.pause();
  }

  next(): void {
    this.advance(false);
  }

  previous(): void {
    // Wie gewohnt: nach den ersten Sekunden springt "Zurück" an den Anfang des Titels.
    if (this.audio.currentTime > 3 || this.queue.index <= 0 && this.queue.repeat !== 'all') {
      this.audio.currentTime = 0;
      return;
    }
    this.queue.previous();
    this.loadCurrent(!this.audio.paused);
  }

  jump(index: number): void {
    if (this.queue.jump(index)) this.loadCurrent(true);
  }

  remove(index: number): void {
    this.queue.remove(index);
    this.queueDirty = true;
    this.emit();
  }

  clearUpcoming(): void {
    this.queue.clearUpcoming();
    this.queueDirty = true;
    this.emit();
  }

  /**
   * Beim Abmelden: Hörstand sichern, anhalten und Warteschlange samt gespeichertem Stand vergessen,
   * damit auf einem geteilten Gerät die nächste Person nicht sieht, was zuletzt lief.
   */
  reset(): void {
    this.saveProgress();
    this.audio.pause();
    this.sourceToken++;
    this.audio.removeAttribute('src');
    this.audio.load();
    this.releaseBlob();
    this.preloader.clear();
    this.loaded = undefined;
    this.queue.set([]);
    this.queueDirty = true;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.state = this.compute({ error: undefined });
    this.queueDirty = false;
    for (const listener of this.listeners) listener();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Gesperrter Speicher: nichts zu löschen.
    }
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  seek(seconds: number): void {
    if (Number.isFinite(seconds)) this.audio.currentTime = Math.max(0, seconds);
  }

  /** Relativ springen, z. B. 15 Sekunden zurück oder 30 vor */
  skip(seconds: number): void {
    if (!this.queue.current) return;
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity;
    this.seek(Math.min(duration - 0.5, Math.max(0, this.audio.currentTime + seconds)));
  }

  /** Nächstes Tempo (1× bis 2×); gilt für lange Titel wie Predigten */
  cycleRate(): void {
    this.rate = RATES[(RATES.indexOf(this.rate) + 1) % RATES.length]!;
    this.applyRate();
    this.emit();
  }

  /** Predigten (laut Policies, sonst lange Titel) bekommen Sprünge, Tempo und Weiterhören */
  private long(): boolean {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : this.queue.current?.track.duration;
    return usesSermonPlayer(this.queue.current?.track, duration);
  }

  private applyRate(): void {
    const rate = this.long() ? this.rate : 1;
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
  }

  /** Gehörte Zeit sammeln und die Wiedergabe einmal melden, sobald genug gehört ist. */
  private trackHeard(): void {
    const loaded = this.loaded;
    const time = this.audio.currentTime;
    if (!loaded || loaded.counted || !Number.isFinite(time)) return;
    if (!this.audio.paused && !this.audio.seeking && loaded.lastTime !== undefined) {
      const step = time - loaded.lastTime;
      // timeupdate kommt etwa viermal pro Sekunde; größere Schritte sind Sprünge
      if (step > 0 && step < 2 * this.audio.playbackRate + 1) loaded.heard += step;
    }
    loaded.lastTime = time;
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : (loaded.track.duration ?? 0);
    const needed = duration > 0 ? Math.min(PLAY_COUNT_SECONDS, duration / 2) : PLAY_COUNT_SECONDS;
    if (loaded.heard >= needed) {
      loaded.counted = true;
      countPlay(loaded.track);
    }
  }

  private saveProgress(): void {
    const loaded = this.loaded;
    let position = this.audio.currentTime;
    if (!loaded || !Number.isFinite(position) || (position === 0 && loaded.recorded)) return;
    // Der Sprung an die gemerkte Stelle kann noch ausstehen: dann die nicht mit 0 überschreiben.
    if (!loaded.recorded && loaded.start !== undefined && position < 1) position = loaded.start;
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : loaded.track.duration;
    loaded.savedAt = Date.now();
    loaded.recorded = true;
    saveProgress({ id: loaded.track.id, duration, player: loaded.track.player }, this.audio.ended ? (duration ?? position) : position);
  }

  setVolume(volume: number): void {
    this.audio.volume = Math.min(1, Math.max(0, volume));
    if (volume > 0) this.audio.muted = false;
  }

  toggleMute(): void {
    this.audio.muted = !this.audio.muted;
  }

  toggleShuffle(): void {
    this.queue.toggleShuffle();
    this.queueDirty = true;
    this.emit();
  }

  cycleRepeat(): void {
    this.queue.cycleRepeat();
    this.emit();
  }

  private advance(auto: boolean): void {
    const wasPlaying = auto || !this.audio.paused;
    const next = this.queue.next(auto);
    if (!next) {
      // Ende der Warteschlange: anhalten und an den Anfang des letzten Titels.
      this.audio.pause();
      this.audio.currentTime = 0;
      this.emit();
      return;
    }
    this.loadCurrent(wasPlaying);
  }

  private loadCurrent(autoplay: boolean): void {
    const current = this.queue.current;
    if (!current) return;
    // Stand des bisherigen Titels sichern, bevor er ausgetauscht wird.
    if (this.loaded && this.loaded.track.id !== current.track.id) this.saveProgress();
    const source = this.setSource(current.track);
    // Angefangene Predigt: an der gemerkten Stelle weiter
    const start = resumePosition(current.track);
    this.loaded = { track: current.track, savedAt: Date.now(), recorded: false, start, heard: 0, counted: false };
    this.applyRate();
    if (start !== undefined) {
      this.audio.addEventListener('loadedmetadata', () => (this.audio.currentTime = start), { once: true });
    }
    this.state = { ...this.state, error: undefined };
    // Den Stream sofort starten (iOS erlaubt play() nur direkt nach dem Tippen), die Offline-Kopie nach dem Entschlüsseln.
    if (autoplay) void (source ? source.then((ok) => (ok ? this.play() : undefined)) : this.play());
    this.updateMediaSession();
    this.emit();
  }

  /**
   * Quelle für den Titel setzen: die entschlüsselte Offline-Kopie, wenn vorhanden, sonst der Stream.
   * Ist sicher keine Kopie da, geschieht das sofort (Rückgabe undefined), sonst per Promise
   * (false, wenn inzwischen ein anderer Titel gewählt wurde).
   */
  private setSource(track: Track): Promise<boolean> | undefined {
    const token = ++this.sourceToken;
    this.releaseBlob();
    // Vorgeladen (aus dem Netz oder schon entschlüsselt): sofort, auch für play() direkt nach 'ended'.
    const preloaded = this.preloader.take(track.id);
    if (preloaded) {
      this.audio.src = this.blobUrl = URL.createObjectURL(preloaded);
      return undefined;
    }
    if (this.offlineChecked && !isDownloaded(track.id)) {
      this.audio.src = streamUrl(track.id);
      return undefined;
    }
    return (async () => {
      await offlineReady;
      this.offlineChecked = true;
      const blob = isDownloaded(track.id) ? await readDownload(track.id) : undefined;
      if (token !== this.sourceToken) return false;
      if (blob) this.audio.src = this.blobUrl = URL.createObjectURL(blob);
      else this.audio.src = streamUrl(track.id);
      return true;
    })();
  }

  /**
   * Kurz vor dem Ende den nächsten Titel vorladen; ändert sich die Warteschlange, wird ein
   * vorgeladener Titel, der nicht mehr als Nächstes dran ist, verworfen.
   */
  private preloadNext(): void {
    const current = this.queue.current;
    const next = this.queue.peekNext(true);
    // Wiederholen eines Titels spielt dieselbe Quelle erneut, da gibt es nichts vorzuladen.
    const nextId = next && current && next.track.id !== current.track.id ? next.track.id : undefined;
    if (this.preloader.trackId === nextId) return;
    if (this.preloader.trackId !== undefined || nextId === undefined) {
      this.preloader.want(undefined);
      if (nextId === undefined) return;
    }
    const duration = this.audio.duration;
    if (this.audio.paused || !Number.isFinite(duration) || duration <= 0) return;
    const left = (duration - this.audio.currentTime) / (this.audio.playbackRate || 1);
    if (left <= PRELOAD_LEAD_SECONDS) this.preloader.want(nextId);
  }

  private releaseBlob(): void {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = undefined;
  }

  private async play(): Promise<void> {
    try {
      await this.audio.play();
    } catch (error) {
      // Abgebrochen durch schnelles Weiterspringen ist kein Fehler; ohne Erlaubnis zum Abspielen
      // (Offline-Kopie war nicht schnell genug entschlüsselt) reicht ein Tippen auf Abspielen.
      const name = (error as DOMException).name;
      if (name === 'NotAllowedError') this.emit();
      else if (name !== 'AbortError') this.emit({ error: 'Wiedergabe nicht möglich' });
    }
  }

  private compute(patch: Partial<PlayerState> = {}): PlayerState {
    const current = this.queue.current;
    const audio = this.audio;
    return {
      current: current?.track,
      from: current?.from,
      currentKey: current?.key,
      queue: this.queueDirty ? (this.queueCopy = [...this.queue.items]) : this.queueCopy,
      index: this.queue.index,
      playing: !audio.paused,
      loading: false,
      position: audio.currentTime || 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : (current?.track.duration ?? 0),
      volume: audio.volume,
      muted: audio.muted,
      shuffle: this.queue.shuffle,
      repeat: this.queue.repeat,
      rate: this.rate,
      error: this.state?.error,
      ...patch,
    };
  }

  private emit(patch: Partial<PlayerState> = {}): void {
    this.state = this.compute(patch);
    this.queueDirty = false;
    this.preloadNext();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.state.playing ? 'playing' : 'paused';
    for (const listener of this.listeners) listener();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            queue: this.queue.snapshot(),
            volume: this.audio.volume,
            muted: this.audio.muted,
            position: this.audio.currentTime,
            rate: this.rate,
          }),
        );
      } catch {
        // Speicher voll oder gesperrt: dann eben ohne Wiederherstellung.
      }
    }, 1000);
  }

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => void this.play()],
      ['pause', () => this.audio.pause()],
      ['nexttrack', () => this.next()],
      ['previoustrack', () => this.previous()],
      ['seekto', (details) => this.seek(details.seekTime ?? 0)],
      ['seekbackward', (details) => this.skip(-(details.seekOffset ?? 15))],
      ['seekforward', (details) => this.skip(details.seekOffset ?? 30)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Nicht jeder Browser kennt jede Aktion.
      }
    }
  }

  private updateMediaSession(): void {
    const track = this.queue.current?.track;
    if (!track || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const artwork = trackCoverUrl(track);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.speaker ?? track.album ?? '',
      album: track.album ?? '',
      artwork: artwork ? [{ src: artwork }] : [],
    });
  }
}

export const player = new Player();

export function usePlayer(): PlayerState {
  const [state, setState] = useState(player.getState());
  useEffect(() => player.subscribe(() => setState(player.getState())), []);
  return state;
}

/** Nur neu zeichnen, wenn sich der ausgewählte Wert ändert (nicht bei jedem Zeit-Update). */
export function usePlayerSelect<T>(select: (state: PlayerState) => T): T {
  const [value, setValue] = useState(() => select(player.getState()));
  useEffect(() => {
    setValue(() => select(player.getState()));
    return player.subscribe(() => setValue(() => select(player.getState())));
  }, []);
  return value;
}
