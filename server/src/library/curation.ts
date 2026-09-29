import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import { albumKey, MANUAL_KEY_PREFIX, rebuildAlbums } from './albums.js';
import { getAlbum } from './queries.js';

/**
 * Admin-Werkzeuge für Alben: manuelle Alben zusammenstellen und automatische korrigieren.
 * Gespeichert wird nur, was der Admin festlegt (album_overrides, track_exclusions,
 * manual_album_tracks); die Alben selbst baut rebuildAlbums danach und nach jedem Scan neu.
 */

export class CurationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AlbumFields {
  title?: string | null;
  artist?: string | null;
  year?: number | null;
  genre?: string | null;
  hidden?: boolean;
}

interface AlbumRow {
  id: number;
  key: string;
  kind: 'auto' | 'manual';
}

function findAlbum(db: DB, id: number): AlbumRow {
  const album = db.prepare('SELECT id, key, kind FROM albums WHERE id = ?').get(id) as AlbumRow | undefined;
  if (!album) throw new CurationError(404, 'Album nicht gefunden');
  return album;
}

function requireManual(album: AlbumRow): void {
  if (album.kind !== 'manual') {
    throw new CurationError(409, 'Nur bei eigenen Alben möglich; automatische Alben lassen sich ausblenden oder korrigieren');
  }
}

/** Pfade zu Titel-IDs in der gewünschten Reihenfolge; unbekannte IDs sind ein Fehler. */
function trackPaths(db: DB, trackIds: number[]): Array<{ id: number; path: string; album: string | null }> {
  const unique = [...new Set(trackIds)];
  if (!unique.length) return [];
  const rows = db
    .prepare(`SELECT id, path, album FROM tracks WHERE id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as Array<{ id: number; path: string; album: string | null }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length) throw new CurationError(400, `Titel nicht gefunden: ${missing.join(', ')}`);
  return unique.map((id) => byId.get(id)!);
}

function cleanText(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function writeOverride(db: DB, key: string, fields: AlbumFields): void {
  const current = (db.prepare('SELECT title, artist, year, genre, hidden FROM album_overrides WHERE key = ?').get(key) as
    | { title: string | null; artist: string | null; year: number | null; genre: string | null; hidden: number }
    | undefined) ?? { title: null, artist: null, year: null, genre: null, hidden: 0 };
  const next = {
    key,
    title: fields.title !== undefined ? cleanText(fields.title) ?? null : current.title,
    artist: fields.artist !== undefined ? cleanText(fields.artist) ?? null : current.artist,
    year: fields.year !== undefined ? fields.year : current.year,
    genre: fields.genre !== undefined ? cleanText(fields.genre) ?? null : current.genre,
    hidden: fields.hidden !== undefined ? (fields.hidden ? 1 : 0) : current.hidden,
  };
  if (!next.title && !next.artist && next.year === null && !next.genre && !next.hidden) {
    db.prepare('DELETE FROM album_overrides WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO album_overrides (key, title, artist, year, genre, hidden) VALUES (@key, @title, @artist, @year, @genre, @hidden)
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, artist = excluded.artist, year = excluded.year,
       genre = excluded.genre, hidden = excluded.hidden`,
  ).run(next);
}

/** Nimmt Titel aus ihrem automatischen Album heraus (für "verschieben" statt "zusätzlich"). */
function excludeFromAuto(db: DB, tracks: Array<{ path: string; album: string | null }>): void {
  const insert = db.prepare('INSERT OR IGNORE INTO track_exclusions (path, album_key) VALUES (?, ?)');
  for (const track of tracks) insert.run(track.path, albumKey(track.path, track.album));
}

export function albumDetail(db: DB, id: number) {
  const album = getAlbum(db, id, { includeHidden: true });
  if (!album) throw new CurationError(404, 'Album nicht gefunden');
  const row = findAlbum(db, id);
  const override = db.prepare('SELECT title, artist, year, genre FROM album_overrides WHERE key = ?').get(row.key) as
    | { title: string | null; artist: string | null; year: number | null; genre: string | null }
    | undefined;
  // Herausgenommene Titel eines automatischen Albums, damit sie sich wiederherstellen lassen.
  const excluded =
    row.kind === 'auto'
      ? db
          .prepare(
            `SELECT t.id, t.title, t.artist, t.duration FROM track_exclusions e JOIN tracks t ON t.path = e.path
             WHERE e.album_key = ? ORDER BY coalesce(t.disc_no, 1), t.track_no, t.path`,
          )
          .all(row.key)
      : [];
  // Gespeicherte Titel eines manuellen Albums, die gerade nicht in der Nextcloud liegen.
  const missing =
    row.kind === 'manual'
      ? (
          db
            .prepare(
              `SELECT m.path FROM manual_album_tracks m LEFT JOIN tracks t ON t.path = m.path
               WHERE m.album_id = ? AND t.id IS NULL ORDER BY m.position`,
            )
            .all(id) as Array<{ path: string }>
        ).map((r) => r.path)
      : [];
  return {
    ...album,
    overrides: {
      title: override?.title ?? null,
      artist: override?.artist ?? null,
      year: override?.year ?? null,
      genre: override?.genre ?? null,
    },
    excluded,
    missing,
  };
}

