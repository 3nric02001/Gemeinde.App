import { getMeta, type DB } from '../db.js';
import type { CategoryFilter } from './categories.js';
import { SPEAKER_TAGS } from './metadata.js';
import { albumTierSql, decayFactor, trackTierSql } from './popularity.js';
import { artistKey, artistNames, foldValue, sortKey } from './text.js';

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
  /** Nur Titel mit einem bestimmten Wert einer Kategorie */
  category?: CategoryFilter;
  limit: number;
  offset: number;
}

export const ALBUM_SORTS = ['title', 'artist', 'year', 'recent', 'date', 'popular'] as const;
export type AlbumSort = (typeof ALBUM_SORTS)[number];

export interface AlbumFilter {
  q?: string;
  artist?: string;
  genre?: string;
  year?: number;
  decade?: number;
  sort: AlbumSort;
  /** Nur für den Admin-Bereich: ausgeblendete Alben mitliefern */
  includeHidden?: boolean;
  kind?: 'auto' | 'manual';
  category?: CategoryFilter;
  /** Nur diese Alben (z. B. Favoriten) */
  ids?: number[];
  /** Nur Alben mit (true) bzw. ohne (false) Datum im Ordnernamen, also Gottesdienste oder Musik */
  dated?: boolean;
  limit: number;
  offset: number;
}

