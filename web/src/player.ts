import { useEffect, useState } from 'preact/hooks';
import { streamUrl, trackCoverUrl, type Track } from './api';
import { isLong, resumePosition, saveProgress } from './me';
import { Queue, type QueueState, type RepeatMode } from './queue';

/** Jeder Eintrag ist ein eigenes Objekt, damit derselbe Titel mehrfach in der Warteschlange stehen kann. */
export interface Entry {
  key: number;
  track: Track;
}

export interface PlayerState {
  current: Track | undefined;
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

const STORAGE_KEY = 'gemeinde.player';
let nextKey = 1;
const entry = (track: Track): Entry => ({ key: nextKey++, track });

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
  /** Titel, der gerade im Audio-Element steckt, und wann sein Hörstand zuletzt gespeichert wurde */
  private loaded: { track: Track; savedAt: number; recorded: boolean; start?: number } | undefined;

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

    const current = this.queue.current;
    if (current) {
      // Nach dem Neuladen an derselben Stelle weitermachen, aber nicht von selbst losspielen.
      audio.src = streamUrl(current.track.id);
      this.loaded = { track: current.track, savedAt: Date.now(), recorded: true };
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
  playList(tracks: Track[], start = 0, options: { shuffle?: boolean } = {}): void {
    if (!tracks.length) return;
    this.queue.set(tracks.map(entry), start, options.shuffle ?? this.queue.shuffle);
    this.queueDirty = true;
    this.loadCurrent(true);
  }

  playNext(tracks: Track[]): void {
    const wasEmpty = !this.queue.current;
    this.queue.playNext(tracks.map(entry));
    this.queueDirty = true;
    if (wasEmpty) this.loadCurrent(true);
    else this.emit();
  }

  append(tracks: Track[]): void {
    const wasEmpty = !this.queue.current;
    this.queue.append(tracks.map(entry));
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

  /** Lange Titel (Predigten) bekommen Sprünge, Tempo und Weiterhören */
  private long(): boolean {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : this.queue.current?.track.duration;
    return isLong(duration);
  }

  private applyRate(): void {
    const rate = this.long() ? this.rate : 1;
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
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
    saveProgress({ id: loaded.track.id, duration }, this.audio.ended ? (duration ?? position) : position);
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
    this.audio.src = streamUrl(current.track.id);
    // Angefangene Predigt: an der gemerkten Stelle weiter
    const start = resumePosition(current.track);
    this.loaded = { track: current.track, savedAt: Date.now(), recorded: false, start };
    this.applyRate();
    if (start !== undefined) {
      this.audio.addEventListener('loadedmetadata', () => (this.audio.currentTime = start), { once: true });
    }
    this.state = { ...this.state, error: undefined };
    if (autoplay) void this.play();
    this.updateMediaSession();
    this.emit();
  }

  private async play(): Promise<void> {
    try {
      await this.audio.play();
    } catch (error) {
      // Abgebrochen durch schnelles Weiterspringen ist kein Fehler.
      if ((error as DOMException).name !== 'AbortError') this.emit({ error: 'Wiedergabe nicht möglich' });
    }
  }

  private compute(patch: Partial<PlayerState> = {}): PlayerState {
    const current = this.queue.current;
    const audio = this.audio;
    return {
      current: current?.track,
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
      artist: track.artist,
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
