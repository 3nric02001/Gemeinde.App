import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import { MANUAL_KEY_PREFIX, rebuildAlbums } from './albums.js';
import { getAlbum } from './queries.js';
import { evaluateRules, listRules, parseCondition, ruleMatcher, type RuleCondition, type RuleTrack } from './rules.js';

/**
 * Admin-Werkzeuge für Alben: manuelle Alben zusammenstellen und automatische korrigieren.
 * Gespeichert wird nur, was der Admin festlegt (album_overrides, track_exclusions,
 * manual_album_tracks); die Alben selbst baut rebuildAlbums danach und nach jedem Scan neu.
 */

/** Regel aus der API: entweder `condition` (auch verschachtelt) oder eine einzelne Bedingung field/op/value */
export interface RuleInput {
  condition?: unknown;
  field?: string;
  op?: string;
  value?: string;
  move?: boolean;
}

export function toCondition(input: RuleInput | unknown): RuleCondition {
  const body = (input ?? {}) as RuleInput;
  try {
    return parseCondition(body.condition ?? { field: body.field, op: body.op, value: body.value });
  } catch (error) {
    throw new CurationError(400, (error as Error).message);
  }
}

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
  /** Angaben zur Predigt, überschreiben die Werte aus den Tags */
  speaker?: string | null;
  passage?: string | null;
  description?: string | null;
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
function trackPaths(db: DB, trackIds: number[]): Array<{ id: number; path: string; albumKey: string | null }> {
  const unique = [...new Set(trackIds)];
  if (!unique.length) return [];
  const rows = db
    .prepare(`SELECT id, path, album_key AS albumKey FROM tracks WHERE id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as Array<{ id: number; path: string; albumKey: string | null }>;
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

const TEXT_FIELDS = ['title', 'artist', 'genre', 'speaker', 'passage', 'description'] as const;

function writeOverride(db: DB, key: string, fields: AlbumFields): void {
  const current = (db
    .prepare('SELECT title, artist, year, genre, speaker, passage, description, hidden FROM album_overrides WHERE key = ?')
    .get(key) as Record<(typeof TEXT_FIELDS)[number], string | null> & { year: number | null; hidden: number } | undefined) ?? {
    title: null, artist: null, year: null, genre: null, speaker: null, passage: null, description: null, hidden: 0,
  };
  const next: Record<string, unknown> = {
    key,
    year: fields.year !== undefined ? fields.year : current.year,
    hidden: fields.hidden !== undefined ? (fields.hidden ? 1 : 0) : current.hidden,
  };
  for (const field of TEXT_FIELDS) next[field] = fields[field] !== undefined ? cleanText(fields[field]) ?? null : current[field];
  if (TEXT_FIELDS.every((field) => !next[field]) && next.year === null && !next.hidden) {
    db.prepare('DELETE FROM album_overrides WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO album_overrides (key, title, artist, year, genre, speaker, passage, description, hidden)
     VALUES (@key, @title, @artist, @year, @genre, @speaker, @passage, @description, @hidden)
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, artist = excluded.artist, year = excluded.year,
       genre = excluded.genre, speaker = excluded.speaker, passage = excluded.passage, description = excluded.description,
       hidden = excluded.hidden`,
  ).run(next);
}

/** Nimmt Titel aus ihrem automatischen Album heraus (für "verschieben" statt "zusätzlich"). */
function excludeFromAuto(db: DB, tracks: Array<{ path: string; albumKey: string | null }>): void {
  const insert = db.prepare('INSERT OR IGNORE INTO track_exclusions (path, album_key) VALUES (?, ?)');
  for (const track of tracks) if (track.albumKey !== null) insert.run(track.path, track.albumKey);
}

