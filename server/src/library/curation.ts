import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { DB } from '../db.js';
import { MANUAL_KEY_PREFIX, rebuildAlbums } from './albums.js';
import { lastChange } from './changes.js';
import { searchText } from './metadata.js';
import { getAlbum } from './queries.js';
import type { Decision, Player } from './policies.js';
import { compileStructure, FIXED_KINDS, getStructure, kindOfFolder, MUSIC_KIND, normalizeManualKind, type KindSource } from './structure.js';
import { foldValue } from './text.js';
import { albumFolderOf } from './pathMeta.js';
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
  year?: number | null;
  /** Angaben zur Predigt, überschreiben die Werte aus den Dateinamen */
  speaker?: string | null;
  passage?: string | null;
  description?: string | null;
  hidden?: boolean;
  /** Art der Aufnahme von Hand ("Bibelstunde", "Musik", "Sonstiges"); "" heißt Musik, null: nach dem Regelwerk */
  recording?: string | null;
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
    throw new CurationError(409, 'Nur bei Playlists möglich; automatische Alben lassen sich ausblenden oder korrigieren');
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

const TEXT_FIELDS = ['title', 'speaker', 'passage', 'description'] as const;

/** Art von Hand: muss es im Regelwerk geben; Musik, Sonstiges und null (automatisch) gehen immer, "" heißt Musik */
function checkRecording(db: DB, value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const name = value.trim();
  if (!name) return MUSIC_KIND;
  const fixed = FIXED_KINDS.find((k) => foldValue(k) === foldValue(name));
  if (fixed) return fixed;
  const kind = getStructure(db).kinds.find((k) => foldValue(k.name) === foldValue(name));
  if (!kind) throw new CurationError(400, `Die Art „${name}“ gibt es nicht (Verwaltung → Zuordnung)`);
  return kind.name;
}

