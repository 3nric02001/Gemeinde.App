import type { DB } from '../db.js';
import { UNKNOWN_ARTIST } from './metadata.js';
import { albumFolderOf, basename, dirname } from './pathMeta.js';

export const VARIOUS_ARTISTS = 'Verschiedene Interpreten';
export const LOOSE_TRACKS = 'Einzeltitel';

interface TrackRow {
  id: number;
  path: string;
  title: string;
  artist: string;
  album_artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  duration: number | null;
  compilation: number;
}

interface AlbumDraft {
  key: string;
  title: string;
  folder: string;
  tracks: TrackRow[];
}

export function normalizeKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function mostCommon<T>(values: Array<T | null | undefined>): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) if (value != null) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function albumArtist(tracks: TrackRow[]): string {
  const tagged = mostCommon(tracks.map((t) => t.album_artist));
  if (tagged) return tagged;
  const artists = new Set(tracks.map((t) => normalizeKey(t.artist)));
  if (artists.size === 1 && !tracks.some((t) => t.compilation)) return tracks[0]?.artist ?? UNKNOWN_ARTIST;
  return VARIOUS_ARTISTS;
}

/**
 * Albumschlüssel: Albumordner (Disc-Unterordner zusammengefasst) plus normalisierter Albumname.
 * So landen Sampler mit vielen Interpreten in einem Album, während ein Sammelordner
 * mit Titeln verschiedener Alben sauber aufgeteilt wird.
 */
export function albumKey(path: string, album: string | null): string {
  return `${albumFolderOf(path)}\u0000${album ? normalizeKey(album) : ''}`;
}

/**
 * Baut alle Alben aus den Titeln neu auf. Bestehende Alben behalten ihre ID
 * (Links und spätere Playlists bleiben gültig), leere werden entfernt.
 * @param covers Bestes Coverbild pro Ordner (Ordnerpfad → Bildpfad)
 */
export function rebuildAlbums(db: DB, covers: Map<string, string>, now = Date.now()): void {
  const tracks = db
    .prepare(
      'SELECT id, path, title, artist, album_artist, album, year, genre, duration, compilation FROM tracks',
    )
    .all() as TrackRow[];

  const drafts = new Map<string, AlbumDraft>();
  for (const track of tracks) {
    const key = albumKey(track.path, track.album);
    let draft = drafts.get(key);
    if (!draft) {
      const folder = albumFolderOf(track.path);
      draft = { key, title: track.album ?? (folder ? basename(folder) : LOOSE_TRACKS), folder, tracks: [] };
      drafts.set(key, draft);
    }
    draft.tracks.push(track);
  }

  const upsert = db.prepare(`
    INSERT INTO albums (key, title, artist, year, genre, folder, cover_path, track_count, duration, created_at)
    VALUES (@key, @title, @artist, @year, @genre, @folder, @cover, @count, @duration, @now)
    ON CONFLICT(key) DO UPDATE SET
      title = excluded.title, artist = excluded.artist, year = excluded.year, genre = excluded.genre,
      folder = excluded.folder, cover_path = excluded.cover_path,
      track_count = excluded.track_count, duration = excluded.duration
    RETURNING id
  `);
  const assign = db.prepare('UPDATE tracks SET album_id = ? WHERE id = ? AND album_id IS NOT ?');
  const existingKeys = db.prepare('SELECT id, key FROM albums').all() as Array<{ id: number; key: string }>;
  const removeAlbum = db.prepare('DELETE FROM albums WHERE id = ?');

  db.transaction(() => {
    for (const draft of drafts.values()) {
      const cover =
        covers.get(draft.folder) ?? draft.tracks.map((t) => covers.get(dirname(t.path))).find((c) => c !== undefined);
      const title = mostCommon(draft.tracks.map((t) => t.album)) ?? draft.title;
      const { id } = upsert.get({
        key: draft.key,
        title,
        artist: albumArtist(draft.tracks),
        year: mostCommon(draft.tracks.map((t) => t.year)) ?? null,
        genre: mostCommon(draft.tracks.map((t) => t.genre)) ?? null,
        folder: draft.folder,
        cover: cover ?? null,
        count: draft.tracks.length,
        duration: draft.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0),
        now,
      }) as { id: number };
      for (const track of draft.tracks) assign.run(id, track.id, id);
    }
    for (const { id, key } of existingKeys) if (!drafts.has(key)) removeAlbum.run(id);
  })();
}
