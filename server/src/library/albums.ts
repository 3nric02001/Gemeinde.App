import type { DB } from '../db.js';
import { findPassages, joinPassages } from './bible.js';
import { parseFolderDate } from './dateText.js';
import { PASSAGE_TAGS, SPEAKER_TAGS, UNKNOWN_ARTIST } from './metadata.js';
import { evaluateRules } from './rules.js';
import { albumFolderOf, basename, dirname, fileStem, folderDate, parsePath, type PathMeta } from './pathMeta.js';
import { applyToFolder, compileStructure, getStructure, kindOfFolder, type FolderResult } from './structure.js';
import { foldValue, sortKey } from './text.js';

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
  album_key: string | null;
  added_at: number | null;
  album_sort: string | null;
  album_artist_sort: string | null;
  album_tagged: number | null;
  display_title: string | null;
  display_artist: string | null;
  content: string | null;
  title_tagged: number | null;
}

interface AlbumDraft {
  key: string;
  title: string;
  folder: string;
  tracks: TrackRow[];
  /** Datum aus den Dateinamen, wenn ein Ordner nach Datum aufgeteilt wurde */
  date?: string;
  /** Titel steht fest (Aufteilung nach Datum), statt aus den Album-Tags zu kommen */
  fixedTitle?: boolean;
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
 * mit Titeln verschiedener Alben sauber aufgeteilt wird. Welcher Albumname für einen Titel gilt,
 * entscheidet groupTracks mit Blick auf den ganzen Ordner; der Schlüssel steht danach in tracks.album_key.
 */
export function albumKey(folder: string, album: string | null): string {
  return `${folder}\u0000${album ? normalizeKey(album) : ''}`;
}

/** Schlüssel eines Albums, das aus einem nach Datum aufgeteilten Ordner entsteht */
const dateKey = (folder: string, date: string) => `${folder}\u0000@${date}`;

/** "Live 2020 (Remastered)", "Live 2020 [Deluxe]" -> "live 2020": Zusätze in Klammern zählen nicht. */
function baseAlbumKey(album: string): string {
  const base = album.replace(/(?:\s*[([][^)\]]*[)\]])+\s*$/, '');
  return normalizeKey(base) || normalizeKey(album);
}

interface Group {
  key: string;
  folder: string;
  title: string;
  date?: string;
  fixedTitle?: boolean;
}

/**
 * Ordnet jedem Titel sein automatisches Album zu, mit Blick auf den ganzen Albumordner:
 * - Ordner ohne Datum, in denen die meisten Dateien ein Datum im Namen tragen
 *   ("Predigten 2026/2026-09-27 Meier - Psalm 23.mp3"), werden je Datum ein eigenes Album.
 * - Sonst entscheidet der Album-Tag. Titel ohne eigenen Tag (Albumname kommt aus dem Ordner) und
 *   einzelne Abweichler zählen zum Album, das im Ordner klar überwiegt; Zusätze wie "(Remastered)"
 *   trennen nicht. Echte Sammelordner mit mehreren Alben bleiben aufgeteilt.
 */
export function groupTracks(
  tracks: Array<Pick<TrackRow, 'id' | 'path' | 'album' | 'title' | 'album_tagged'>>,
  parsed: (path: string) => PathMeta,
): Map<number, Group> {
  const byFolder = new Map<string, typeof tracks>();
  for (const track of tracks) {
    const folder = albumFolderOf(track.path);
    const list = byFolder.get(folder) ?? [];
    list.push(track);
    byFolder.set(folder, list);
  }
  const result = new Map<number, Group>();
  for (const [folder, list] of byFolder) {
    let rest = list;
    if (folder && !folderDate(folder)) {
      const dated = list.filter((t) => parsed(t.path).date);
      const dates = new Set(dated.map((t) => parsed(t.path).date!));
      if (dates.size >= 2 && dated.length * 2 >= list.length) {
        for (const date of dates) {
          const members = dated.filter((t) => parsed(t.path).date === date);
          // Eine Aufnahme heißt wie ihr Titel ("Psalm 23"), mehrere an einem Tag nach dem Datum ("Gottesdienst").
          const title = members.length === 1 ? members[0]!.title : date;
          for (const t of members) result.set(t.id, { key: dateKey(folder, date), folder, title, date, fixedTitle: true });
        }
        rest = list.filter((t) => !parsed(t.path).date);
      }
    }
    if (rest.length) groupByAlbumTag(folder, rest, result);
  }
  return result;
}

