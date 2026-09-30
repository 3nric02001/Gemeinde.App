import type { DB } from '../db.js';
import { getTracksByIds } from './queries.js';

/**
 * Eigene Playlists der Hörer. Der Besitzer stellt sie zusammen und kann sie mit anderen Benutzern teilen;
 * die sehen sie unter "Geteilt mit mir" und können sie hören, aber nicht ändern.
 * Die Playlists der Verwaltung sind etwas anderes (Alben der Art 'manual', für alle sichtbar).
 */

export const MAX_PLAYLISTS = 200;
export const MAX_PLAYLIST_TRACKS = 1000;
export const MAX_TITLE = 100;

export interface PlaylistSummary {
  id: number;
  title: string;
  trackCount: number;
  duration: number;
  /** Eigene Playlist; sonst mit dem Benutzer geteilt */
  mine: boolean;
  /** Wer sie angelegt hat (bei geteilten) */
  owner: string;
  /** Mit wie vielen sie geteilt ist (nur bei eigenen) */
  shared: number;
  /** Erster Titel mit Bild für das Cover */
  coverTrackId: number | null;
  updatedAt: number;
}

type Row = Omit<PlaylistSummary, 'mine' | 'coverTrackId'> & { ownerId: number; coverTrackId: number | null };

const SUMMARY = `
  SELECT p.id, p.title, p.updated_at AS updatedAt, p.owner_id AS ownerId, u.name AS owner,
    (SELECT count(*) FROM user_playlist_tracks x WHERE x.playlist_id = p.id) AS trackCount,
    (SELECT coalesce(sum(t.duration), 0) FROM user_playlist_tracks x JOIN tracks t ON t.id = x.track_id WHERE x.playlist_id = p.id) AS duration,
    (SELECT count(*) FROM user_playlist_shares s JOIN users v ON v.id = s.user_id WHERE s.playlist_id = p.id AND v.disabled = 0) AS shared,
    (SELECT x.track_id FROM user_playlist_tracks x JOIN tracks t ON t.id = x.track_id
     WHERE x.playlist_id = p.id AND (t.cover_id IS NOT NULL OR EXISTS (
       SELECT 1 FROM albums a WHERE a.id = t.album_id AND (a.cover_path IS NOT NULL OR a.cover_id IS NOT NULL)))
     ORDER BY x.position LIMIT 1) AS coverTrackId
  FROM user_playlists p JOIN users u ON u.id = p.owner_id`;

const toSummary = (userId: number) => ({ ownerId, ...row }: Row): PlaylistSummary => ({ ...row, mine: ownerId === userId });

/** Eigene Playlists (zuletzt geändert zuerst) und die, die andere mit dem Benutzer geteilt haben */
export function listPlaylists(db: DB, userId: number): { own: PlaylistSummary[]; shared: PlaylistSummary[] } {
  const own = db.prepare(`${SUMMARY} WHERE p.owner_id = ? ORDER BY p.updated_at DESC, p.id DESC`).all(userId) as Row[];
  // Playlists gesperrter Benutzer bleiben bei den Empfängern, bis der Benutzer gelöscht wird.
  const shared = db
    .prepare(
      `${SUMMARY} JOIN user_playlist_shares s ON s.playlist_id = p.id AND s.user_id = ?
       ORDER BY p.updated_at DESC, p.id DESC`,
    )
    .all(userId) as Row[];
  return { own: own.map(toSummary(userId)), shared: shared.map(toSummary(userId)) };
}

/** Sichtbare Playlists (eigene und geteilte) in der angegebenen Reihenfolge; andere fallen heraus. */
export function playlistSummaries(db: DB, userId: number, ids: number[]): PlaylistSummary[] {
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `${SUMMARY} WHERE p.id IN (SELECT value FROM json_each(@ids))
       AND (p.owner_id = @user OR EXISTS (SELECT 1 FROM user_playlist_shares s WHERE s.playlist_id = p.id AND s.user_id = @user))`,
    )
    .all({ ids: JSON.stringify(ids), user: userId }) as Row[];
  const byId = new Map(rows.map((row) => [row.id, toSummary(userId)(row)]));
  return ids.map((id) => byId.get(id)).filter((playlist) => playlist !== undefined);
}