export function albumDetail(db: DB, id: number) {
  const album = getAlbum(db, id, { includeHidden: true });
  if (!album) throw new CurationError(404, 'Album nicht gefunden');
  const row = findAlbum(db, id);
  const override = db
    .prepare('SELECT title, artist, year, genre, speaker, passage, description FROM album_overrides WHERE key = ?')
    .get(row.key) as
    | {
        title: string | null;
        artist: string | null;
        year: number | null;
        genre: string | null;
        speaker: string | null;
        passage: string | null;
        description: string | null;
      }
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
  // Titel, die über eine Regel im Album stehen (nicht von Hand eingetragen)
  const explicit = new Set(
    (db.prepare('SELECT path FROM manual_album_tracks WHERE album_id = ?').all(id) as Array<{ path: string }>).map((r) => r.path),
  );
  const paths = new Map(
    (db.prepare('SELECT t.id, t.path FROM album_tracks at JOIN tracks t ON t.id = at.track_id WHERE at.album_id = ?').all(id) as Array<{
      id: number;
      path: string;
    }>).map((r) => [r.id, r.path]),
  );
  const ruleTrackIds = row.kind === 'manual' ? [...paths].filter(([, path]) => !explicit.has(path)).map(([trackId]) => trackId) : [];
  // Dateiname und Korrekturen je Titel, damit die Verwaltung zeigt, woraus ein Titel entstanden ist
  const trackFiles: Record<number, { file: string; override: { content: string | null; title: string | null; name: string | null } | null }> = {};
  for (const row of db
    .prepare(
      `SELECT t.id, t.path, o.content, o.title, o.name, o.path IS NOT NULL AS corrected FROM album_tracks at
       JOIN tracks t ON t.id = at.track_id LEFT JOIN track_overrides o ON o.path = t.path WHERE at.album_id = ?`,
    )
    .all(id) as Array<{ id: number; path: string; content: string | null; title: string | null; name: string | null; corrected: number }>) {
    trackFiles[row.id] = {
      file: row.path.slice(row.path.lastIndexOf('/') + 1),
      override: row.corrected ? { content: row.content, title: row.title, name: row.name } : null,
    };
  }
  return {
    ...album,
    trackFiles,
    rules: listRules(db, id),
    ruleTrackIds,
    movedByRule: row.kind === 'auto' ? movedByRule(db, row.key) : [],
    overrides: {
      title: override?.title ?? null,
      artist: override?.artist ?? null,
      year: override?.year ?? null,
      genre: override?.genre ?? null,
      speaker: override?.speaker ?? null,
      passage: override?.passage ?? null,
      description: override?.description ?? null,
    },
    excluded,
    missing,
  };
}