function writeOverride(db: DB, key: string, fields: AlbumFields): void {
  const current = (db
    .prepare('SELECT title, year, speaker, passage, description, hidden, cover_id, recording FROM album_overrides WHERE key = ?')
    .get(key) as
    | (Record<(typeof TEXT_FIELDS)[number], string | null> & {
        year: number | null;
        hidden: number;
        cover_id: number | null;
        recording: string | null;
      })
    | undefined) ?? {
    title: null, year: null, speaker: null, passage: null, description: null, hidden: 0, cover_id: null,
    recording: null,
  };
  const recording = checkRecording(db, fields.recording);
  const next: Record<string, unknown> = {
    key,
    year: fields.year !== undefined ? fields.year : current.year,
    hidden: fields.hidden !== undefined ? (fields.hidden ? 1 : 0) : current.hidden,
    recording: recording !== undefined ? recording : current.recording,
  };
  for (const field of TEXT_FIELDS) next[field] = fields[field] !== undefined ? cleanText(fields[field]) ?? null : current[field];
  // Das Titelbild ändert nur setAlbumCover; die Zeile bleibt, solange eines gesetzt ist.
  if (
    TEXT_FIELDS.every((field) => !next[field]) &&
    next.year === null &&
    !next.hidden &&
    next.recording === null &&
    !current.cover_id
  ) {
    db.prepare('DELETE FROM album_overrides WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO album_overrides (key, title, year, speaker, passage, description, hidden, recording)
     VALUES (@key, @title, @year, @speaker, @passage, @description, @hidden, @recording)
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, year = excluded.year,
       speaker = excluded.speaker, passage = excluded.passage, description = excluded.description,
       hidden = excluded.hidden, recording = excluded.recording`,
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
    .prepare('SELECT title, year, speaker, passage, description, recording FROM album_overrides WHERE key = ?')
    .get(row.key) as
    | {
        recording: string | null;
        title: string | null;
        year: number | null;
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
            `SELECT t.id, coalesce(t.display_title, t.title) AS title, t.duration FROM track_exclusions e JOIN tracks t ON t.path = e.path
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
  // Je Titel: was Datei und Regelwerk ergeben und was in der Verwaltung korrigiert wurde
  const trackEdits = db
    .prepare(
      `SELECT t.id, coalesce(t.display_title, t.title) AS fileTitle, o.title, o.speaker, o.sermon, o.player, t.policy AS auto,
              t.speaker AS fileSpeaker
       FROM album_tracks at JOIN tracks t ON t.id = at.track_id LEFT JOIN track_overrides o ON o.path = t.path
       WHERE at.album_id = ? ORDER BY at.position`,
    )
    .all(id) as Array<TrackEdit & { sermon: number | null; auto: string | null }>;
  const customCover = db.prepare('SELECT 1 FROM album_overrides WHERE key = ? AND cover_id IS NOT NULL').get(row.key) !== undefined;
  const { folder } = db.prepare('SELECT folder FROM albums WHERE id = ?').get(id) as { folder: string };
  // Woher die Art kommt (von Hand, Regel in "Art bestimmen", Vorgabe für Ordner mit Datum), wie in rebuildAlbums
  let recordingSource: KindSource = { by: 'none' };
  if (row.kind === 'auto') {
    // Die Regeln sehen alle Dateien im Albumordner, auch wenn er sich nach Datum in mehrere Alben teilt (wie rebuildAlbums)
    const files = folder
      ? (db.prepare(`SELECT path, title FROM tracks WHERE substr(path, 1, ?) = ?`).all(folder.length + 1, `${folder}/`) as Array<{
          path: string;
          title: string;
        }>).filter((t) => albumFolderOf(t.path) === folder)
      : [];
    recordingSource = override?.recording != null
      ? { by: 'manual' }
      : kindOfFolder(compileStructure(getStructure(db)), folder, files).source;
    // Aufnahmen ohne eigenen Ordner mit Datum (Datum im Dateinamen) bekommen die Vorgabe für Ordner mit Datum
    if (recordingSource.by === 'none' && album.date) recordingSource = { by: 'default' };
  }
  return {
    ...album,
    /** Albumordner in der Nextcloud; bei Gottesdiensten kommt das Datum aus seinem Namen */
    folder,
    trackEdits: trackEdits.map((edit) => ({
      ...edit,
      sermon: edit.sermon === null ? null : edit.sermon === 1,
      auto: edit.auto ? (JSON.parse(edit.auto) as Decision) : {},
    })),
    customCover,
    lastChange: lastChange(db, id) ?? null,
    rules: listRules(db, id),
    ruleTrackIds,
    movedByRule: row.kind === 'auto' ? movedByRule(db, row.key) : [],
    overrides: {
      title: override?.title ?? null,
      year: override?.year ?? null,
      speaker: override?.speaker ?? null,
      passage: override?.passage ?? null,
      description: override?.description ?? null,
    },
    /** Art von Hand (auch Musik oder Sonstiges), null: nach dem Regelwerk */
    manualRecording: normalizeManualKind(override?.recording) ?? null,
    /** Woher die Art kommt */
    recordingSource,
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
        `INSERT INTO albums (key, kind, title, folder, created_at) VALUES (?, 'manual', ?, '', ?) RETURNING id`,
      )
      .get(key, title, Date.now()) as { id: number };
    writeOverride(db, key, { ...fields, title, recording: undefined });
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
  if (album.kind === 'manual' && fields.recording) throw new CurationError(400, 'Playlists haben keine Art');
  writeOverride(db, album.key, fields);
  rebuildAlbums(db);
}

/** Titel eines automatischen Albums, die eine Regel in ein eigenes Album verschiebt */
function movedByRule(db: DB, key: string) {
  const tracks = allRuleTracks(db);
  const { members, moved } = evaluateRules(db, tracks);
  const result: Array<{ id: number; title: string; albumId: number; albumTitle: string }> = [];
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
      result.push({ id: track.id, title: track.displayTitle, albumId, albumTitle: titles.get(albumId) ?? '' });
    }
  }
  return result;
}

function allRuleTracks(db: DB): Array<RuleTrack & { album_key: string | null; displayTitle: string }> {
  return db
    .prepare(
      `SELECT id, path, title, coalesce((SELECT title FROM track_overrides o WHERE o.path = tracks.path), display_title, title) AS displayTitle,
              album, content, coalesce((SELECT speaker FROM track_overrides o WHERE o.path = tracks.path), speaker) AS speaker,
              year, disc_no, track_no, album_key
       FROM tracks`,
    )
    .all() as Array<RuleTrack & { album_key: string | null; displayTitle: string }>;
}

