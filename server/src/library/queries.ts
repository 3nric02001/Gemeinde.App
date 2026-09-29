import type { DB } from '../db.js';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface TrackFilter {
  q?: string;
  artist?: string;
  genre?: string;
  year?: number;
  decade?: number;
  albumId?: number;
  limit: number;
  offset: number;
}

export interface AlbumFilter {
  q?: string;
  artist?: string;
  genre?: string;
  year?: number;
  decade?: number;
  sort: 'title' | 'artist' | 'year' | 'recent';
  limit: number;
  offset: number;
}

const TRACK_COLUMNS = `
  t.id, t.title, t.artist, t.album_artist AS albumArtist, t.album, t.album_id AS albumId,
  t.track_no AS trackNo, t.disc_no AS discNo, t.year, t.genre, t.duration, t.mime AS mimeType,
  (t.cover_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM albums x WHERE x.id = t.album_id AND (x.cover_path IS NOT NULL OR x.cover_id IS NOT NULL)
  )) AS hasCover
`;
const ALBUM_COLUMNS = `
  a.id, a.title, a.artist, a.year, a.genre, a.track_count AS trackCount, a.duration,
  (a.cover_path IS NOT NULL OR a.cover_id IS NOT NULL) AS hasCover
`;

/**
 * Macht aus freier Eingabe eine sichere FTS5-Abfrage: jedes Wort als Präfixsuche,
 * alle Wörter müssen vorkommen. Sonderzeichen können so keine FTS-Syntax auslösen.
 */
export function toFtsQuery(input: string): string | undefined {
  const tokens = input
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 10);
  return tokens.length ? tokens.map((token) => `"${token}"*`).join(' ') : undefined;
}

interface Where {
  clauses: string[];
  params: Record<string, unknown>;
}

function commonFilters(where: Where, alias: string, filter: { artist?: string; genre?: string; year?: number; decade?: number }) {
  if (filter.genre) {
    where.clauses.push(`${alias}.genre = @genre COLLATE NOCASE`);
    where.params.genre = filter.genre;
  }
  if (filter.year) {
    where.clauses.push(`${alias}.year = @year`);
    where.params.year = filter.year;
  }
  if (filter.decade !== undefined) {
    where.clauses.push(`${alias}.year BETWEEN @decade AND @decade + 9`);
    where.params.decade = filter.decade;
  }
}

function sql(where: Where): string {
  return where.clauses.length ? `WHERE ${where.clauses.join(' AND ')}` : '';
}

function coerceHasCover<T extends { hasCover: number | boolean }>(row: T): T {
  return { ...row, hasCover: Boolean(row.hasCover) };
}