export function createManualAlbum(
  db: DB,
  fields: AlbumFields & { title: string; trackIds?: number[]; move?: boolean; rules?: RuleInput[] },
): number {
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
    for (const rule of fields.rules ?? []) insertRule(db, id, rule);
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

/** Titel eines automatischen Albums, die eine Regel in ein eigenes Album verschiebt */
function movedByRule(db: DB, key: string) {
  const tracks = allRuleTracks(db);
  const { members, moved } = evaluateRules(db, tracks);
  const result: Array<{ id: number; title: string; artist: string; albumId: number; albumTitle: string }> = [];
  const titles = new Map(
    (db.prepare("SELECT id, title FROM albums WHERE kind = 'manual'").all() as Array<{ id: number; title: string }>).map((r) => [
      r.id,
      r.title,
    ]),
  );
  for (const [albumId, list] of members) {
    for (const track of list) {
      if (!moved.has(track.id) || track.album_key !== key) continue;
      if (result.some((r) => r.id === track.id)) continue;
      result.push({ id: track.id, title: track.title, artist: track.artist, albumId, albumTitle: titles.get(albumId) ?? '' });
    }
  }
  return result;
}

function allRuleTracks(db: DB): Array<RuleTrack & { album_key: string | null }> {
  return db
    .prepare('SELECT id, path, title, artist, album_artist, album, genre, year, disc_no, track_no, album_key FROM tracks')
    .all() as Array<RuleTrack & { album_key: string | null }>;
}

/** Vorschau: welche Titel eine Regel treffen würde */
export function previewRule(db: DB, condition: RuleCondition, limit = 20) {
  const matches = ruleMatcher(condition);
  const hits = allRuleTracks(db).filter(matches);
  return {
    total: hits.length,
    items: hits.slice(0, limit).map(({ id, title, artist, album }) => ({ id, title, artist, album })),
  };
}

function insertRule(db: DB, albumId: number, rule: RuleInput): void {
  db.prepare('INSERT INTO album_rules (album_id, condition, move, created_at) VALUES (?, ?, ?, ?)').run(
    albumId,
    JSON.stringify(toCondition(rule)),
    rule.move ? 1 : 0,
    Date.now(),
  );
}

export function addRule(db: DB, albumId: number, rule: RuleInput): void {
  requireManual(findAlbum(db, albumId));
  insertRule(db, albumId, rule);
  rebuildAlbums(db);
}

export function updateRule(db: DB, albumId: number, ruleId: number, rule: RuleInput): void {
  const condition = toCondition(rule);
  const { changes } = db
    .prepare('UPDATE album_rules SET condition = ?, move = ? WHERE id = ? AND album_id = ?')
    .run(JSON.stringify(condition), rule.move ? 1 : 0, ruleId, albumId);
  if (!changes) throw new CurationError(404, 'Regel nicht gefunden');
  rebuildAlbums(db);
}

export function deleteRule(db: DB, albumId: number, ruleId: number): void {
  const { changes } = db.prepare('DELETE FROM album_rules WHERE id = ? AND album_id = ?').run(ruleId, albumId);
  if (!changes) throw new CurationError(404, 'Regel nicht gefunden');
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
    const unremove = db.prepare('DELETE FROM manual_album_removed WHERE album_id = ? AND path = ?');
    tracks.forEach((track, index) => {
      insert.run(id, track.path, last + index + 1);
      unremove.run(id, track.path);
    });
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
    // Was bisher im Album stand (auch per Regel) und jetzt fehlt, bleibt draußen.
    const wanted = new Set(tracks.map((t) => t.path));
    const before = db
      .prepare('SELECT t.path FROM album_tracks at JOIN tracks t ON t.id = at.track_id WHERE at.album_id = ?')
      .all(id) as Array<{ path: string }>;
    const remove = db.prepare('INSERT OR IGNORE INTO manual_album_removed (album_id, path) VALUES (?, ?)');
    for (const { path } of before) if (!wanted.has(path)) remove.run(id, path);
    const unremove = db.prepare('DELETE FROM manual_album_removed WHERE album_id = ? AND path = ?');
    for (const path of wanted) unremove.run(id, path);
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
    // Damit eine Regel den Titel nicht gleich wieder hinzufügt
    db.prepare('INSERT OR IGNORE INTO manual_album_removed (album_id, path) VALUES (?, ?)').run(id, track!.path);
  } else {
    if (track!.albumKey !== album.key) throw new CurationError(404, 'Titel ist nicht in diesem Album');
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

export interface TrackFields {
  content?: string | null;
  title?: string | null;
  name?: string | null;
}

/**
 * Korrigiert, was die App aus dem Dateinamen einer Aufnahme liest: Inhalt, Titel und Name (Sprecher bzw.
 * Interpret). null setzt auf automatisch zurück. Gespeichert nach Pfad, übersteht also jeden Scan.
 */
export function setTrackOverride(db: DB, trackId: number, fields: TrackFields): void {
  const [track] = trackPaths(db, [trackId]);
  const current = (db.prepare('SELECT content, title, name FROM track_overrides WHERE path = ?').get(track!.path) as
    | { content: string | null; title: string | null; name: string | null }
    | undefined) ?? { content: null, title: null, name: null };
  const next = {
    content: fields.content !== undefined ? (cleanText(fields.content) ?? null) : current.content,
    title: fields.title !== undefined ? (cleanText(fields.title) ?? null) : current.title,
    name: fields.name !== undefined ? (cleanText(fields.name) ?? null) : current.name,
  };
  if (next.content === null && next.title === null && next.name === null) {
    db.prepare('DELETE FROM track_overrides WHERE path = ?').run(track!.path);
  } else {
    db.prepare(
      `INSERT INTO track_overrides (path, content, title, name) VALUES (@path, @content, @title, @name)
       ON CONFLICT(path) DO UPDATE SET content = excluded.content, title = excluded.title, name = excluded.name`,
    ).run({ path: track!.path, ...next });
  }
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