/** Vorschau: welche Titel eine Regel treffen würde */
export function previewRule(db: DB, condition: RuleCondition, limit = 20) {
  const matches = ruleMatcher(condition);
  const hits = allRuleTracks(db).filter(matches);
  return {
    total: hits.length,
    items: hits.slice(0, limit).map(({ id, displayTitle, album, speaker }) => ({ id, title: displayTitle, album, speaker })),
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

interface TrackEdit {
  id: number;
  /** Titelname aus der Datei */
  fileTitle: string;
  /** In der Verwaltung korrigierter Titelname, sonst null */
  title: string | null;
  speaker: string | null;
  /** Sprecher aus dem Dateinamen */
  fileSpeaker: string | null;
  /** Korrektur des Players, null: nach den Policies */
  player: Player | null;
}

export interface TrackFields {
  title?: string | null;
  speaker?: string | null;
  /** Gilt als Predigt; null: nach den Policies */
  sermon?: boolean | null;
  /** Predigt- oder Musik-Player; null: nach den Policies */
  player?: Player | null;
}

/**
 * Korrigiert Titelname oder Sprecher eines Titels. Gespeichert wird je Pfad (track_overrides),
 * damit die Korrektur neue Scans übersteht; null setzt auf den Wert aus der Datei zurück.
 */
export function updateTrack(db: DB, albumId: number, trackId: number, fields: TrackFields): void {
  findAlbum(db, albumId);
  if (!db.prepare('SELECT 1 FROM album_tracks WHERE album_id = ? AND track_id = ?').get(albumId, trackId)) {
    throw new CurationError(404, 'Titel ist nicht in diesem Album');
  }
  db.transaction(() => {
    const track = db.prepare('SELECT path, coalesce(display_title, title) AS fileTitle FROM tracks WHERE id = ?').get(trackId) as {
      path: string;
      fileTitle: string;
    };
    const current = (db.prepare('SELECT title, speaker, sermon, player FROM track_overrides WHERE path = ?').get(track.path) as
      | { title: string | null; speaker: string | null; sermon: number | null; player: Player | null }
      | undefined) ?? { title: null, speaker: null, sermon: null, player: null };
    const next = {
      title: fields.title !== undefined ? (cleanText(fields.title) ?? null) : current.title,
      speaker: fields.speaker !== undefined ? (cleanText(fields.speaker) ?? null) : current.speaker,
      sermon: fields.sermon !== undefined ? (fields.sermon === null ? null : fields.sermon ? 1 : 0) : current.sermon,
      player: fields.player !== undefined ? fields.player : current.player,
    };
    // Derselbe Name wie aus Datei und Regelwerk ist keine Korrektur.
    if (next.title === track.fileTitle) next.title = null;
    if (!next.title && !next.speaker && next.sermon === null && next.player === null) {
      db.prepare('DELETE FROM track_overrides WHERE path = ?').run(track.path);
    } else {
      db.prepare(
        `INSERT INTO track_overrides (path, title, speaker, sermon, player) VALUES (@path, @title, @speaker, @sermon, @player)
         ON CONFLICT(path) DO UPDATE SET title = excluded.title, speaker = excluded.speaker, sermon = excluded.sermon,
           player = excluded.player`,
      ).run({ path: track.path, ...next });
    }
    db.prepare('UPDATE tracks SET search_extra = ? WHERE id = ?').run(searchText([next.title, next.speaker]), trackId);
  })();
  rebuildAlbums(db);
}

/** Größte Kantenlänge eines hochgeladenen Titelbilds; reicht für den großen Player. */
export const COVER_UPLOAD_SIZE = 1600;
/** Größere Uploads lehnt der Server ab (siehe admin.ts). */
export const MAX_COVER_UPLOAD = 15 * 1024 * 1024;

/**
 * Setzt ein eigenes Titelbild (null entfernt es). Das Bild wird verkleinert und als JPEG
 * ohne Metadaten gespeichert, so landen z. B. keine Standortdaten aus Handyfotos in der App.
 */
export async function setAlbumCover(db: DB, id: number, image: Buffer | null): Promise<void> {
  const album = findAlbum(db, id);
  let coverId: number | null = null;
  if (image) {
    let data: Buffer;
    try {
      const input = sharp(image, { limitInputPixels: 60_000_000 });
      const { format } = await input.metadata();
      if (format !== 'jpeg' && format !== 'png' && format !== 'webp') throw new Error(`Format ${format}`);
      data = await input
        .rotate()
        .resize(COVER_UPLOAD_SIZE, COVER_UPLOAD_SIZE, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      throw new CurationError(400, 'Das Bild lässt sich nicht lesen. Bitte ein JPEG-, PNG- oder WebP-Bild hochladen.');
    }
    const hash = createHash('sha256').update(data).digest('hex');
    coverId = (
      db
        .prepare(
          `INSERT INTO covers (hash, mime, data) VALUES (?, 'image/jpeg', ?)
           ON CONFLICT(hash) DO UPDATE SET mime = excluded.mime RETURNING id`,
        )
        .get(hash, data) as { id: number }
    ).id;
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO album_overrides (key, cover_id) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET cover_id = excluded.cover_id`,
    ).run(album.key, coverId);
    // Leere Korrektur wieder entfernen, wie in writeOverride
    if (coverId === null) writeOverride(db, album.key, {});
  })();
  rebuildAlbums(db);
}
