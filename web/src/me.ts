import { useEffect, useState } from 'preact/hooks';
import { clearCache, getJson, type Album, type Track } from './api';
import { sessionExpired } from './auth';

/**
 * Das Persönliche des angemeldeten Hörers: Favoriten und die Stelle zum Weiterhören.
 * Beides liegt auf dem Server; hier nur ein Abbild für die Oberfläche.
 */

export interface Favorites {
  tracks: Track[];
  albums: Album[];
}

export interface Progress {
  position: number;
  duration: number;
}

interface State {
  favorites: Favorites | undefined;
  trackIds: Set<number>;
  albumIds: Set<number>;
  /** Gespeicherte Stellen langer Titel mit ihrer Länge (vom Browser gemessen), je trackId */
  progress: Map<number, Progress>;
}

let state: State = { favorites: undefined, trackIds: new Set(), albumIds: new Set(), progress: new Map() };
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  if (next.favorites) {
    state.trackIds = new Set(next.favorites.tracks.map((t) => t.id));
    state.albumIds = new Set(next.favorites.albums.map((a) => a.id));
  }
  listeners.forEach((listener) => listener());
}

export function getMe(): State {
  return state;
}

export function useMe(): State {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    const update = () => setCurrent(state);
    listeners.add(update);
    update();
    return () => listeners.delete(update);
  }, []);
  return current;
}

/** Nach der Anmeldung einmal laden; Fehler sind nicht schlimm, dann fehlen eben die Herzen. */
export async function loadMe(): Promise<void> {
  const [favorites, progress] = await Promise.all([
    fetchJson<Favorites>('/api/me/favorites').catch(() => undefined),
    fetchJson<{ items: Array<Progress & { trackId: number }> }>('/api/me/progress').catch(() => undefined),
  ]);
  set({
    ...(favorites ? { favorites } : {}),
    ...(progress
      ? { progress: new Map(progress.items.map(({ trackId, position, duration }) => [trackId, { position, duration }])) }
      : {}),
  });
}

/** Nach dem Abmelden nichts vom vorigen Hörer stehen lassen. */
export function resetMe(): void {
  state = { favorites: undefined, trackIds: new Set(), albumIds: new Set(), progress: new Map() };
  listeners.forEach((listener) => listener());
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 401) sessionExpired();
  if (!res.ok) throw new Error(`Fehler ${res.status}`);
  return (await res.json()) as T;
}

async function send(method: 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: true,
  });
  if (res.status === 401) sessionExpired();
  if (!res.ok) throw new Error(`Fehler ${res.status}`);
}

export const isFavorite = (kind: 'track' | 'album', id: number) =>
  (kind === 'track' ? state.trackIds : state.albumIds).has(id);

/** Herz an oder aus; die Anzeige wechselt sofort, bei einem Fehler wieder zurück. */
export async function toggleFavorite(kind: 'track', item: Track): Promise<void>;
export async function toggleFavorite(kind: 'album', item: Album): Promise<void>;
export async function toggleFavorite(kind: 'track' | 'album', item: Track | Album): Promise<void> {
  const before = state.favorites ?? { tracks: [], albums: [] };
  const on = !isFavorite(kind, item.id);
  const list = kind === 'track' ? before.tracks : before.albums;
  const nextList = on ? [item, ...list] : list.filter((entry) => entry.id !== item.id);
  set({ favorites: kind === 'track' ? { ...before, tracks: nextList as Track[] } : { ...before, albums: nextList as Album[] } });
  try {
    await send(on ? 'PUT' : 'DELETE', `/api/me/favorites/${kind}/${item.id}`);
    clearCache();
  } catch {
    set({ favorites: before });
  }
}

/** Ab dieser Länge (Sekunden) merkt sich die App die Stelle, wie der Server. */
export const RESUME_MIN_DURATION = 10 * 60;
/** So nah am Ende gilt ein Titel als fertig gehört. */
const FINISHED_MARGIN = 30;

export const isLong = (duration: number | null | undefined) => (duration ?? 0) >= RESUME_MIN_DURATION;

/** Gespeicherte Stelle eines langen Titels, falls er angefangen und nicht fertig ist, mit seiner Länge */
export function savedProgress(track: Pick<Track, 'id' | 'duration'>): Progress | undefined {
  const saved = state.progress.get(track.id);
  if (!saved) return undefined;
  const duration = saved.duration || track.duration || 0;
  if (!isLong(duration) || saved.position < 15 || saved.position >= duration - FINISHED_MARGIN) return undefined;
  return { position: saved.position, duration };
}

export const resumePosition = (track: Pick<Track, 'id' | 'duration'>) => savedProgress(track)?.position;

/** Hörstand an den Server; lange Titel merken sich die Stelle auch sofort hier. */
export function saveProgress(track: Pick<Track, 'id' | 'duration'>, position: number): void {
  const duration = track.duration ?? 0;
  const progress = new Map(state.progress);
  if (isLong(duration) && position < duration - FINISHED_MARGIN) progress.set(track.id, { position, duration });
  else progress.delete(track.id);
  set({ progress });
  const round = (seconds: number) => Math.round(seconds * 10) / 10;
  void send('PUT', `/api/me/progress/${track.id}`, {
    position: round(position),
    ...(duration > 0 ? { duration: round(duration) } : {}),
  }).catch(() => undefined);
}

/** Meldet eine Wiedergabe fürs verdeckte Scoring; geht sie verloren, fehlt eben ein Zähler. */
export function countPlay(track: Pick<Track, 'id'>): void {
  void send('POST', `/api/me/plays/${track.id}`).catch(() => undefined);
}
