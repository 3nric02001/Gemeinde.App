import { useEffect, useState } from 'preact/hooks';
import { streamUrl, trackCoverUrl, type Track } from './api';
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
  error: string | undefined;
}

const STORAGE_KEY = 'gemeinde.player';
let nextKey = 1;
const entry = (track: Track): Entry => ({ key: nextKey++, track });

function load(): { queue?: QueueState<Entry>; volume?: number; muted?: boolean; position?: number } {
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
    this.state = this.compute();

    const current = this.queue.current;
    if (current) {
      // Nach dem Neuladen an derselben Stelle weitermachen, aber nicht von selbst losspielen.
      audio.src = streamUrl(current.track.id);
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
    this.audio.src = streamUrl(current.track.id);
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
