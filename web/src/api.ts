export interface Track {
  id: number;
  title: string;
  artist: string;
  albumArtist: string | null;
  album: string | null;
  albumId: number | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  duration: number | null;
  mimeType: string | null;
  /** Eigenes eingebettetes Bild oder Albumcover vorhanden */
  hasCover?: boolean;
}

export interface Album {
  id: number;
  title: string;
  artist: string;
  year: number | null;
  genre: string | null;
  trackCount: number;
  duration: number;
  hasCover: boolean;
}

export interface AlbumDetail extends Album {
  tracks: Track[];
}

/** Unterster Ordner mit Datum im Namen, z. B. eine Gottesdienst-Aufnahme */
export interface DatedFolder {
  folder: string;
  name: string;
  /** JJJJ-MM-TT */
  date: string;
  trackCount: number;
  duration: number;
  coverTrackId: number | null;
}

export interface DatedFolderDetail extends DatedFolder {
  tracks: Track[];
}

export interface Artist {
  name: string;
  albumCount: number;
  trackCount: number;
}

export interface Facet<T = string> {
  value: T;
  count: number;
}

export interface Facets {
  genres: Facet[];
  decades: Facet<number>[];
  totals: { tracks: number; albums: number; duration: number };
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Filter {
  q?: string;
  artist?: string;
  genre?: string;
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
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `Fehler ${res.status}`);
  }
  const data = (await res.json()) as T;
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return data;
}

export function peekJson<T>(url: string): T | undefined {
  const hit = cache.get(url);
  return hit && Date.now() - hit.at < CACHE_MS ? (hit.data as T) : undefined;
}

export const coverUrl = (albumId: number) => `/api/albums/${albumId}/cover`;
/** Titelbild; ältere gespeicherte Warteschlangen kennen `hasCover` noch nicht, dann einfach versuchen. */
export const trackCoverUrl = (track: Pick<Track, 'id' | 'hasCover'>) =>
  track.hasCover === false ? undefined : `/api/tracks/${track.id}/cover`;
export const streamUrl = (trackId: number) => `/api/tracks/${trackId}/stream`;
