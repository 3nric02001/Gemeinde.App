import type { DB } from '../db.js';
import { playlistSummaries } from './playlists.js';
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

/** Woraus ein Titel lief: eine Playlist der Verwaltung ('/album/5'), eine eigene ('/playlist/3') oder die Favoriten */
export const CONTEXT_PATTERN = '^(/(album|playlist)/[1-9][0-9]{0,9}|/favoriten)$';

/**
 * Hörstand speichern; `position` am Ende des Titels heißt "fertig gehört".
 * `duration` ist die Länge laut Browser, die gilt vor der aus dem Scan. `context`: woraus er lief (siehe CONTEXT_PATTERN).
 */
export function saveProgress(db: DB, userId: number, trackId: number, position: number, duration?: number, context?: string): boolean {
  if (!db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(trackId)) return false;
  db.prepare(
    `INSERT INTO listening (user_id, track_id, position, duration, updated_at, context) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, track_id) DO UPDATE SET position = excluded.position,
       duration = coalesce(excluded.duration, listening.duration), updated_at = excluded.updated_at, context = excluded.context,
       dismissed = CASE WHEN excluded.position = listening.position THEN listening.dismissed ELSE 0 END`,
  ).run(userId, trackId, Math.max(0, position), duration && duration > 0 ? duration : null, Date.now(), context ?? null);
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

/** Titel unter "Weiterhören" ausblenden; die Stelle bleibt, und hört man weiter, ist er wieder da. */
export function dismissResume(db: DB, userId: number, trackId: number): void {
  db.prepare('UPDATE listening SET dismissed = 1 WHERE user_id = ? AND track_id = ?').run(userId, trackId);
}

/** Für die Startseite: angefangene lange Titel (3 in der Liste, einer mehr für die Gottesdienst-Karte) und die zuletzt gehörten Alben. */
export function listenerHome(db: DB, userId: number) {
  const unfinished = db
    .prepare(
      `SELECT l.track_id AS id, l.position, ${LENGTH} AS duration FROM listening l JOIN tracks t ON t.id = l.track_id
       WHERE l.user_id = ? AND l.dismissed = 0 AND ${RESUMABLE} AND l.position >= 15 AND l.position < ${LENGTH} - ?
       ORDER BY l.updated_at DESC LIMIT 4`,
    )
    .all(userId, resumeMinDuration(), FINISHED_MARGIN) as Array<{ id: number; position: number; duration: number }>;
  const rows = new Map(unfinished.map((row) => [row.id, row]));
  const resume = getTracksByIds(
    db,
    unfinished.map((row) => row.id),
  ).map((track) => ({ ...track, position: rows.get(track.id as number)!.position, duration: rows.get(track.id as number)!.duration }));

  // Was aus einer Playlist lief, zählt für die Playlist, sonst für das Album des Titels.
  const played = db
    .prepare(
      `SELECT coalesce(l.context, '/album/' || t.album_id) AS href, max(l.updated_at) AS at
       FROM listening l JOIN tracks t ON t.id = l.track_id
       WHERE l.user_id = ? AND l.updated_at > 0 AND (l.context IS NOT NULL OR t.album_id IS NOT NULL)
       GROUP BY href ORDER BY at DESC LIMIT 24`,
    )
    .all(userId) as Array<{ href: string; at: number }>;
  const idsOf = (kind: string) =>
    played.filter((row) => row.href.startsWith(`/${kind}/`)).map((row) => Number(row.href.slice(kind.length + 2)));
  const at = new Map(played.map((row) => [row.href, row.at]));
  const albums = albumsByIds(db, idsOf('album')).map((album) => ({ ...album, playedAt: at.get(`/album/${album.id as number}`) }));
  const playlists = playlistSummaries(db, userId, idsOf('playlist')).map((playlist) => ({
    ...playlist,
    playedAt: at.get(`/playlist/${playlist.id}`),
  }));
  // Die Favoriten-Playlist nur, solange es Titel mit Herz gibt
  const hasFavorites = Boolean(db.prepare("SELECT 1 FROM favorites WHERE user_id = ? AND kind = 'track' LIMIT 1").get(userId));
  const favoritesAt = hasFavorites ? (at.get('/favoriten') ?? null) : null;
  // Alles zusammen höchstens 12, die zuletzt gehörten zuerst
  const times = [...albums, ...playlists].map((item) => item.playedAt ?? 0);
  if (favoritesAt) times.push(favoritesAt);
  const cutoff = times.sort((a, b) => b - a)[11] ?? 0;
  return {
    resume,
    recent: albums.filter((album) => (album.playedAt ?? 0) >= cutoff),
    recentPlaylists: playlists.filter((playlist) => (playlist.playedAt ?? 0) >= cutoff),
    /** Wann zuletzt aus den Favoriten gehört wurde; null: nicht unter den letzten */
    favoritesPlayedAt: favoritesAt && favoritesAt >= cutoff ? favoritesAt : null,
  };
}

/** Hörstand eines Gottesdienstes (bzw. einer Aufnahme mit Datum) für die Liste unter "Datum" */
export interface DatedState {
  albumId: number;
  /** neu seit dem letzten Besuch unter "Datum", angefangen oder zu Ende gehört */
  state: 'new' | 'started' | 'heard';
  /** Anteil der gehörten Zeit (0..1) bei angefangenen */
  progress?: number;
}

/** Wann der Benutzer zuletzt unter "Datum" war; beim ersten Mal gilt jetzt, damit nicht alles neu ist. */
function datesSeenAt(db: DB, userId: number): number {
  const row = db.prepare('SELECT dates_seen_at AS at FROM users WHERE id = ?').get(userId) as { at: number | null } | undefined;
  if (row?.at) return row.at;
  const now = Date.now();
  db.prepare('UPDATE users SET dates_seen_at = ? WHERE id = ?').run(now, userId);
  return now;
}

/**
 * Neu, angefangen, gehört: je Album mit Datum. Es zählen die Titel mit Weiterhören (Predigten); ein Album ist gehört,
 * wenn alle davon zu Ende gehört sind. Neu ist, was nach dem letzten Besuch unter "Datum" dazukam und noch nicht
 * angehört wurde.
 */
export function datedStates(db: DB, userId: number): { items: DatedState[]; fresh: number } {
  const rows = db
    .prepare(
      `SELECT a.id AS albumId, count(*) AS n,
         sum(CASE WHEN l.position >= ${LENGTH} - @margin THEN 1 ELSE 0 END) AS done,
         sum(CASE WHEN l.position > 0 THEN 1 ELSE 0 END) AS touched,
         sum(min(coalesce(l.position, 0), coalesce(${LENGTH}, 0))) AS heard,
         sum(coalesce(${LENGTH}, 0)) AS total
       FROM albums a JOIN album_tracks x ON x.album_id = a.id JOIN tracks t ON t.id = x.track_id
       LEFT JOIN listening l ON l.track_id = t.id AND l.user_id = @user
       WHERE a.date IS NOT NULL AND a.hidden = 0 AND ${RESUMABLE.replace('?', '@min')}
       GROUP BY a.id`,
    )
    .all({ user: userId, margin: FINISHED_MARGIN, min: resumeMinDuration() }) as Array<{
    albumId: number;
    n: number;
    done: number;
    touched: number;
    heard: number;
    total: number;
  }>;
  const items: DatedState[] = [];
  for (const row of rows) {
    if (row.done === row.n) items.push({ albumId: row.albumId, state: 'heard' });
    else if (row.touched > 0) items.push({ albumId: row.albumId, state: 'started', progress: row.total ? Math.min(1, row.heard / row.total) : 0 });
  }
  const fresh = (
    db
      .prepare(
        `SELECT a.id FROM albums a WHERE a.date IS NOT NULL AND a.hidden = 0 AND a.created_at > ?
         AND NOT EXISTS (SELECT 1 FROM album_tracks x JOIN listening l ON l.track_id = x.track_id
                         WHERE x.album_id = a.id AND l.user_id = ?)`,
      )
      .all(datesSeenAt(db, userId), userId) as Array<{ id: number }>
  ).map((row) => row.id);
  for (const id of fresh) items.push({ albumId: id, state: 'new' });
  return { items, fresh: fresh.length };
}

/** Der Benutzer war unter "Datum": was bis jetzt dazukam, ist nicht mehr neu. */
export function markDatesSeen(db: DB, userId: number): void {
  db.prepare('UPDATE users SET dates_seen_at = ? WHERE id = ?').run(Date.now(), userId);
}

/**
 * "Als gehört markieren": alle Titel des Albums gelten als zu Ende gehört, ohne unter "Zuletzt gehört" aufzutauchen
 * (updated_at 0). Umgekehrt löscht "Als ungehört markieren" den Hörstand der Titel. false: Album unbekannt.
 */
export function markAlbumHeard(db: DB, userId: number, albumId: number, heard: boolean): boolean {
  if (!db.prepare('SELECT 1 FROM albums WHERE id = ? AND hidden = 0').get(albumId)) return false;
  if (!heard) {
    db.prepare('DELETE FROM listening WHERE user_id = ? AND track_id IN (SELECT track_id FROM album_tracks WHERE album_id = ?)').run(
      userId,
      albumId,
    );
    return true;
  }
  db.prepare(
    `INSERT INTO listening (user_id, track_id, position, duration, updated_at)
     SELECT ?, t.id, t.duration, NULL, 0 FROM album_tracks x JOIN tracks t ON t.id = x.track_id
     WHERE x.album_id = ? AND t.duration > 0
     ON CONFLICT(user_id, track_id) DO UPDATE SET position = coalesce(listening.duration, excluded.position)`,
  ).run(userId, albumId);
  return true;
}
