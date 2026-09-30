import type { DB } from '../db.js';
import { getTracksByIds, searchAlbums } from './queries.js';
import { sermonSeconds } from './settings.js';

/**
 * Persönliches je Hörer: Favoriten, zuletzt gehörte Alben und die Stelle zum Weiterhören.
 * Alles hängt am Benutzer und verschwindet mit ihm (ON DELETE CASCADE).
 */

export type FavoriteKind = 'track' | 'album';

/**
 * Ab dieser Länge (Verwaltung → Zuordnung, „Predigt-Player ab“) merkt sich die App die Stelle (Predigten, Gottesdienste), kürzere Titel beginnen vorne.
 * Das gilt nur, wenn keine Policy den Player festlegt: Predigt-Player heißt immer weiterhören, Musik-Player nie.
 */
export const resumeMinDuration = () => sermonSeconds();
/** Titel mit Weiterhören (Parameter: Mindestlänge) */
const RESUMABLE = `(t.playback = 'sermon' OR (t.playback IS NULL AND coalesce(l.duration, t.duration) >= ?))`;
/** So nah am Ende gilt ein Titel als fertig gehört. */
const FINISHED_MARGIN = 30;

export function setFavorite(db: DB, userId: number, kind: FavoriteKind, itemId: number, on: boolean): boolean {
  if (!on) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND kind = ? AND item_id = ?').run(userId, kind, itemId);
    return true;
  }
  const exists =
    kind === 'track'
      ? db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(itemId)
      : db.prepare('SELECT 1 FROM albums WHERE id = ? AND hidden = 0').get(itemId);
  if (!exists) return false;
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, kind, item_id, created_at) VALUES (?, ?, ?, ?)').run(
    userId,
    kind,
    itemId,
    Date.now(),
  );
  return true;
}

/** Favoriten, neueste zuerst; verschwundene Titel und ausgeblendete Alben fallen heraus. */
export function listFavorites(db: DB, userId: number) {
  const ids = (kind: FavoriteKind) =>
    (
      db
        .prepare('SELECT item_id FROM favorites WHERE user_id = ? AND kind = ? ORDER BY created_at DESC, item_id DESC LIMIT 1000')
        .all(userId, kind) as Array<{ item_id: number }>
    ).map((row) => row.item_id);
  return { tracks: getTracksByIds(db, ids('track')), albums: albumsByIds(db, ids('album')) };
}

/** Sichtbare Alben in der angegebenen Reihenfolge */
export function albumsByIds(db: DB, ids: number[]): Record<string, unknown>[] {
  if (!ids.length) return [];
  const { items } = searchAlbums(db, { sort: 'title', limit: ids.length, offset: 0, ids });
  const byId = new Map(items.map((album) => [album.id as number, album]));
  return ids.map((id) => byId.get(id)).filter((album) => album !== undefined);
}

/**
 * Hörstand speichern; `position` am Ende des Titels heißt "fertig gehört".
 * `duration` ist die Länge laut Browser, die gilt vor der aus dem Scan.
 */
export function saveProgress(db: DB, userId: number, trackId: number, position: number, duration?: number): boolean {
  if (!db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(trackId)) return false;
  db.prepare(
    `INSERT INTO listening (user_id, track_id, position, duration, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, track_id) DO UPDATE SET position = excluded.position,
       duration = coalesce(excluded.duration, listening.duration), updated_at = excluded.updated_at`,
  ).run(userId, trackId, Math.max(0, position), duration && duration > 0 ? duration : null, Date.now());
  return true;
}

/** Länge eines gehörten Titels: vom Browser gemessen, sonst aus dem Scan */
const LENGTH = 'coalesce(l.duration, t.duration)';

/** Gespeicherte Stellen langer Titel, die noch nicht zu Ende gehört sind */
export function listProgress(db: DB, userId: number): Array<{ trackId: number; position: number; duration: number }> {
  return db
    .prepare(
      `SELECT l.track_id AS trackId, l.position, ${LENGTH} AS duration FROM listening l JOIN tracks t ON t.id = l.track_id
       WHERE l.user_id = ? AND ${RESUMABLE} AND l.position > 0 AND l.position < ${LENGTH} - ?
       ORDER BY l.updated_at DESC LIMIT 500`,
    )
    .all(userId, resumeMinDuration(), FINISHED_MARGIN) as Array<{ trackId: number; position: number; duration: number }>;
}

/** Für die Startseite: angefangene lange Titel und die zuletzt gehörten Alben. */
export function listenerHome(db: DB, userId: number) {
  const unfinished = db
    .prepare(
      `SELECT l.track_id AS id, l.position, ${LENGTH} AS duration FROM listening l JOIN tracks t ON t.id = l.track_id
       WHERE l.user_id = ? AND ${RESUMABLE} AND l.position >= 15 AND l.position < ${LENGTH} - ?
       ORDER BY l.updated_at DESC LIMIT 6`,
    )
    .all(userId, resumeMinDuration(), FINISHED_MARGIN) as Array<{ id: number; position: number; duration: number }>;
  const rows = new Map(unfinished.map((row) => [row.id, row]));
  const resume = getTracksByIds(
    db,
    unfinished.map((row) => row.id),
  ).map((track) => ({ ...track, position: rows.get(track.id as number)!.position, duration: rows.get(track.id as number)!.duration }));

  const recentIds = (
    db
      .prepare(
        `SELECT t.album_id AS id, max(l.updated_at) AS at FROM listening l JOIN tracks t ON t.id = l.track_id
         WHERE l.user_id = ? AND t.album_id IS NOT NULL
         GROUP BY t.album_id ORDER BY at DESC LIMIT 12`,
      )
      .all(userId) as Array<{ id: number }>
  ).map((row) => row.id);
  return { resume, recent: albumsByIds(db, recentIds) };
}