export function createManualAlbum(db: DB, fields: AlbumFields & { title: string; trackIds?: number[]; move?: boolean }): number {
  const title = cleanText(fields.title);
  if (!title) throw new CurationError(400, 'Das Album braucht einen Titel');
  const id = db.transaction(() => {
    const key = `${MANUAL_KEY_PREFIX}${randomUUID()}`;
    const { id } = db
      .prepare(
        `INSERT INTO albums (key, kind, title, artist, folder, created_at) VALUES (?, 'manual', ?, '', '', ?) RETURNING id`,
      )
      .get(key, title, Date.now()) as { id: number };
    writeOverride(db, key, { ...fields, title });
    if (fields.trackIds?.length) addTracks(db, id, fields.trackIds, { move: fields.move, rebuild: false });
    return id;
  })();
  rebuildAlbums(db);
  return id;
}

export function updateAlbum(db: DB, id: number, fields: AlbumFields): void {
  const album = findAlbum(db, id);
  if (album.kind === 'manual' && fields.title !== undefined && !cleanText(fields.title)) {
    throw new CurationError(400, 'Das Album braucht einen Titel');
  }
  writeOverride(db, album.key, fields);
  rebuildAlbums(db);
}

export function deleteManualAlbum(db: DB, id: number): void {
  const album = findAlbum(db, id);
  requireManual(album);
  db.transaction(() => {
    db.prepare('DELETE FROM album_overrides WHERE key = ?').run(album.key);
    db.prepare('DELETE FROM albums WHERE id = ?').run(id);
  })();
  rebuildAlbums(db);
}

/** Hängt Titel an ein manuelles Album an; bereits enthaltene bleiben an ihrer Stelle. */
export function addTracks(
  db: DB,
  id: number,
  trackIds: number[],
  options: { move?: boolean; rebuild?: boolean } = {},
): void {
  const album = findAlbum(db, id);
  requireManual(album);
  const tracks = trackPaths(db, trackIds);
  db.transaction(() => {
    const { last } = db.prepare('SELECT coalesce(max(position), 0) AS last FROM manual_album_tracks WHERE album_id = ?').get(id) as {
      last: number;
    };
    const insert = db.prepare('INSERT OR IGNORE INTO manual_album_tracks (album_id, path, position) VALUES (?, ?, ?)');
    tracks.forEach((track, index) => insert.run(id, track.path, last + index + 1));
    if (options.move) excludeFromAuto(db, tracks);
  })();
  if (options.rebuild !== false) rebuildAlbums(db);
}

/**
 * Legt Inhalt und Reihenfolge eines manuellen Albums fest. Gespeicherte Titel, die gerade
 * fehlen, bleiben am Ende erhalten, damit sie nach dem nächsten Scan wieder auftauchen.
 */
export function setTracks(db: DB, id: number, trackIds: number[]): void {
  const album = findAlbum(db, id);
  requireManual(album);
  const tracks = trackPaths(db, trackIds);
  db.transaction(() => {
    const missing = (
      db
        .prepare(
          `SELECT m.path FROM manual_album_tracks m LEFT JOIN tracks t ON t.path = m.path
           WHERE m.album_id = ? AND t.id IS NULL ORDER BY m.position`,
        )
        .all(id) as Array<{ path: string }>
    ).map((r) => r.path);
    db.prepare('DELETE FROM manual_album_tracks WHERE album_id = ?').run(id);
    const insert = db.prepare('INSERT INTO manual_album_tracks (album_id, path, position) VALUES (?, ?, ?)');
    [...tracks.map((t) => t.path), ...missing].forEach((path, index) => insert.run(id, path, index + 1));
  })();
  rebuildAlbums(db);
}

/** Entfernt einen Titel: aus einem manuellen Album ganz, aus einem automatischen per Ausnahme. */
export function removeTrack(db: DB, id: number, trackId: number): void {
  const album = findAlbum(db, id);
  const [track] = trackPaths(db, [trackId]);
  if (album.kind === 'manual') {
    db.prepare('DELETE FROM manual_album_tracks WHERE album_id = ? AND path = ?').run(id, track!.path);
  } else {
    if (albumKey(track!.path, track!.album) !== album.key) throw new CurationError(404, 'Titel ist nicht in diesem Album');
    excludeFromAuto(db, [track!]);
  }
  rebuildAlbums(db);
}

/** Holt einen herausgenommenen Titel in sein automatisches Album zurück. */
export function restoreTrack(db: DB, id: number, trackId: number): void {
  const album = findAlbum(db, id);
  if (album.kind !== 'auto') throw new CurationError(409, 'Nur bei automatischen Alben möglich');
  const [track] = trackPaths(db, [trackId]);
  db.prepare('DELETE FROM track_exclusions WHERE path = ? AND album_key = ?').run(track!.path, album.key);
  rebuildAlbums(db);
}

/** Alle Alben, in denen ein Titel steht, für die Auswahl im Admin-Bereich. */
export function albumsOfTracks(db: DB, trackIds: number[]): Record<number, Array<{ id: number; title: string; kind: string }>> {
  const result: Record<number, Array<{ id: number; title: string; kind: string }>> = {};
  if (!trackIds.length) return result;
  const rows = db
    .prepare(
      `SELECT at.track_id AS trackId, a.id, a.title, a.kind FROM album_tracks at JOIN albums a ON a.id = at.album_id
       WHERE at.track_id IN (${trackIds.map(() => '?').join(',')}) ORDER BY a.kind, a.title COLLATE NOCASE`,
    )
    .all(...trackIds) as Array<{ trackId: number; id: number; title: string; kind: string }>;
  for (const { trackId, ...album } of rows) (result[trackId] ??= []).push(album);
  return result;
}
