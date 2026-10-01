import { useEffect, useState } from 'preact/hooks';
import { clearCache, getJson, type Album, type Track } from './api';
import { sessionExpired } from './auth';
import { syncFavorites } from './offline';
import { loadPlaylists, resetPlaylists } from './playlists';
import { sermonMinSeconds } from './playerSettings';

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
  /** Neu, angefangen, gehört je Gottesdienst (Liste unter "Datum") */
  dated: Map<number, DatedState>;
  /** Gottesdienste, die seit dem letzten Besuch unter "Datum" dazugekommen sind (Punkt am Tab) */
  freshDates: number;
}

export interface DatedState {
  albumId: number;
  state: 'new' | 'started' | 'heard';
  progress?: number;
}

const empty = (): State => ({
  favorites: undefined,
  trackIds: new Set(),
  albumIds: new Set(),
  progress: new Map(),
  dated: new Map(),
  freshDates: 0,
});
let state: State = empty();
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  if (next.favorites) {
    state.trackIds = new Set(next.favorites.tracks.map((t) => t.id));
    state.albumIds = new Set(next.favorites.albums.map((a) => a.id));
    // Sind die Favoriten offline gewünscht, kommen neue Titel gleich mit aufs Gerät.
    void syncFavorites(next.favorites.tracks).catch(() => undefined);
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
    loadDates(),
    loadPlaylists(),
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
  state = empty();
  resetPlaylists();
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

/** Die Favoriten-Titel als Playlist: "Jetzt läuft" führt zu ihr zurück. */
export const FAVORITES_CONTEXT = { title: 'Favoriten', href: '/favoriten' };

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

/** So nah am Ende gilt ein Titel als fertig gehört. */
const FINISHED_MARGIN = 30;

/** Ab dieser Länge merkt sich die App die Stelle, wie der Server, wenn keine Policy den Player festlegt. */
export const isLong = (duration: number | null | undefined) => (duration ?? 0) >= sermonMinSeconds();

type PlayerTrack = Pick<Track, 'id' | 'duration' | 'player'>;

/**
 * Predigt-Player (Sprünge, Tempo, Weiterhören): wie es die Policies im Regelwerk festlegen,
 * sonst bei langen Titeln. `duration` ist die gemessene Länge, falls schon bekannt.
 */
export const usesSermonPlayer = (track: Partial<PlayerTrack> | undefined, duration?: number | null) =>
  track?.player ? track.player === 'sermon' : isLong(duration || track?.duration);

/** Gespeicherte Stelle eines Titels im Predigt-Player, falls er angefangen und nicht fertig ist, mit seiner Länge */
export function savedProgress(track: PlayerTrack): Progress | undefined {
  const saved = state.progress.get(track.id);
  if (!saved) return undefined;
  const duration = saved.duration || track.duration || 0;
  if (!usesSermonPlayer(track, duration) || saved.position < 15 || saved.position >= duration - FINISHED_MARGIN) return undefined;
  return { position: saved.position, duration };
}

export const resumePosition = (track: PlayerTrack) => savedProgress(track)?.position;

/** Woraus ein Titel laufen kann, wie der Server es für "Zuletzt gehört" annimmt: Playlist der Verwaltung oder eigene */
const CONTEXT = /^(\/(album|playlist)\/[1-9]\d{0,9}|\/favoriten)$/;

/**
 * Hörstand an den Server; Titel im Predigt-Player merken sich die Stelle auch sofort hier.
 * `from`: Playlist, aus der der Titel läuft, damit sie unter "Zuletzt gehört" erscheint.
 */
export function saveProgress(track: PlayerTrack, position: number, from?: string): void {
  const duration = track.duration ?? 0;
  const progress = new Map(state.progress);
  if (usesSermonPlayer(track, duration) && position < duration - FINISHED_MARGIN) progress.set(track.id, { position, duration });
  else progress.delete(track.id);
  set({ progress });
  const round = (seconds: number) => Math.round(seconds * 10) / 10;
  void send('PUT', `/api/me/progress/${track.id}`, {
    position: round(position),
    ...(duration > 0 ? { duration: round(duration) } : {}),
    ...(from && CONTEXT.test(from) ? { context: from } : {}),
  }).catch(() => undefined);
}

/** Meldet eine Wiedergabe fürs verdeckte Scoring; geht sie verloren, fehlt eben ein Zähler. */
export function countPlay(track: Pick<Track, 'id'>): void {
  void send('POST', `/api/me/plays/${track.id}`).catch(() => undefined);
}

/** Suchbegriff, aus dem ein Treffer geöffnet wurde; der Server zählt ihn für "Häufig gesucht". */
export function countSearch(q: string): void {
  void send('POST', '/api/me/searches', { q }).catch(() => undefined);
}

/** Gerade unter "Datum": dann ist nichts mehr neu für den Punkt am Tab */
let onDates = false;

/** Hörstand der Gottesdienste neu vom Server; Fehler: bleibt beim alten Stand */
export async function loadDates(): Promise<void> {
  const data = await fetchJson<{ items: DatedState[]; fresh: number }>('/api/me/dates').catch(() => undefined);
  if (!data || !Array.isArray(data.items)) return;
  set({ dated: new Map(data.items.map((item) => [item.albumId, item])), freshDates: onDates ? 0 : data.fresh || 0 });
  if (onDates && data.fresh) void send('POST', '/api/me/dates/seen').catch(() => undefined);
}

/**
 * Unter "Datum" angekommen: Hörstand frisch holen, der Punkt am Tab verschwindet. Die Kennzeichen "neu" bleiben bis
 * zum nächsten Besuch stehen, damit man sieht, was dazukam. Gibt die Funktion zum Verlassen zurück.
 */
export function enterDates(): () => void {
  onDates = true;
  set({ freshDates: 0 });
  void loadDates();
  return () => {
    onDates = false;
  };
}

/** Titel unter "Weiterhören" schließen; der Hörstand bleibt, beim Weiterhören ist er wieder da. */
export async function dismissResume(trackId: number): Promise<void> {
  await send('DELETE', `/api/me/resume/${trackId}`);
  clearCache();
}

/** "Als gehört markieren" bzw. zurück; danach Hörstand und Weiterhören neu laden */
export async function markAlbumHeard(albumId: number, heard: boolean): Promise<void> {
  await send('PUT', `/api/me/albums/${albumId}/heard`, { heard });
  clearCache();
  await loadMe();
}