function groupByAlbumTag(
  folder: string,
  tracks: Array<Pick<TrackRow, 'id' | 'path' | 'album' | 'title' | 'album_tagged'>>,
  result: Map<number, Group>,
): void {
  // Ohne eigenen Album-Tag (Name aus dem Ordner). Bei Titeln, die seit dem Update noch nicht neu gelesen
  // wurden, ist das unbekannt; dann zählt ein Albumname wie der Ordner als Tag.
  const neutral = new Set(tracks.filter((t) => !t.album || t.album_tagged === 0));
  const tagged = tracks.filter((t) => !neutral.has(t));
  const groups = new Map<string, typeof tracks>();
  for (const track of tagged) {
    const base = baseAlbumKey(track.album!);
    groups.set(base, [...(groups.get(base) ?? []), track]);
  }
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
  const main = ordered[0];
  if (main && main.length >= 3 && main.length * 2 > tagged.length) {
    for (const group of ordered.slice(1)) if (group.length === 1) main.push(group.pop()!);
  }
  if (neutral.size) {
    if (main) main.push(...neutral);
    else ordered.push([...neutral]);
  }
  for (const group of ordered) {
    if (!group.length) continue;
    const names = group.filter((t) => !neutral.has(t)).map((t) => t.album);
    const name = mostCommon(names) ?? mostCommon(group.map((t) => t.album)) ?? null;
    const key = albumKey(folder, name);
    const title = name ?? (folder ? basename(folder) : LOOSE_TRACKS);
    for (const track of group) result.set(track.id, { key, folder, title });
  }
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
  /** Hochgeladenes Titelbild (covers.id) */
  cover_id: number | null;
}

const COMPARED = [
  'title', 'artist', 'year', 'genre', 'folder', 'cover', 'coverId', 'count', 'duration', 'hidden',
  'date', 'speaker', 'passage', 'description', 'sortTitle', 'sortArtist', 'createdAt', 'recording',
] as const;

export const MANUAL_KEY_PREFIX = 'manual:';