export function searchTracks(db: DB, filter: TrackFilter): Page<Record<string, unknown>> {
  const where: Where = { clauses: [], params: {} };
  const fts = filter.q ? toFtsQuery(filter.q) : undefined;
  if (filter.q && !fts) return { items: [], total: 0, limit: filter.limit, offset: filter.offset };
  if (fts) {
    where.clauses.push('t.id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH @fts)');
    where.params.fts = fts;
  }
  if (filter.artist) {
    where.clauses.push('(t.artist = @artist COLLATE NOCASE OR t.album_artist = @artist COLLATE NOCASE)');
    where.params.artist = filter.artist;
  }
  if (filter.albumId) {
    where.clauses.push('t.album_id = @albumId');
    where.params.albumId = filter.albumId;
  }
  commonFilters(where, 't', filter);

  const { total } = db.prepare(`SELECT count(*) AS total FROM tracks t ${sql(where)}`).get(where.params) as {
    total: number;
  };
  const items = db
    .prepare(
      `SELECT ${TRACK_COLUMNS} FROM tracks t ${sql(where)}
       ORDER BY t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_no, t.track_no, t.title COLLATE NOCASE
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...where.params, limit: filter.limit, offset: filter.offset }) as Array<{ hasCover: number }>;
  return { items: items.map(coerceHasCover), total, limit: filter.limit, offset: filter.offset };
}

const ALBUM_SORT: Record<AlbumFilter['sort'], string> = {
  title: 'a.title COLLATE NOCASE',
  artist: 'a.artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE',
  year: 'a.year IS NULL, a.year DESC, a.title COLLATE NOCASE',
  recent: 'a.created_at DESC, a.id DESC',
};

export function searchAlbums(db: DB, filter: AlbumFilter): Page<Record<string, unknown>> {
  const where: Where = { clauses: [], params: {} };
  const fts = filter.q ? toFtsQuery(filter.q) : undefined;
  if (filter.q && !fts) return { items: [], total: 0, limit: filter.limit, offset: filter.offset };
  if (fts) {
    // Album trifft, wenn Titel, Interpret, Album oder Genre eines seiner Titel passt.
    where.clauses.push(
      'a.id IN (SELECT t.album_id FROM tracks t WHERE t.id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH @fts))',
    );
    where.params.fts = fts;
  }
  if (filter.artist) {
    where.clauses.push(
      '(a.artist = @artist COLLATE NOCASE OR a.id IN (SELECT album_id FROM tracks WHERE artist = @artist COLLATE NOCASE))',
    );
    where.params.artist = filter.artist;
  }
  commonFilters(where, 'a', filter);

  const { total } = db.prepare(`SELECT count(*) AS total FROM albums a ${sql(where)}`).get(where.params) as {
    total: number;
  };
  const items = (
    db
      .prepare(`SELECT ${ALBUM_COLUMNS} FROM albums a ${sql(where)} ORDER BY ${ALBUM_SORT[filter.sort]} LIMIT @limit OFFSET @offset`)
      .all({ ...where.params, limit: filter.limit, offset: filter.offset }) as Array<{ hasCover: number }>
  ).map(coerceHasCover);
  return { items, total, limit: filter.limit, offset: filter.offset };
}

export function getAlbum(db: DB, id: number): Record<string, unknown> | undefined {
  const album = db.prepare(`SELECT ${ALBUM_COLUMNS} FROM albums a WHERE a.id = ?`).get(id) as
    | { hasCover: number }
    | undefined;
  if (!album) return undefined;
  const tracks = db
    .prepare(
      `SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.album_id = ?
       ORDER BY coalesce(t.disc_no, 1), t.track_no IS NULL, t.track_no, t.path`,
    )
    .all(id) as Array<{ hasCover: number }>;
  return { ...coerceHasCover(album), tracks: tracks.map(coerceHasCover) };
}

/** Titel in der angegebenen Reihenfolge */
export function getTracksByIds(db: DB, ids: number[]): Record<string, unknown>[] {
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as Array<{ id: number; hasCover: number }>;
  const byId = new Map(rows.map((row) => [row.id, coerceHasCover(row)]));
  return ids.map((id) => byId.get(id)).filter((row) => row !== undefined);
}

export function getTrackFile(db: DB, id: number): { path: string; mime: string | null } | undefined {
  return db.prepare('SELECT path, mime FROM tracks WHERE id = ?').get(id) as
    | { path: string; mime: string | null }
    | undefined;
}

/** Bild im Ordner (liegt in der Nextcloud) oder eingebettetes Bild (liegt in der Datenbank) */
export type CoverSource = { path: string } | { coverId: number };

/** Albumcover: Bild im Albumordner hat Vorrang vor dem eingebetteten. */
export function getAlbumCover(db: DB, id: number): CoverSource | undefined {
  const row = db.prepare('SELECT cover_path, cover_id FROM albums WHERE id = ?').get(id) as
    | { cover_path: string | null; cover_id: number | null }
    | undefined;
  if (row?.cover_path) return { path: row.cover_path };
  if (row?.cover_id) return { coverId: row.cover_id };
  return undefined;
}

/** Titelcover: eingebettetes Bild des Titels, sonst das Albumcover (wichtig für Sampler). */
export function getTrackCover(db: DB, id: number): CoverSource | undefined {
  const row = db.prepare('SELECT cover_id, album_id FROM tracks WHERE id = ?').get(id) as
    | { cover_id: number | null; album_id: number | null }
    | undefined;
  if (!row) return undefined;
  if (row.cover_id) return { coverId: row.cover_id };
  return row.album_id ? getAlbumCover(db, row.album_id) : undefined;
}

export function getCoverImage(db: DB, id: number): { hash: string; mime: string; data: Buffer } | undefined {
  return db.prepare('SELECT hash, mime, data FROM covers WHERE id = ?').get(id) as
    | { hash: string; mime: string; data: Buffer }
    | undefined;
}

export function listArtists(db: DB, q: string | undefined, limit: number, offset: number) {
  const params: Record<string, unknown> = { limit, offset };
  let filter = '';
  if (q) {
    filter = "WHERE name LIKE @like ESCAPE '\\'";
    params.like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  // Interpreten aus Album-Interpret und Titel-Interpret, damit auch Gäste auf Samplern auffindbar sind.
  const base = `
    SELECT name, count(DISTINCT album_id) AS albumCount, count(*) AS trackCount FROM (
      SELECT artist AS name, album_id FROM tracks
      UNION ALL
      SELECT album_artist AS name, album_id FROM tracks WHERE album_artist IS NOT NULL AND album_artist <> artist
    ) ${filter}
    GROUP BY name COLLATE NOCASE`;
  const { total } = db.prepare(`SELECT count(*) AS total FROM (${base})`).get(params) as { total: number };
  const items = db.prepare(`${base} ORDER BY name COLLATE NOCASE LIMIT @limit OFFSET @offset`).all(params);
  return { items, total, limit, offset };
}

/** Werte für die Filterleiste im Player, jeweils mit Anzahl Titel. */
export function getFacets(db: DB) {
  const genres = db
    .prepare(
      `SELECT genre AS value, count(*) AS count FROM tracks WHERE genre IS NOT NULL
       GROUP BY genre COLLATE NOCASE ORDER BY count DESC, genre COLLATE NOCASE LIMIT 100`,
    )
    .all();
  const decades = db
    .prepare(
      `SELECT (year / 10) * 10 AS value, count(*) AS count FROM tracks WHERE year IS NOT NULL
       GROUP BY value ORDER BY value DESC`,
    )
    .all();
  const totals = db
    .prepare(
      `SELECT (SELECT count(*) FROM tracks) AS tracks, (SELECT count(*) FROM albums) AS albums,
              (SELECT coalesce(sum(duration), 0) FROM tracks) AS duration`,
    )
    .get();
  return { genres, decades, totals };
}