/** Rolle des Benutzers bei einer Playlist: Besitzer, Empfänger oder keine (dann bleibt sie unsichtbar) */
function access(db: DB, userId: number, playlistId: number): 'owner' | 'recipient' | undefined {
  const row = db
    .prepare(
      `SELECT p.owner_id = @user AS mine,
         EXISTS (SELECT 1 FROM user_playlist_shares s WHERE s.playlist_id = p.id AND s.user_id = @user) AS shared
       FROM user_playlists p WHERE p.id = @id`,
    )
    .get({ user: userId, id: playlistId }) as { mine: number; shared: number } | undefined;
  if (!row) return undefined;
  if (row.mine) return 'owner';
  return row.shared ? 'recipient' : undefined;
}

export const isOwner = (db: DB, userId: number, playlistId: number) => access(db, userId, playlistId) === 'owner';

/** Eine Playlist mit Titeln; für den Besitzer auch, mit wem sie geteilt ist. undefined: gibt es nicht oder nicht sichtbar */
export function getPlaylist(db: DB, userId: number, playlistId: number) {
  const role = access(db, userId, playlistId);
  if (!role) return undefined;
  const summary = toSummary(userId)(db.prepare(`${SUMMARY} WHERE p.id = ?`).get(playlistId) as Row);
  const ids = (
    db.prepare('SELECT track_id FROM user_playlist_tracks WHERE playlist_id = ? ORDER BY position, track_id').all(playlistId) as Array<{
      track_id: number;
    }>
  ).map((row) => row.track_id);
  return {
    ...summary,
    tracks: getTracksByIds(db, ids),
    sharedWith: role === 'owner' ? shareRecipients(db, playlistId) : [],
  };
}

function shareRecipients(db: DB, playlistId: number): Array<{ id: number; name: string }> {
  return db
    .prepare(
      `SELECT u.id, u.name FROM user_playlist_shares s JOIN users u ON u.id = s.user_id
       WHERE s.playlist_id = ? AND u.disabled = 0 ORDER BY u.name COLLATE NOCASE, u.id`,
    )
    .all(playlistId) as Array<{ id: number; name: string }>;
}

export class PlaylistError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const cleanTitle = (title: string) => {
  const text = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (!text) throw new PlaylistError(400, 'Bitte einen Namen angeben');
  return text;
};