/** Automatische Reihenfolge: nach CD, dann Tracknummer, Titel ohne Nummer ans Ende. */
function compareTracks(a: TrackRow, b: TrackRow): number {
  return (
    (a.disc_no ?? 1) - (b.disc_no ?? 1) ||
    Number(a.track_no === null) - Number(b.track_no === null) ||
    (a.track_no ?? 0) - (b.track_no ?? 0) ||
    comparePaths(a.path, b.path)
  );
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
/** Pfade wie im Dateimanager: "2 Lied" vor "10 Lied", "Ärger" bei A */
export const comparePaths = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ein verschwundenes Album lebt in einem neuen weiter, wenn die meisten Titel dorthin gewandert sind
 * (Album-Tag korrigiert, Ordner umbenannt, anders gruppiert). So bleiben ID, Favoriten, Korrekturen
 * und herausgenommene Titel erhalten. Liefert Paare alter und neuer Schlüssel.
 */
export function matchRenamedAlbums(
  vanished: Array<{ key: string; members: Set<number> }>,
  fresh: Map<string, Set<number>>,
): Array<[string, string]> {
  const pairs: Array<[string, string, number]> = [];
  for (const old of vanished) {
    for (const [key, members] of fresh) {
      let overlap = 0;
      for (const id of old.members) if (members.has(id)) overlap++;
      if (overlap > 0 && overlap * 2 >= old.members.size && overlap * 2 >= members.size) pairs.push([old.key, key, overlap]);
    }
  }
  pairs.sort((a, b) => b[2] - a[2]);
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const result: Array<[string, string]> = [];
  for (const [from, to] of pairs) {
    if (usedOld.has(from) || usedNew.has(to)) continue;
    usedOld.add(from);
    usedNew.add(to);
    result.push([from, to]);
  }
  return result;
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
                cover_id, album_key, added_at, album_sort, album_artist_sort, album_tagged, display_title, display_artist, content, title_tagged
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
    const pathMeta = new Map<string, PathMeta>();
    const parsed = (path: string) => {
      let meta = pathMeta.get(path);
      if (!meta) pathMeta.set(path, (meta = parsePath(path)));
      return meta;
    };

    // 1. Jedem Titel sein automatisches Album zuordnen und den Schlüssel am Titel merken (für die Verwaltung).
    const groups = groupTracks(tracks, parsed);
    const setKey = db.prepare('UPDATE tracks SET album_key = ? WHERE id = ?');
    const keyMembers = new Map<string, Set<number>>();
    for (const track of tracks) {
      const { key } = groups.get(track.id)!;
      if (track.album_key !== key) setKey.run(key, track.id);
      track.album_key = key;
      keyMembers.set(key, (keyMembers.get(key) ?? new Set()).add(track.id));
    }

    // 1b. Regelwerk für Aufnahmen (Verwaltung → Zuordnung): Art, Albumname, Titel, Inhalt und Sprecher.
    const structure = compileStructure(getStructure(db));
    const byFolder = new Map<string, TrackRow[]>();
    for (const track of tracks) {
      const { folder } = groups.get(track.id)!;
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), track]);
    }
    const recordings = new Map<string, FolderResult>();
    for (const [folder, list] of byFolder) {
      const kind = kindOfFolder(structure, folder);
      if (!kind) continue;
      const files = list.map((t) => ({ path: t.path, title: t.title, titleTagged: t.title_tagged === 1 || (t.title_tagged === null && t.title !== parsed(t.path).title), duration: t.duration }));
      recordings.set(folder, applyToFolder(kind, folder, files));
    }
    applyRecordings(db, tracks, (track) => recordings.get(groups.get(track.id)!.folder), parsed);
    // Aufnahmen ohne eigenen Ordner mit Datum (Datum im Dateinamen) zählen zur Art ohne Ordner-Kennzeichen.
    const defaultRecording = structure.kinds.find((k) => !k.folderKey)?.kind.name ?? structure.kinds[0]?.kind.name ?? null;

    // Bisheriger Inhalt aller Alben (für Wiedererkennung und um unnötiges Schreiben zu sparen)
    const current = new Map<number, number[]>();
    for (const row of db.prepare('SELECT album_id, track_id FROM album_tracks ORDER BY album_id, position').all() as Array<{
      album_id: number;
      track_id: number;
    }>) {
      const list = current.get(row.album_id) ?? [];
      list.push(row.track_id);
      current.set(row.album_id, list);
    }

    // 2. Verschwundene Alben in neuen wiedererkennen und ihnen Schlüssel samt Eingriffen mitgeben.
    const known = db.prepare("SELECT id, key FROM albums WHERE kind = 'auto'").all() as Array<{ id: number; key: string }>;
    const knownKeys = new Set(known.map((row) => row.key));
    const fresh = new Map([...keyMembers].filter(([key]) => !knownKeys.has(key)));
    if (fresh.size) {
      const excludedIds = new Map<string, number[]>();
      for (const row of db.prepare('SELECT path, album_key FROM track_exclusions').all() as Array<{ path: string; album_key: string }>) {
        const id = byPath.get(row.path)?.id;
        if (id !== undefined) excludedIds.set(row.album_key, [...(excludedIds.get(row.album_key) ?? []), id]);
      }
      const vanished = known
        .filter((row) => !keyMembers.has(row.key))
        .map((row) => ({ key: row.key, members: new Set([...(current.get(row.id) ?? []), ...(excludedIds.get(row.key) ?? [])]) }))
        .filter((row) => row.members.size > 0);
      const rename = db.prepare('UPDATE albums SET key = ? WHERE key = ?');
      const renameOverride = db.prepare('UPDATE OR IGNORE album_overrides SET key = ? WHERE key = ?');
      const renameExclusions = db.prepare('UPDATE OR IGNORE track_exclusions SET album_key = ? WHERE album_key = ?');
      for (const [from, to] of matchRenamedAlbums(vanished, fresh)) {
        rename.run(to, from);
        renameOverride.run(to, from);
        renameExclusions.run(to, from);
      }
    }

    const overrides = new Map(
      (db.prepare('SELECT key, title, artist, year, genre, speaker, passage, description, hidden, cover_id FROM album_overrides').all() as Array<
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
        // Nur echte Tags; was das Regelwerk ableitet, kommt über recording dazu
        .prepare(`SELECT track_id, value FROM track_tags WHERE tag IN (SELECT value FROM json_each(?)) AND derived = 0 ORDER BY rowid`)
        .all(JSON.stringify(tags)) as Array<{ track_id: number; value: string }>;
      for (const row of rows) if (!values.has(row.track_id)) values.set(row.track_id, row.value);
      return values;
    };
    const speakers = sermonTag(SPEAKER_TAGS);
    // Bibelstellen dagegen alle: ein Album hat oft mehrere (Lesung, Predigt, Bibelstunde in Teilen).
    const passages = new Map<number, string[]>();
    for (const row of db
      .prepare(`SELECT track_id, value FROM track_tags WHERE tag IN (SELECT value FROM json_each(?)) AND derived = 0 ORDER BY rowid`)
      .all(JSON.stringify(PASSAGE_TAGS)) as Array<{ track_id: number; value: string }>) {
      passages.set(row.track_id, [...(passages.get(row.track_id) ?? []), row.value]);
    }
    // Sprecher, die in der Verwaltung je Titel gesetzt wurden, gehen den Tags vor.
    const pathIds = new Map(tracks.map((t) => [t.path, t.id]));
    for (const row of db.prepare('SELECT path, speaker FROM track_overrides WHERE speaker IS NOT NULL').all() as Array<{
      path: string;
      speaker: string;
    }>) {
      const id = pathIds.get(row.path);
      if (id !== undefined) speakers.set(id, row.speaker);
    }

    // 3. Automatische Alben aus den Gruppen, ohne herausgenommene und per Regel verschobene Titel.
    const drafts = new Map<string, AlbumDraft>();
    for (const track of tracks) {
      const group = groups.get(track.id)!;
      if (excluded.has(`${track.path}\u0000${group.key}`) || rules.moved.has(track.id)) continue;
      let draft = drafts.get(group.key);
      if (!draft) {
        draft = { key: group.key, title: group.title, folder: group.folder, tracks: [], date: group.date, fixedTitle: group.fixedTitle };
        drafts.set(group.key, draft);
      }
      draft.tracks.push(track);
    }

    const derive = (draft: AlbumDraft, cover: string | undefined, createdAt: number) => {
      const override = overrides.get(draft.key);
      const recording = draft.folder ? recordings.get(draft.folder) : undefined;
      const tagTitle = draft.fixedTitle ? undefined : mostCommon(draft.tracks.map((t) => t.album));
      // Bei Aufnahmen gilt die Vorlage aus dem Regelwerk; ohne Anlass bleibt der Ordnername (die Oberfläche zeigt dann die Art).
      // Steht der Albumname in den Tags und soll die Art Tags bevorzugen, bleibt er.
      const taggedAlbum = mostCommon(
        draft.tracks
          .filter((t) => t.album_tagged === 1 || (t.album_tagged === null && t.album && t.album !== parsed(t.path).album))
          .map((t) => t.album),
      );
      const ruleTitle = recording && !(recording.kind.preferTags && taggedAlbum) ? recording.title || basename(draft.folder) : undefined;
      const title = override?.title ?? ruleTitle ?? tagTitle ?? draft.title;
      const tracks = draft.tracks.map((t) => ({ ...t, title: t.display_title ?? t.title, artist: t.display_artist ?? t.artist }));
      // Datum aus den Dateinamen, dem Albumordner ("2026-09-27 Erntedank") oder dem Albumnamen; nur bei automatischen Alben.
      const date = draft.folder
        ? (draft.date ?? folderDate(draft.folder) ?? (tagTitle ? parseFolderDate(tagTitle) : undefined))
        : undefined;
      // Längster Titel zuerst: bei einem Gottesdienst meist die Predigt
      const byLength = [...tracks].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
      const speaker =
        override?.speaker ??
        mostCommon(draft.tracks.map((t) => speakers.get(t.id))) ??
        recording?.speaker ??
        (date && !recording ? mostCommon(byLength.map((t) => parsed(t.path).speaker)) : undefined) ??
        null;
      // Alle Bibelstellen des Albums: zuerst die des Ordners bzw. der Predigt, dann je Titel in Albumreihenfolge
      // aus den Tags oder dem Dateinamen nach dem Regelwerk, sonst (nur bei Aufnahmen) aus Titel oder Dateiname.
      const sermonLike = Boolean(date || recording);
      const passage =
        override?.passage ??
        joinPassages([
          recording?.passage,
          ...[...draft.tracks].sort(compareTracks).flatMap((t) => {
            const known = [...(passages.get(t.id) ?? []), recording?.files.get(t.path)?.passage].filter(Boolean);
            if (known.length || !sermonLike) return known;
            const inTitle = findPassages(t.display_title ?? t.title);
            return inTitle.length ? inTitle : findPassages(fileStem(t.path));
          }),
          ...(sermonLike ? findPassages(title) : []),
        ]);
      // Bei Gottesdiensten ist, wer predigt, der Interpret; das Jahr kommt aus dem Datum.
      const artist = override?.artist ?? (date && speaker ? speaker : tracks.length ? albumArtist(tracks) : UNKNOWN_ARTIST);
      const sortTitle = sortKey(override?.title ?? mostCommon(draft.tracks.map((t) => t.album_sort)) ?? title);
      const sortArtist = sortKey(override?.artist ?? mostCommon(draft.tracks.map((t) => t.album_artist_sort)) ?? artist);
      return {
        key: draft.key,
        title,
        artist,
        year:
          override?.year ?? (date ? Number(date.slice(0, 4)) : undefined) ?? mostCommon(draft.tracks.map((t) => t.year)) ?? null,
        date: date ?? null,
        speaker,
        passage,
        description: override?.description ?? null,
        genre: override?.genre ?? mostCommon(draft.tracks.map((t) => t.genre)) ?? null,
        folder: draft.folder,
        // Ein hochgeladenes Titelbild geht dem Ordnerbild und den eingebetteten Bildern vor.
        cover: override?.cover_id ? null : (cover ?? null),
        // Eingebettetes Bild, das die meisten Titel tragen (bei Gleichstand das des ersten Titels)
        coverId: override?.cover_id ?? mostCommon(draft.tracks.map((t) => t.cover_id)) ?? null,
        count: draft.tracks.length,
        duration: draft.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0),
        hidden: override?.hidden ? 1 : 0,
        sortTitle,
        sortArtist,
        createdAt,
        recording: recording?.kind.name ?? (date ? defaultRecording : null),
      };
    };

    const upsertAuto = db.prepare(`
      INSERT INTO albums (key, title, artist, year, genre, folder, cover_path, cover_id, track_count, duration, hidden, created_at,
                          date, speaker, passage, description, sort_title, sort_artist, recording)
      VALUES (@key, @title, @artist, @year, @genre, @folder, @cover, @coverId, @count, @duration, @hidden, @createdAt,
              @date, @speaker, @passage, @description, @sortTitle, @sortArtist, @recording)
      ON CONFLICT(key) DO UPDATE SET
        title = excluded.title, artist = excluded.artist, year = excluded.year, genre = excluded.genre,
        folder = excluded.folder, cover_path = excluded.cover_path, cover_id = excluded.cover_id,
        track_count = excluded.track_count, duration = excluded.duration, hidden = excluded.hidden,
        date = excluded.date, speaker = excluded.speaker, passage = excluded.passage, description = excluded.description,
        sort_title = excluded.sort_title, sort_artist = excluded.sort_artist, created_at = excluded.created_at,
        recording = excluded.recording
      RETURNING id
    `);
    const updateManual = db.prepare(`
      UPDATE albums SET title = @title, artist = @artist, year = @year, genre = @genre, folder = @folder,
        cover_path = @cover, cover_id = @coverId, track_count = @count, duration = @duration, hidden = @hidden,
        date = @date, speaker = @speaker, passage = @passage, description = @description,
        sort_title = @sortTitle, sort_artist = @sortArtist, recording = @recording
      WHERE id = @id
    `);

    const existing = db
      .prepare(
        `SELECT id, key, kind, title, artist, year, genre, folder, cover_path AS cover, cover_id AS coverId, track_count AS count, duration, hidden,
                date, speaker, passage, description, sort_title AS sortTitle, sort_artist AS sortArtist, created_at AS createdAt,
                recording
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
      const known = existingByKey.get(draft.key);
      // "Neu hinzugefügt": wann der erste Titel in die Nextcloud kam, nicht wann die App ihn zuerst sah
      const added = draft.tracks.reduce<number | undefined>(
        (min, t) => (t.added_at !== null && (min === undefined || t.added_at < min) ? t.added_at : min),
        undefined,
      );
      const values = derive(draft, coverFor(draft.tracks, covers, draft.folder), added ?? (known?.createdAt as number | undefined) ?? now);
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
      const values = derive(draft, coverFor(members, covers), album.createdAt as number);
      if (!unchanged(album, values)) updateManual.run({ ...values, id: album.id });
      contents.set(album.id, members);
    }

    // album_tracks nur für Alben neu schreiben, deren Inhalt sich geändert hat.
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

/**
 * Schreibt, was das Regelwerk je Titel ergibt: Anzeige-Titel, Inhalt, Interpret und die abgeleiteten
 * Tag-Felder "inhalt" und "sprecher" (für Kategorien). Nur geänderte Titel werden geschrieben.
 * Ein Interpret aus den Tags bleibt; ohne ihn steht der Sprecher, sonst der Name der Art.
 */
function applyRecordings(
  db: DB,
  tracks: TrackRow[],
  recordingOf: (track: TrackRow) => FolderResult | undefined,
  parsed: (path: string) => PathMeta,
): void {
  const setDisplay = db.prepare(
    'UPDATE tracks SET display_title = ?, display_artist = ?, content = ?, sort_title = ?, sort_artist = ? WHERE id = ?',
  );
  const derived = new Map<number, string>();
  for (const row of db.prepare('SELECT track_id, tag, value FROM track_tags WHERE derived = 1 ORDER BY tag, value').all() as Array<{
    track_id: number;
    tag: string;
    value: string;
  }>) {
    derived.set(row.track_id, `${derived.get(row.track_id) ?? ''}${row.tag}\u0000${row.value}\u0001`);
  }
  const clearDerived = db.prepare('DELETE FROM track_tags WHERE track_id = ? AND derived = 1');
  const addDerived = db.prepare('INSERT INTO track_tags (track_id, tag, value, vkey, derived) VALUES (?, ?, ?, ?, 1)');
  for (const track of tracks) {
    const recording = recordingOf(track);
    const file = recording?.files.get(track.path);
    const artistTagged = track.artist !== UNKNOWN_ARTIST && track.artist !== parsed(track.path).artist;
    const title = file?.title ?? null;
    const content = file?.content ?? null;
    // Name aus dem Dateinamen vor dem Tag, außer die Art bevorzugt Tags; ohne beides der Sprecher, sonst die Art
    const named = file?.performer && !(recording!.kind.preferTags && artistTagged) ? file.performer : undefined;
    const artist = recording ? (named ?? (artistTagged ? null : (recording.speaker ?? recording.kind.name))) : null;
    if (title !== track.display_title || artist !== track.display_artist || content !== track.content) {
      setDisplay.run(title, artist, content, sortKey(title ?? track.title), sortKey(artist ?? track.artist), track.id);
      track.display_title = title;
      track.display_artist = artist;
      track.content = content;
    }
    const tags = ([['inhalt', content], ['sprecher', file?.speaker ?? null]] as Array<[string, string | null]>)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const wanted = tags.map(([tag, value]) => `${tag}\u0000${value}\u0001`).join('');
    if (wanted !== (derived.get(track.id) ?? '')) {
      clearDerived.run(track.id);
      for (const [tag, value] of tags) addDerived.run(track.id, tag, value, foldValue(value));
    }
  }
}