const TRACK_COLUMNS = `
  t.id, t.title, t.artist, t.album_artist AS albumArtist,
  coalesce((SELECT title FROM albums WHERE id = t.album_id), t.album) AS album, t.album_id AS albumId,
  t.track_no AS trackNo, t.disc_no AS discNo, t.year, t.genre, t.duration, t.mime AS mimeType,
  (SELECT date FROM albums WHERE id = t.album_id) AS albumDate,
  (SELECT value FROM track_tags WHERE track_id = t.id AND tag IN (${SPEAKER_TAGS.map((tag) => `'${tag}'`).join(', ')}) LIMIT 1) AS speaker,
  (t.cover_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM albums x WHERE x.id = t.album_id AND (x.cover_path IS NOT NULL OR x.cover_id IS NOT NULL)
  )) AS hasCover
`;
const ALBUM_COLUMNS = `
  a.id, a.title, a.artist, a.year, a.genre, a.track_count AS trackCount, a.duration,
  (a.cover_path IS NOT NULL OR a.cover_id IS NOT NULL) AS hasCover, a.kind,
  a.date, a.speaker, a.passage, a.description
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

/** Titel-IDs, die in einem der Felder der Kategorie einen der Werte tragen */
function categoryTracks(where: Where, category: CategoryFilter): string {
  where.params.catFields = JSON.stringify(category.fields);
  where.params.catKeys = JSON.stringify(category.vkeys);
  return `SELECT track_id FROM track_tags WHERE tag IN (SELECT value FROM json_each(@catFields))
    AND vkey IN (SELECT value FROM json_each(@catKeys))`;
}

function sql(where: Where): string {
  return where.clauses.length ? `WHERE ${where.clauses.join(' AND ')}` : '';
}

function coerceHasCover<T extends { hasCover: number | boolean; hidden?: number | boolean }>(row: T): T {
  return row.hidden === undefined
    ? { ...row, hasCover: Boolean(row.hasCover) }
    : { ...row, hasCover: Boolean(row.hasCover), hidden: Boolean(row.hidden) };
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
    // Auch andere Schreibweisen und Gastauftritte ("Anna feat. Ben" gehört auch zu Ben)
    where.clauses.push('(has_artist(t.artist, @artistKey) OR has_artist(t.album_artist, @artistKey))');
    where.params.artistKey = artistKey(filter.artist);
  }
  if (filter.albumId) {
    where.clauses.push('t.id IN (SELECT track_id FROM album_tracks WHERE album_id = @albumId)');
    where.params.albumId = filter.albumId;
  }
  if (filter.category) where.clauses.push(`t.id IN (${categoryTracks(where, filter.category)})`);
  commonFilters(where, 't', filter);

  const { total } = db.prepare(`SELECT count(*) AS total FROM tracks t ${sql(where)}`).get(where.params) as {
    total: number;
  };
  // Bei einer Suche: Treffer im Titel zuerst (Anfang vor irgendwo), dann oft Gehörtes, innerhalb gleicher
  // Beliebtheit die neuesten Gottesdienste.
  const relevance = fts
    ? `CASE WHEN t.sort_title >= @qkey AND t.sort_title < @qkeyEnd THEN 0
            WHEN t.id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH @ftsTitle) THEN 1 ELSE 2 END, `
    : '';
  const items = db
    .prepare(
      `SELECT ${TRACK_COLUMNS} FROM tracks t ${sql(where)}
       ORDER BY ${fts ? `${relevance}${trackTierSql('t')} DESC, albumDate DESC NULLS LAST, ` : ''}t.sort_artist,
         coalesce((SELECT sort_title FROM albums WHERE id = t.album_id), ''), t.disc_no, t.track_no, t.sort_title
       LIMIT @limit OFFSET @offset`,
    )
    .all({
      ...where.params,
      ...(fts ? { decay: decayFactor(), ...relevanceParams(filter.q!, fts) } : {}),
      limit: filter.limit,
      offset: filter.offset,
    }) as Array<{
    hasCover: number;
  }>;
  return { items: items.map(coerceHasCover), total, limit: filter.limit, offset: filter.offset };
}

/** Parameter für die Trefferqualität: Suchbegriff als Sortierschlüssel (Anfang des Titels) und nur im Titel */
function relevanceParams(q: string, fts: string) {
  const qkey = sortKey(q);
  return { qkey, qkeyEnd: `${qkey}\uffff`, ftsTitle: `title : (${fts})` };
}

// Sortiert wird über die Schlüssel aus text.ts sortKey (Umlaute bei ihrem Grundbuchstaben, Zahlen nach Wert).
const ALBUM_SORT: Record<AlbumSort, string> = {
  title: 'a.sort_title, a.id',
  artist: 'a.sort_artist, a.year, a.sort_title',
  // Innerhalb eines Jahres Gottesdienste nach Datum, neueste zuerst
  year: 'a.year IS NULL, a.year DESC, a.date DESC NULLS LAST, a.sort_title',
  recent: 'a.created_at DESC, a.date DESC NULLS LAST, a.id DESC',
  // Alben mit Datum im Ordnernamen zuerst (neueste oben), danach der Rest nach Interpret
  date: 'a.date DESC NULLS LAST, a.sort_artist, a.year, a.sort_title',
  // Für Vorschläge: oft Gehörtes zuerst, sonst wie nach Datum
  popular: `${albumTierSql('a')} DESC, a.date DESC NULLS LAST, a.year DESC, a.sort_title`,
};

/** Sortierungen, bei denen eine Suche oft Gehörtes nach vorne holt; die übrigen wählt man bewusst. */
const SEARCH_BOOSTED: ReadonlySet<AlbumSort> = new Set(['artist', 'date']);

export function searchAlbums(db: DB, filter: AlbumFilter): Page<Record<string, unknown>> {
  const where: Where = { clauses: [], params: {} };
  const fts = filter.q ? toFtsQuery(filter.q) : undefined;
  if (filter.q && !fts) return { items: [], total: 0, limit: filter.limit, offset: filter.offset };
  if (fts) {
    // Album trifft, wenn sein eigener Titel oder Titel, Interpret, Album oder Genre eines seiner Titel passt.
    where.clauses.push(
      `(a.id IN (SELECT rowid FROM albums_fts WHERE albums_fts MATCH @fts)
        OR a.id IN (SELECT album_id FROM album_tracks WHERE track_id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH @fts)))`,
    );
    where.params.fts = fts;
  }
  if (filter.artist) {
    where.clauses.push(
      `(has_artist(a.artist, @artistKey) OR a.id IN (
        SELECT at.album_id FROM album_tracks at JOIN tracks t ON t.id = at.track_id WHERE has_artist(t.artist, @artistKey)))`,
    );
    where.params.artistKey = artistKey(filter.artist);
  }
  if (!filter.includeHidden) where.clauses.push('a.hidden = 0');
  if (filter.ids) {
    where.clauses.push('a.id IN (SELECT value FROM json_each(@ids))');
    where.params.ids = JSON.stringify(filter.ids);
  }
  if (filter.dated !== undefined) where.clauses.push(filter.dated ? 'a.date IS NOT NULL' : 'a.date IS NULL');
  if (filter.kind) {
    where.clauses.push('a.kind = @kind');
    where.params.kind = filter.kind;
  }
  if (filter.category) {
    where.clauses.push(`a.id IN (SELECT album_id FROM album_tracks WHERE track_id IN (${categoryTracks(where, filter.category)}))`);
  }
  commonFilters(where, 'a', filter);

  const { total } = db.prepare(`SELECT count(*) AS total FROM albums a ${sql(where)}`).get(where.params) as {
    total: number;
  };
  // Bei einer Suche: Treffer im Albumtitel (genau, dann am Anfang), dann im Interpreten, dann nur in
  // enthaltenen Titeln; innerhalb davon oft Gehörtes. Bewusst gewählte Sortierungen bleiben unberührt.
  const boosted = fts !== undefined && SEARCH_BOOSTED.has(filter.sort);
  const boost = boosted
    ? `CASE WHEN a.sort_title = @qkey THEN 0 WHEN a.sort_title >= @qkey AND a.sort_title < @qkeyEnd THEN 1
            WHEN a.id IN (SELECT rowid FROM albums_fts WHERE albums_fts MATCH @fts) THEN 2 ELSE 3 END, ${albumTierSql('a')} DESC, `
    : '';
  const order = `${boost}${ALBUM_SORT[filter.sort]}`;
  const items = (
    db
      .prepare(
        `SELECT ${ALBUM_COLUMNS}${filter.includeHidden ? ', a.hidden' : ''} FROM albums a ${sql(where)} ORDER BY ${order} LIMIT @limit OFFSET @offset`,
      )
      .all({
        ...where.params,
        ...(order.includes('@decay') ? { decay: decayFactor() } : {}),
        ...(boosted ? relevanceParams(filter.q!, fts) : {}),
        limit: filter.limit,
        offset: filter.offset,
      }) as Array<{ hasCover: number }>
  ).map(coerceHasCover);
  return { items, total, limit: filter.limit, offset: filter.offset };
}

export function getAlbum(
  db: DB,
  id: number,
  options: { includeHidden?: boolean } = {},
): (Record<string, unknown> & { tracks: Array<Record<string, unknown>> }) | undefined {
  const album = db.prepare(`SELECT ${ALBUM_COLUMNS}, a.hidden FROM albums a WHERE a.id = ?`).get(id) as
    | { hasCover: number; hidden: number }
    | undefined;
  if (!album || (album.hidden && !options.includeHidden)) return undefined;
  const tracks = db
    .prepare(
      `SELECT ${TRACK_COLUMNS} FROM album_tracks at JOIN tracks t ON t.id = at.track_id
       WHERE at.album_id = ? ORDER BY at.position`,
    )
    .all(id) as Array<{ hasCover: number }>;
  const { hidden, ...rest } = coerceHasCover(album);
  return { ...rest, ...(options.includeHidden ? { hidden } : {}), tracks: tracks.map(coerceHasCover) };
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
export type CoverSource = { path: string; etag: string | null } | { coverId: number };

/** Albumcover: Bild im Albumordner hat Vorrang vor dem eingebetteten. */
export function getAlbumCover(db: DB, id: number): CoverSource | undefined {
  const row = db
    .prepare(
      `SELECT a.cover_path, a.cover_id, (SELECT etag FROM folder_covers WHERE path = a.cover_path LIMIT 1) AS etag
       FROM albums a WHERE a.id = ?`,
    )
    .get(id) as { cover_path: string | null; cover_id: number | null; etag: string | null } | undefined;
  if (row?.cover_path) return { path: row.cover_path, etag: row.etag };
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

interface ArtistEntry {
  key: string;
  name: string;
  albumCount: number;
  trackCount: number;
}

const artistCache = new WeakMap<DB, { version: string; artists: ArtistEntry[] }>();

/**
 * Alle Interpreten aus Titel- und Album-Interpret, zusammengefasst über Schreibweisen ("Hillsong UNITED",
 * "Hillsong United") und Gastauftritte ("Anna feat. Ben" zählt bei Anna und bei Ben). Angezeigt wird
 * die häufigste Schreibweise. Wird je Bibliotheksstand einmal berechnet.
 */
function allArtists(db: DB): ArtistEntry[] {
  const { n, albums } = db.prepare('SELECT count(*) AS n, total(album_id) AS albums FROM tracks').get() as { n: number; albums: number };
  const version = `${getMeta(db, 'lastScanAt') ?? ''}:${n}:${albums}`;
  const cached = artistCache.get(db);
  if (cached?.version === version) return cached.artists;

  const rows = db.prepare('SELECT id, artist, album_artist, album_id FROM tracks').all() as Array<{
    id: number;
    artist: string;
    album_artist: string | null;
    album_id: number | null;
  }>;
  const byKey = new Map<string, { spellings: Map<string, number>; albums: Set<number>; tracks: Set<number> }>();
  for (const row of rows) {
    const names = new Set([...artistNames(row.artist), ...(row.album_artist ? artistNames(row.album_artist) : [])]);
    for (const name of names) {
      const key = artistKey(name);
      if (!key) continue;
      let entry = byKey.get(key);
      if (!entry) byKey.set(key, (entry = { spellings: new Map(), albums: new Set(), tracks: new Set() }));
      entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
      if (row.album_id !== null) entry.albums.add(row.album_id);
      entry.tracks.add(row.id);
    }
  }
  const artists = [...byKey]
    .map(([key, entry]) => ({
      key,
      name: [...entry.spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0],
      albumCount: entry.albums.size,
      trackCount: entry.tracks.size,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  artistCache.set(db, { version, artists });
  return artists;
}

export function listArtists(db: DB, q: string | undefined, limit: number, offset: number) {
  const needle = q ? foldValue(q) : '';
  const matches = needle ? allArtists(db).filter((artist) => foldValue(artist.name).includes(needle)) : allArtists(db);
  const items = matches.slice(offset, offset + limit).map(({ name, albumCount, trackCount }) => ({ name, albumCount, trackCount }));
  return { items, total: matches.length, limit, offset };
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
      `SELECT (SELECT count(*) FROM tracks) AS tracks, (SELECT count(*) FROM albums WHERE hidden = 0) AS albums,
              (SELECT coalesce(sum(duration), 0) FROM tracks) AS duration`,
    )
    .get();
  return { genres, decades, totals };
}