/** Nur Titel, die es gibt, jeder einmal, in der angegebenen Reihenfolge */
function existingTracks(db: DB, trackIds: number[]): number[] {
  const unique = [...new Set(trackIds)];
  if (!unique.length) return [];
  const found = new Set(
    (
      db.prepare('SELECT id FROM tracks WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(unique)) as Array<{ id: number }>
    ).map((row) => row.id),
  );
  return unique.filter((id) => found.has(id));
}

function touch(db: DB, playlistId: number): void {
  db.prepare('UPDATE user_playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId);
}

export function createPlaylist(db: DB, userId: number, title: string, trackIds: number[] = []): number {
  const name = cleanTitle(title);
  const { n } = db.prepare('SELECT count(*) AS n FROM user_playlists WHERE owner_id = ?').get(userId) as { n: number };
  if (n >= MAX_PLAYLISTS) throw new PlaylistError(409, `Höchstens ${MAX_PLAYLISTS} Playlists`);
  return db.transaction(() => {
    const now = Date.now();
    const { id } = db
      .prepare('INSERT INTO user_playlists (owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id')
      .get(userId, name, now, now) as { id: number };
    writeTracks(db, id, existingTracks(db, trackIds).slice(0, MAX_PLAYLIST_TRACKS));
    return id;
  })();
}

function writeTracks(db: DB, playlistId: number, trackIds: number[]): void {
  db.prepare('DELETE FROM user_playlist_tracks WHERE playlist_id = ?').run(playlistId);
  const insert = db.prepare('INSERT INTO user_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)');
  trackIds.forEach((id, index) => insert.run(playlistId, id, index + 1));
}

function requireOwner(db: DB, userId: number, playlistId: number): void {
  const role = access(db, userId, playlistId);
  if (!role) throw new PlaylistError(404, 'Playlist nicht gefunden');
  if (role !== 'owner') throw new PlaylistError(403, 'Nur wer die Playlist angelegt hat, kann sie ändern');
}

export function renamePlaylist(db: DB, userId: number, playlistId: number, title: string): void {
  requireOwner(db, userId, playlistId);
  db.prepare('UPDATE user_playlists SET title = ?, updated_at = ? WHERE id = ?').run(cleanTitle(title), Date.now(), playlistId);
}

export function deletePlaylist(db: DB, userId: number, playlistId: number): void {
  requireOwner(db, userId, playlistId);
  db.prepare('DELETE FROM user_playlists WHERE id = ?').run(playlistId);
}

/** Titel hinten anhängen; schon enthaltene bleiben, wo sie sind. Gibt zurück, wie viele neu dazukamen. */
export function addTracks(db: DB, userId: number, playlistId: number, trackIds: number[]): number {
  requireOwner(db, userId, playlistId);
  return db.transaction(() => {
    const present = new Set(
      (db.prepare('SELECT track_id FROM user_playlist_tracks WHERE playlist_id = ?').all(playlistId) as Array<{ track_id: number }>).map(
        (row) => row.track_id,
      ),
    );
    const fresh = existingTracks(db, trackIds).filter((id) => !present.has(id));
    if (present.size + fresh.length > MAX_PLAYLIST_TRACKS) {
      throw new PlaylistError(409, `Höchstens ${MAX_PLAYLIST_TRACKS} Titel je Playlist`);
    }
    const { last } = db.prepare('SELECT coalesce(max(position), 0) AS last FROM user_playlist_tracks WHERE playlist_id = ?').get(playlistId) as {
      last: number;
    };
    const insert = db.prepare('INSERT INTO user_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)');
    fresh.forEach((id, index) => insert.run(playlistId, id, last + index + 1));
    touch(db, playlistId);
    return fresh.length;
  })();
}

/** Neue Reihenfolge bzw. Titel entfernt: die Liste ersetzt die bisherige. */
export function setTracks(db: DB, userId: number, playlistId: number, trackIds: number[]): void {
  requireOwner(db, userId, playlistId);
  if (trackIds.length > MAX_PLAYLIST_TRACKS) throw new PlaylistError(409, `Höchstens ${MAX_PLAYLIST_TRACKS} Titel je Playlist`);
  db.transaction(() => {
    writeTracks(db, playlistId, existingTracks(db, trackIds));
    touch(db, playlistId);
  })();
}

/** Mit genau diesen Benutzern teilen; unbekannte, gesperrte und der Besitzer selbst fallen heraus. */
export function setShares(db: DB, userId: number, playlistId: number, userIds: number[]): Array<{ id: number; name: string }> {
  requireOwner(db, userId, playlistId);
  const wanted = new Set(
    (
      db
        .prepare(`SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND id != ? AND disabled = 0 AND role IS NOT NULL`)
        .all(JSON.stringify([...new Set(userIds)]), userId) as Array<{ id: number }>
    ).map((row) => row.id),
  );
  db.transaction(() => {
    const current = (db.prepare('SELECT user_id FROM user_playlist_shares WHERE playlist_id = ?').all(playlistId) as Array<{ user_id: number }>).map(
      (row) => row.user_id,
    );
    const remove = db.prepare('DELETE FROM user_playlist_shares WHERE playlist_id = ? AND user_id = ?');
    for (const id of current) if (!wanted.has(id)) remove.run(playlistId, id);
    const insert = db.prepare('INSERT OR IGNORE INTO user_playlist_shares (playlist_id, user_id, created_at) VALUES (?, ?, ?)');
    for (const id of wanted) insert.run(playlistId, id, Date.now());
  })();
  return shareRecipients(db, playlistId);
}

/** Eine geteilte Playlist nicht mehr sehen wollen; die des Besitzers bleibt unberührt. */
export function leavePlaylist(db: DB, userId: number, playlistId: number): boolean {
  return db.prepare('DELETE FROM user_playlist_shares WHERE playlist_id = ? AND user_id = ?').run(playlistId, userId).changes > 0;
}

/** Wem man eine Playlist teilen kann: alle anderen, die die App nutzen dürfen. Nur Namen, keine E-Mail-Adressen. */
export function shareablePeople(db: DB, userId: number): Array<{ id: number; name: string }> {
  return db
    .prepare(
      `SELECT id, name FROM users WHERE id != ? AND disabled = 0 AND role IS NOT NULL
       ORDER BY kind = 'local', name COLLATE NOCASE, id`,
    )
    .all(userId) as Array<{ id: number; name: string }>;
}
