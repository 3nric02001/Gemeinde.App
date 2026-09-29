import type { DB } from '../db.js';
import { parseFolderDate } from './dates.js';
import { PASSAGE_TAGS, SPEAKER_TAGS, UNKNOWN_ARTIST } from './metadata.js';
import { evaluateRules } from './rules.js';
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
  track_no: number | null;
  disc_no: number | null;
  album_id: number | null;
  cover_id: number | null;
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

interface AlbumRow {
  id: number;
  key: string;
  kind: 'auto' | 'manual';
}

interface Override {
  title: string | null;
  artist: string | null;
  year: number | null;
  genre: string | null;
  speaker: string | null;
  passage: string | null;
  description: string | null;
  hidden: number;
}

const COMPARED = [
  'title', 'artist', 'year', 'genre', 'folder', 'cover', 'coverId', 'count', 'duration', 'hidden',
  'date', 'speaker', 'passage', 'description',
] as const;

export const MANUAL_KEY_PREFIX = 'manual:';

/** Automatische Reihenfolge: nach CD, dann Tracknummer, Titel ohne Nummer ans Ende. */
function compareTracks(a: TrackRow, b: TrackRow): number {
  return (
    (a.disc_no ?? 1) - (b.disc_no ?? 1) ||
    Number(a.track_no === null) - Number(b.track_no === null) ||
    (a.track_no ?? 0) - (b.track_no ?? 0) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

function coverFor(tracks: TrackRow[], covers: Map<string, string>, folder?: string): string | undefined {
  if (folder !== undefined && covers.has(folder)) return covers.get(folder);
  for (const track of tracks) {
    const cover = covers.get(albumFolderOf(track.path)) ?? covers.get(dirname(track.path));
    if (cover) return cover;
  }
  return undefined;
}

/**
 * Baut alle Alben neu auf: automatische aus Tags und Ordnern, manuelle aus ihrer Titelliste,
 * jeweils mit den Korrekturen des Admins. Bestehende Alben behalten ihre ID
 * (Links und spätere Playlists bleiben gültig), leere automatische werden entfernt.
 * Läuft nach jedem Scan und nach jeder Änderung im Admin-Bereich.
 */
export function rebuildAlbums(db: DB, now = Date.now()): void {
  db.transaction(() => {
    const tracks = db
      .prepare(
        `SELECT id, path, title, artist, album_artist, album, year, genre, duration, compilation, track_no, disc_no, album_id,
                cover_id
         FROM tracks`,
      )
      .all() as TrackRow[];
    const byPath = new Map(tracks.map((t) => [t.path, t]));
    const covers = new Map(
      (db.prepare('SELECT folder, path FROM folder_covers').all() as Array<{ folder: string; path: string }>).map((r) => [
        r.folder,
        r.path,
      ]),
    );
    const overrides = new Map(
      (db.prepare('SELECT key, title, artist, year, genre, speaker, passage, description, hidden FROM album_overrides').all() as Array<
        Override & { key: string }
      >).map((row) => [row.key, row]),
    );
    const excluded = new Set(
      (db.prepare('SELECT path, album_key FROM track_exclusions').all() as Array<{ path: string; album_key: string }>).map(
        (row) => `${row.path}\u0000${row.album_key}`,
      ),
    );

    const rules = evaluateRules(db, tracks);

    // Sprecher und Bibelstelle aus eigenen Tag-Feldern, je Titel der erste Wert.
    const sermonTag = (tags: string[]) => {
      const values = new Map<number, string>();
      const rows = db
        .prepare(`SELECT track_id, value FROM track_tags WHERE tag IN (SELECT value FROM json_each(?)) ORDER BY rowid`)
        .all(JSON.stringify(tags)) as Array<{ track_id: number; value: string }>;
      for (const row of rows) if (!values.has(row.track_id)) values.set(row.track_id, row.value);
      return values;
    };
    const speakers = sermonTag(SPEAKER_TAGS);
    const passages = sermonTag(PASSAGE_TAGS);

    // Automatische Alben: Titel nach Ordner und Albumname gruppieren.
    const drafts = new Map<string, AlbumDraft>();
    for (const track of tracks) {
      const key = albumKey(track.path, track.album);
      if (excluded.has(`${track.path}\u0000${key}`) || rules.moved.has(track.id)) continue;
      let draft = drafts.get(key);
      if (!draft) {
        const folder = albumFolderOf(track.path);
        draft = { key, title: track.album ?? (folder ? basename(folder) : LOOSE_TRACKS), folder, tracks: [] };
        drafts.set(key, draft);
      }
      draft.tracks.push(track);
    }

    const derive = (draft: AlbumDraft, cover: string | undefined) => {
      const override = overrides.get(draft.key);
      const tagTitle = mostCommon(draft.tracks.map((t) => t.album));
      // Datum aus dem Albumordner ("2026-09-27 Erntedank"), sonst aus dem Albumnamen; nur bei automatischen Alben.
      const date = draft.folder ? (parseFolderDate(basename(draft.folder)) ?? (tagTitle ? parseFolderDate(tagTitle) : undefined)) : undefined;
      return {
        key: draft.key,
        title: override?.title ?? tagTitle ?? draft.title,
        artist: override?.artist ?? (draft.tracks.length ? albumArtist(draft.tracks) : UNKNOWN_ARTIST),
        year: override?.year ?? mostCommon(draft.tracks.map((t) => t.year)) ?? (date ? Number(date.slice(0, 4)) : null),
        date: date ?? null,
        speaker: override?.speaker ?? mostCommon(draft.tracks.map((t) => speakers.get(t.id))) ?? null,
        passage: override?.passage ?? mostCommon(draft.tracks.map((t) => passages.get(t.id))) ?? null,
        description: override?.description ?? null,
        genre: override?.genre ?? mostCommon(draft.tracks.map((t) => t.genre)) ?? null,
        folder: draft.folder,
        cover: cover ?? null,
        // Eingebettetes Bild, das die meisten Titel tragen (bei Gleichstand das des ersten Titels)
        coverId: mostCommon(draft.tracks.map((t) => t.cover_id)) ?? null,
        count: draft.tracks.length,
        duration: draft.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0),
        hidden: override?.hidden ? 1 : 0,
        now,
      };
    };

    const upsertAuto = db.prepare(`
      INSERT INTO albums (key, title, artist, year, genre, folder, cover_path, cover_id, track_count, duration, hidden, created_at,
                          date, speaker, passage, description)
      VALUES (@key, @title, @artist, @year, @genre, @folder, @cover, @coverId, @count, @duration, @hidden, @now,
              @date, @speaker, @passage, @description)
      ON CONFLICT(key) DO UPDATE SET
        title = excluded.title, artist = excluded.artist, year = excluded.year, genre = excluded.genre,
        folder = excluded.folder, cover_path = excluded.cover_path, cover_id = excluded.cover_id,
        track_count = excluded.track_count, duration = excluded.duration, hidden = excluded.hidden,
        date = excluded.date, speaker = excluded.speaker, passage = excluded.passage, description = excluded.description
      RETURNING id
    `);
    const updateManual = db.prepare(`
      UPDATE albums SET title = @title, artist = @artist, year = @year, genre = @genre, folder = @folder,
        cover_path = @cover, cover_id = @coverId, track_count = @count, duration = @duration, hidden = @hidden,
        date = @date, speaker = @speaker, passage = @passage, description = @description
      WHERE id = @id
    `);

    const existing = db
      .prepare(
        `SELECT id, key, kind, title, artist, year, genre, folder, cover_path AS cover, cover_id AS coverId, track_count AS count, duration, hidden,
                date, speaker, passage, description
         FROM albums`,
      )
      .all() as Array<AlbumRow & Record<string, unknown>>;
    const existingByKey = new Map(existing.map((row) => [row.key, row]));
    // Unveränderte Alben nicht neu schreiben: spart Schreibzugriffe bei jedem Scan und jeder Admin-Änderung.
    const unchanged = (row: Record<string, unknown> | undefined, values: Record<string, unknown>) =>
      row !== undefined && COMPARED.every((field) => row[field] === values[field]);

    /** Soll-Inhalt jedes Albums in Reihenfolge */
    const contents = new Map<number, TrackRow[]>();
    const autoOf = new Map<number, number>();
    for (const draft of drafts.values()) {
      draft.tracks.sort(compareTracks);
      const values = derive(draft, coverFor(draft.tracks, covers, draft.folder));
      const known = existingByKey.get(draft.key);
      const id = known && unchanged(known, values) ? known.id : (upsertAuto.get(values) as { id: number }).id;
      contents.set(id, draft.tracks);
      for (const track of draft.tracks) autoOf.set(track.id, id);
    }

    const removeAlbum = db.prepare('DELETE FROM albums WHERE id = ?');
    const manualMembers = db.prepare('SELECT path FROM manual_album_tracks WHERE album_id = ? ORDER BY position, path');
    for (const album of existing) {
      if (album.kind === 'auto') {
        if (!drafts.has(album.key)) removeAlbum.run(album.id);
        continue;
      }
      // Manuelle Alben: Pfade, die gerade nicht in der Bibliothek sind, bleiben gespeichert, zählen aber nicht.
      // Von Hand eingetragene Titel zuerst, danach, was Regeln hinzufügen.
      const members = (manualMembers.all(album.id) as Array<{ path: string }>)
        .map((row) => byPath.get(row.path))
        .filter((t): t is TrackRow => t !== undefined);
      const listed = new Set(members.map((t) => t.id));
      for (const track of rules.members.get(album.id) ?? []) if (!listed.has(track.id)) members.push(track);
      const draft: AlbumDraft = { key: album.key, title: LOOSE_TRACKS, folder: '', tracks: members };
      const values = derive(draft, coverFor(members, covers));
      if (!unchanged(album, values)) updateManual.run({ ...values, id: album.id });
      contents.set(album.id, members);
    }

    // album_tracks nur für Alben neu schreiben, deren Inhalt sich geändert hat.
    const current = new Map<number, number[]>();
    for (const row of db.prepare('SELECT album_id, track_id FROM album_tracks ORDER BY album_id, position').all() as Array<{
      album_id: number;
      track_id: number;
    }>) {
      const list = current.get(row.album_id) ?? [];
      list.push(row.track_id);
      current.set(row.album_id, list);
    }
    const clear = db.prepare('DELETE FROM album_tracks WHERE album_id = ?');
    const insert = db.prepare('INSERT INTO album_tracks (album_id, track_id, position) VALUES (?, ?, ?)');
    for (const [albumId, members] of contents) {
      const ids = members.map((t) => t.id);
      const before = current.get(albumId) ?? [];
      if (ids.length === before.length && ids.every((id, i) => id === before[i])) continue;
      clear.run(albumId);
      ids.forEach((trackId, index) => insert.run(albumId, trackId, index + 1));
    }

    // Hauptalbum je Titel: das automatische, sonst das erste sichtbare manuelle.
    const hidden = new Set(
      (db.prepare('SELECT id FROM albums WHERE hidden = 1').all() as Array<{ id: number }>).map((r) => r.id),
    );
    const primary = new Map<number, number>();
    for (const [trackId, albumId] of autoOf) if (!hidden.has(albumId)) primary.set(trackId, albumId);
    for (const albumId of [...contents.keys()].sort((a, b) => a - b)) {
      if (hidden.has(albumId)) continue;
      for (const track of contents.get(albumId)!) if (!primary.has(track.id)) primary.set(track.id, albumId);
    }
    const assign = db.prepare('UPDATE tracks SET album_id = ? WHERE id = ?');
    for (const track of tracks) {
      const albumId = primary.get(track.id) ?? null;
      if (track.album_id !== albumId) assign.run(albumId, track.id);
    }
  })();
}
