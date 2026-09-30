import { sessionExpired } from './auth';

export interface Track {
  id: number;
  title: string;
  album: string | null;
  albumId: number | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  duration: number | null;
  mimeType: string | null;
  /** Eigenes eingebettetes Bild oder Albumcover vorhanden */
  hasCover?: boolean;
  /** Datum aus dem Ordnernamen des Albums (JJJJ-MM-TT), z. B. bei Gottesdiensten */
  albumDate?: string | null;
  /** Sprecher aus dem Dateinamen ("Predigt - Titel - Name") oder aus der Verwaltung */
  speaker?: string | null;
  /** Bibelstellen des Titels, mehrere durch "; " getrennt */
  passage?: string | null;
  /** Inhalt einer Aufnahme ("Lied", "Predigt") aus dem Regelwerk */
  content?: string | null;
  /** Player laut Policies im Regelwerk: Predigt-Player oder Musik-Player; null: nach Länge */
  player?: 'sermon' | 'music' | null;
}

export interface Album {
  id: number;
  title: string;
  year: number | null;
  trackCount: number;
  duration: number;
  hasCover: boolean;
  /** "manual" für vom Admin zusammengestellte Alben */
  kind?: 'auto' | 'manual';
  /** Datum aus dem Ordnernamen (JJJJ-MM-TT), z. B. "2026-09-27 Erntedank" */
  date?: string | null;
  speaker?: string | null;
  passage?: string | null;
  description?: string | null;
  /** Art der Aufnahme aus dem Regelwerk ("Gottesdienst", "Bibelstunde"); bei Musik und Sonstigem null */
  recording?: string | null;
  /** Aufnahme einer Art, Musik oder Sonstiges (keine Zuordnung); bei Playlists null */
  section?: 'recording' | 'music' | 'other' | null;
}

/** Art eines Albums zum Anzeigen: die Art der Aufnahme, sonst Musik oder Sonstiges */
export const kindLabel = (album: Pick<Album, 'recording' | 'section'>): string =>
  album.recording || (album.section === 'music' ? 'Musik' : album.section === 'other' ? 'Sonstiges' : 'Playlist');

export interface AlbumDetail extends Album {
  tracks: Track[];
}

/** Frei definierbare Kategorie ("Sprecher", "Inhalt" ...), in der Verwaltung angelegt */
export interface CategoryInfo {
  id: number;
  name: string;
  slug: string;
  /** Im Menü und auf der Startseite anzeigen */
  inNav: boolean;
}

export interface CategoryValue {
  value: string;
  trackCount: number;
  /** Zusammengefasster Wert, z. B. "Musik" aus den Inhalten Lied und Chor */
  grouped: boolean;
  sources?: string[];
}

export const categoryUrl = (slug: string, value?: string) =>
  `/kategorie/${encodeURIComponent(slug)}${value === undefined ? '' : `/${encodeURIComponent(value)}`}`;

export interface Facet<T = string> {
  value: T;
  count: number;
}

export interface Facets {
  decades: Facet<number>[];
  totals: { tracks: number; albums: number; duration: number };
  /** Arten von Aufnahmen aus dem Regelwerk, mit Anzahl */
  recordings?: Array<{ name: string; plural: string; count: number; /** jüngstes Datum (JJJJ-MM-TT) */ latest?: string | null }>;
  /** Automatische Alben, die Musik sind, und solche ohne Zuordnung (Sonstiges) */
  music?: number;
  other?: number;
  /** Sichtbare Playlists (von Hand zusammengestellt), mit oder ohne Art */
  playlists?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Filter {
  q?: string;
  decade?: number;
  albumId?: number;
  sort?: string;
}

export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Kurzer Cache, damit Zurück-Navigation sofort den alten Stand zeigt.
const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_MS = 60_000;

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data as T;
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (res.status === 401) sessionExpired();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `Fehler ${res.status}`);
  }
  const data = (await res.json()) as T;
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return data;
}

export function clearCache(): void {
  cache.clear();
}

export function peekJson<T>(url: string): T | undefined {
  const hit = cache.get(url);
  return hit && Date.now() - hit.at < CACHE_MS ? (hit.data as T) : undefined;
}

export const coverUrl = (albumId: number) => `/api/albums/${albumId}/cover`;
let coverOverride: (trackId: number) => string | undefined = () => undefined;
/** Offline gespeicherte Cover (siehe offline/) statt vom Server */
export function setCoverOverride(lookup: (trackId: number) => string | undefined): void {
  coverOverride = lookup;
}

/** Titelbild; ältere gespeicherte Warteschlangen kennen `hasCover` noch nicht, dann einfach versuchen. */
export const trackCoverUrl = (track: Pick<Track, 'id' | 'hasCover'>) =>
  track.hasCover === false ? undefined : (coverOverride(track.id) ?? `/api/tracks/${track.id}/cover`);
export const streamUrl = (trackId: number) => `/api/tracks/${trackId}/stream`;
