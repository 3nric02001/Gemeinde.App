import type { DB } from '../db.js';
import { findPassages, joinPassages, PASSAGE_SEPARATOR } from './bible.js';
import { librarySettings } from './settings.js';
import { evaluateRules } from './rules.js';
import { albumFolderOf, basename, dateOfPath, dirname, fileStem, folderDate, parsePath, type PathMeta } from './pathMeta.js';
import { compileReplacements, listReplacements } from './replacements.js';
import type { ManualDecision, Player } from './policies.js';
import {
  applyToFolder,
  compileStructure,
  defaultKindOf,
  applyLibrarySettings,
  kindOfFolder,
  libraryAlbumTitle,
  libraryTrackTitle,
  withManual,
  type CompiledStructure,
  type FolderResult,
  type Section,
} from './structure.js';
import { trackFields } from './fields.js';
import { foldValue, sortKey } from './text.js';


const yearOf = (date: string | undefined) => (date ? Number(date.slice(0, 4)) : undefined);

interface TrackRow {
  id: number;
  path: string;
  title: string;
  album: string | null;
  year: number | null;
  duration: number | null;
  track_no: number | null;
  disc_no: number | null;
  album_id: number | null;
  cover_id: number | null;
  album_key: string | null;
  added_at: number | null;
  display_title: string | null;
  raw_title: string | null;
  /** Sprecher aus dem Dateinamen (Regelwerk oder Datum im Dateinamen), vor der Korrektur je Titel */
  speaker: string | null;
  content: string | null;
  playback: string | null;
  sermon: number;
  policy: string | null;
}

interface AlbumDraft {
  key: string;
  title: string;
  folder: string;
  tracks: TrackRow[];
  /** Datum aus den Dateinamen, wenn ein Ordner nach Datum aufgeteilt wurde */
  date?: string;
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

/**
 * Albumschlüssel: der Albumordner (Disc-Unterordner zusammengefasst). Früher kam der Albumname aus den Tags
 * dazu; der zweite Teil bleibt leer, damit Schlüssel mit einem Datum ("@2026-09-27") gleich aufgebaut sind.
 * Der Schlüssel steht nach groupTracks in tracks.album_key.
 */
export function albumKey(folder: string): string {
  return `${folder}\u0000`;
}

/** Schlüssel eines Albums, das aus einem nach Datum aufgeteilten Ordner entsteht */
const dateKey = (folder: string, date: string) => `${folder}\u0000@${date}`;

interface Group {
  key: string;
  folder: string;
  title: string;
  date?: string;
}

/**
 * Ordnet jedem Titel sein automatisches Album zu: ein Album je Albumordner. Ordner ohne Datum, in denen die
 * meisten Dateien ein Datum im Namen tragen ("Predigten 2026/2026-09-27 Meier - Psalm 23.mp3"), werden je
 * Datum ein eigenes Album.
 */
export function groupTracks(tracks: Array<Pick<TrackRow, 'id' | 'path' | 'title'>>, parsed: (path: string) => PathMeta): Map<number, Group> {
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
    if (librarySettings().splitByFileDate && folder && !folderDate(folder)) {
      const dated = list.filter((t) => parsed(t.path).date);
      const dates = new Set(dated.map((t) => parsed(t.path).date!));
      if (dates.size >= 2 && dated.length * 2 >= list.length) {
        for (const date of dates) {
          const members = dated.filter((t) => parsed(t.path).date === date);
          // Eine Aufnahme heißt wie ihr Titel ("Psalm 23"), mehrere an einem Tag nach dem Datum.
          const title = members.length === 1 ? members[0]!.title : date;
          for (const t of members) result.set(t.id, { key: dateKey(folder, date), folder, title, date });
        }
        rest = list.filter((t) => !parsed(t.path).date);
      }
    }
    if (!rest.length) continue;
    // Name nach der Vorlage für Musik und Sonstiges; bei Aufnahmen gilt danach die Vorlage der Art
    const title = libraryAlbumTitle(folder);
    for (const track of rest) result.set(track.id, { key: albumKey(folder), folder, title });
  }
  return result;
}

interface AlbumRow {
  id: number;
  key: string;
  kind: 'auto' | 'manual';
}

interface Override {
  title: string | null;
  year: number | null;
  speaker: string | null;
  passage: string | null;
  description: string | null;
  hidden: number;
  /** Hochgeladenes Titelbild (covers.id) */
  cover_id: number | null;
  /** Art von Hand ("" = keine), NULL: nach dem Regelwerk */
  recording: string | null;
}

const COMPARED = [
  'title', 'year', 'folder', 'cover', 'coverId', 'count', 'duration', 'hidden',
  'date', 'speaker', 'passage', 'description', 'sortTitle', 'createdAt', 'recording', 'music',
] as const;

export const MANUAL_KEY_PREFIX = 'manual:';

/** Albumreihenfolge: Disc, dann Unterordner ("Teil 1" vor "Teil 2"), dann Tracknummer und Dateiname */
export function compareTracks(a: Pick<TrackRow, 'path' | 'disc_no' | 'track_no'>, b: Pick<TrackRow, 'path' | 'disc_no' | 'track_no'>): number {
  return (
    (a.disc_no ?? 1) - (b.disc_no ?? 1) ||
    comparePaths(dirname(a.path), dirname(b.path)) ||
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
 * (Ordner umbenannt, anders gruppiert). So bleiben ID, Favoriten, Korrekturen
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
 * Baut alle Alben neu auf: automatische aus Ordnern und Dateinamen, manuelle aus ihrer Titelliste,
 * jeweils mit den Korrekturen des Admins. Bestehende Alben behalten ihre ID
 * (Links und spätere Playlists bleiben gültig), leere automatische werden entfernt.
 * Läuft nach jedem Scan und nach jeder Änderung im Admin-Bereich.
 */
export function rebuildAlbums(db: DB, now = Date.now()): void {
  db.transaction(() => {
    // Regelwerk samt Albumbildung und Namen (Verwaltung → Zuordnung) gilt ab hier auch für die Pfad-Hilfen
    const settings = applyLibrarySettings(db);
    refreshPathValues(db);
    const tracks = db
      .prepare(
        `SELECT id, path, title, album, year, duration, track_no, disc_no, album_id, cover_id, album_key, added_at,
                display_title, raw_title, speaker, content, playback, sermon, policy
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
    // Eine Art, die in der Verwaltung für ein Album gesetzt wurde, geht den Bedingungen der Arten vor.
    const structure = compileStructure(settings);
    const manualKinds = new Map(
      (db.prepare('SELECT key, recording FROM album_overrides WHERE recording IS NOT NULL').all() as Array<{ key: string; recording: string }>).map(
        (row) => [row.key, row.recording],
      ),
    );
    // Korrekturen je Titel (Predigt, Player) gehen den Policies vor.
    const manualDecisions = new Map(
      (db.prepare('SELECT path, sermon, player FROM track_overrides WHERE sermon IS NOT NULL OR player IS NOT NULL').all() as Array<{
        path: string;
        sermon: number | null;
        player: Player | null;
      }>).map((row): [string, ManualDecision] => [row.path, { sermon: row.sermon === null ? null : row.sermon === 1, player: row.player }]),
    );
    // Die Regeln sehen den ganzen Ordner; die Art von Hand gilt je Album, auch wenn sich ein Ordner nach Datum in
    // mehrere Alben teilt.
    const byFolder = new Map<string, TrackRow[]>();
    const byKey = new Map<string, TrackRow[]>();
    for (const track of tracks) {
      const { folder, key } = groups.get(track.id)!;
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), track]);
      byKey.set(key, [...(byKey.get(key) ?? []), track]);
    }
    /** Art, Musik oder Sonstiges je automatischem Album, bei Aufnahmen mit dem, was das Regelwerk daraus liest */
    const sections = new Map<string, { section: Section; kind: string | null; recording?: FolderResult }>();
    for (const [key, list] of byKey) {
      const { folder, date } = groups.get(list[0]!.id)!;
      const found = kindOfFolder(structure, folder, byFolder.get(folder)!, manualKinds.get(key));
      if (found.kind) {
        const files = list.map((t) => ({ path: t.path, title: t.title, duration: t.duration, manual: manualDecisions.get(t.path) }));
        sections.set(key, { section: 'recording', kind: found.kind.kind.name, recording: applyToFolder(found.kind, folder, files) });
      } else if (found.source.by === 'none' && date) {
        // Aufnahmen ohne eigenen Ordner mit Datum (Datum im Dateinamen) bekommen die Vorgabe für Ordner mit Datum, nur als Name.
        const fallback = defaultKindOf(structure);
        sections.set(key, { section: fallback.section, kind: fallback.kind?.kind.name ?? null });
      } else {
        sections.set(key, { section: found.section, kind: null });
      }
    }
    // Ersetzungen für Tippfehler (Verwaltung → Schreibweisen) für Titel und Albumnamen ohne eigene Korrektur
    const fix = compileReplacements(listReplacements(db));
    // Sprecher, die in der Verwaltung je Titel gesetzt wurden, gehen dem Dateinamen vor.
    const speakerOverrides = new Map(
      (db.prepare('SELECT path, speaker FROM track_overrides WHERE speaker IS NOT NULL').all() as Array<{ path: string; speaker: string }>).map(
        (row) => [row.path, row.speaker],
      ),
    );
    applyRecordings(
      db,
      tracks,
      (track) => sections.get(groups.get(track.id)!.key)?.recording,
      parsed,
      fix,
      structure,
      manualDecisions,
      speakerOverrides,
    );

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
      (db.prepare('SELECT key, title, year, speaker, passage, description, hidden, cover_id, recording FROM album_overrides').all() as Array<
        Override & { key: string }
      >).map((row) => [row.key, row]),
    );
    const excluded = new Set(
      (db.prepare('SELECT path, album_key FROM track_exclusions').all() as Array<{ path: string; album_key: string }>).map(
        (row) => `${row.path}\u0000${row.album_key}`,
      ),
    );

    // Regeln sehen den Sprecher mit Korrektur je Titel
    const rules = evaluateRules(
      db,
      tracks.map((t) => ({ ...t, speaker: speakerOverrides.get(t.path) ?? t.speaker })),
    );

    const playlistSection = (key: string): { section: Section; kind: string | null; recording?: FolderResult } => {
      const found = kindOfFolder(structure, '', [], manualKinds.get(key));
      return { section: found.section, kind: found.kind?.kind.name ?? null };
    };

    // 3. Automatische Alben aus den Gruppen, ohne herausgenommene und per Regel verschobene Titel.
    const drafts = new Map<string, AlbumDraft>();
    for (const track of tracks) {
      const group = groups.get(track.id)!;
      if (excluded.has(`${track.path}\u0000${group.key}`) || rules.moved.has(track.id)) continue;
      let draft = drafts.get(group.key);
      if (!draft) {
        draft = { key: group.key, title: group.title, folder: group.folder, tracks: [], date: group.date };
        drafts.set(group.key, draft);
      }
      draft.tracks.push(track);
    }

    const derive = (draft: AlbumDraft, cover: string | undefined, createdAt: number) => {
      const override = overrides.get(draft.key);
      // Playlists haben keinen Ordner: ihre Art kommt nur von Hand (ohne Art bleiben sie reine Playlists, siehe SECTION_SQL)
      const { section, kind, recording } = sections.get(draft.key) ?? playlistSection(draft.key);
      // Bei Aufnahmen gilt die Vorlage aus dem Regelwerk; ohne Anlass bleibt der Ordnername (die Oberfläche zeigt dann die Art).
      const ruleTitle = recording ? recording.title || basename(draft.folder) : undefined;
      const title = override?.title ?? fix(ruleTitle ?? draft.title);
      // Datum aus den Dateinamen oder dem Albumordner ("2026-09-27 Erntedank"); nur bei automatischen Alben.
      const date = draft.folder ? (draft.date ?? folderDate(draft.folder)) : undefined;
      // Längster Titel zuerst: bei einem Gottesdienst meist die Predigt
      const byLength = [...draft.tracks].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
      // Sprecher: von Hand am Album, dann je Titel gesetzte Sprecher der Predigten, dann aus den Dateinamen
      const speaker =
        override?.speaker ??
        mostCommon(byLength.filter((t) => t.sermon).map((t) => speakerOverrides.get(t.path))) ??
        recording?.speaker ??
        (date && !recording ? mostCommon(byLength.map((t) => parsed(t.path).speaker)) : undefined) ??
        null;
      // Alle Bibelstellen des Albums: zuerst die des Ordners bzw. der Predigt, dann je Titel in Albumreihenfolge
      // aus dem Dateinamen nach dem Regelwerk, sonst (nur bei Aufnahmen) aus Titel oder Dateiname.
      const sermonLike = Boolean(date || recording);
      const passage =
        override?.passage ??
        joinPassages([
          recording?.passage,
          ...[...draft.tracks].sort(compareTracks).flatMap((t) => {
            const known = [recording?.files.get(t.path)?.passage].filter(Boolean);
            if (known.length || !sermonLike) return known;
            const inTitle = findPassages(t.display_title ?? t.title);
            return inTitle.length ? inTitle : findPassages(fileStem(t.path));
          }),
          ...(sermonLike ? findPassages(title) : []),
        ]);
      return {
        key: draft.key,
        title,
        // Das Jahr kommt aus dem Datum, sonst aus dem Ordnernamen ("Chorlieder (1999)")
        year:
          override?.year ??
          (date ? Number(date.slice(0, 4)) : undefined) ??
          mostCommon(draft.tracks.map((t) => t.year ?? yearOf(dateOfPath(t.path)))) ??
          null,
        date: date ?? null,
        speaker,
        passage,
        description: override?.description ?? null,
        folder: draft.folder,
        // Ein hochgeladenes Titelbild geht dem Ordnerbild und den eingebetteten Bildern vor.
        cover: override?.cover_id ? null : (cover ?? null),
        // Eingebettetes Bild, das die meisten Titel tragen (bei Gleichstand das des ersten Titels)
        coverId: override?.cover_id ?? mostCommon(draft.tracks.map((t) => t.cover_id)) ?? null,
        count: draft.tracks.length,
        duration: draft.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0),
        hidden: override?.hidden ? 1 : 0,
        sortTitle: sortKey(title),
        createdAt,
        recording: kind,
        music: section === 'music' ? 1 : 0,
      };
    };

    const upsertAuto = db.prepare(`
      INSERT INTO albums (key, title, year, folder, cover_path, cover_id, track_count, duration, hidden, created_at,
                          date, speaker, passage, description, sort_title, recording, music)
      VALUES (@key, @title, @year, @folder, @cover, @coverId, @count, @duration, @hidden, @createdAt,
              @date, @speaker, @passage, @description, @sortTitle, @recording, @music)
      ON CONFLICT(key) DO UPDATE SET
        title = excluded.title, year = excluded.year,
        folder = excluded.folder, cover_path = excluded.cover_path, cover_id = excluded.cover_id,
        track_count = excluded.track_count, duration = excluded.duration, hidden = excluded.hidden,
        date = excluded.date, speaker = excluded.speaker, passage = excluded.passage, description = excluded.description,
        sort_title = excluded.sort_title, created_at = excluded.created_at,
        recording = excluded.recording, music = excluded.music
      RETURNING id
    `);
    const updateManual = db.prepare(`
      UPDATE albums SET title = @title, year = @year, folder = @folder,
        cover_path = @cover, cover_id = @coverId, track_count = @count, duration = @duration, hidden = @hidden,
        date = @date, speaker = @speaker, passage = @passage, description = @description,
        sort_title = @sortTitle, recording = @recording, music = @music
      WHERE id = @id
    `);

    const existing = db
      .prepare(
        `SELECT id, key, kind, title, year, folder, cover_path AS cover, cover_id AS coverId, track_count AS count, duration, hidden,
                date, speaker, passage, description, sort_title AS sortTitle, created_at AS createdAt,
                recording, music
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
      const draft: AlbumDraft = { key: album.key, title: librarySettings().looseTitle, folder: '', tracks: members };
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
 * Was der Scan aus dem Pfad liest (Titel, Album, Nummer, CD, Jahr), nach den aktuellen Einstellungen neu rechnen;
 * so wirkt eine geänderte Albumbildung (etwa andere Disc-Unterordner) ohne neuen Scan.
 */
function refreshPathValues(db: DB): void {
  const rows = db.prepare('SELECT id, path, title, album, track_no, disc_no, year FROM tracks').all() as Array<{
    id: number;
    path: string;
    title: string;
    album: string | null;
    track_no: number | null;
    disc_no: number | null;
    year: number | null;
  }>;
  const update = db.prepare(
    `UPDATE tracks SET title = @title, album = @album, track_no = @trackNo, disc_no = @discNo, year = @year,
       sort_title = CASE WHEN display_title IS NULL THEN sort_key(@title) ELSE sort_title END
     WHERE id = @id`,
  );
  for (const row of rows) {
    const meta = parsePath(row.path);
    const next = { id: row.id, title: meta.title, album: meta.album ?? null, trackNo: meta.trackNo ?? null, discNo: meta.discNo ?? null, year: meta.year ?? null };
    if (next.title !== row.title || next.album !== row.album || next.trackNo !== row.track_no || next.discNo !== row.disc_no || next.year !== row.year) {
      update.run(next);
    }
  }
}

/**
 * Schreibt, was Regelwerk und Dateiname je Titel ergeben: Anzeige-Titel, Inhalt, Sprecher und die Felder für
 * Kategorien (library/fields.ts). Nur geänderte Titel werden geschrieben.
 * Die Ersetzungen für Tippfehler (fix) gelten für den Anzeige-Titel; raw_title hält ihn davor fest.
 */
function applyRecordings(
  db: DB,
  tracks: TrackRow[],
  recordingOf: (track: TrackRow) => FolderResult | undefined,
  parsed: (path: string) => PathMeta,
  fix: (text: string) => string,
  structure: CompiledStructure,
  manualDecisions: Map<string, ManualDecision>,
  speakerOverrides: Map<string, string>,
): void {
  const setDisplay = db.prepare('UPDATE tracks SET display_title = ?, raw_title = ?, speaker = ?, content = ?, sort_title = ? WHERE id = ?');
  const setPolicy = db.prepare('UPDATE tracks SET playback = ?, sermon = ?, policy = ? WHERE id = ?');
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
    // Aufnahmen nach dem Muster ihrer Art, Musik und Sonstiges nach der Vorlage (Verwaltung → Zuordnung)
    const templated = recording ? null : libraryTrackTitle(track.path);
    const raw = file?.title ?? (templated !== null && templated !== track.title ? templated : null);
    // Ersetzungen nur speichern, wenn sie etwas ändern; sonst bleibt NULL (gescannten Titel zeigen).
    const fixed = fix(raw ?? track.title);
    const title = fixed !== (raw ?? track.title) ? fixed : raw;
    // Policies: bei Aufnahmen schon beim Lesen des Ordners entschieden, sonst hier (ohne Art; Inhalt nur, wenn eine Policy ihn setzt)
    const decision =
      file ??
      withManual(structure.decide({ title: track.title, path: track.path, duration: track.duration }), manualDecisions.get(track.path));
    const content = file?.content ?? decision.content ?? null;
    // Sprecher aus dem Dateinamen: bei Aufnahmen {sprecher} nach dem Muster, sonst vor " - " bei einem Datum im Namen
    const speaker = (recording ? file?.performer : parsed(track.path).speaker) ?? null;
    if (title !== track.display_title || raw !== track.raw_title || speaker !== track.speaker || content !== track.content) {
      setDisplay.run(title, raw, speaker, content, sortKey(title ?? track.title), track.id);
      track.display_title = title;
      track.raw_title = raw;
      track.speaker = speaker;
      track.content = content;
    }
    const playback = decision.player ?? null;
    // Predigt zählt nur bei Aufnahmen (Sprecher und Bibelstelle des Albums)
    const sermon = file?.sermon ? 1 : 0;
    const policy = Object.keys(decision.auto).length ? JSON.stringify(decision.auto) : null;
    if (playback !== track.playback || sermon !== track.sermon || policy !== track.policy) {
      setPolicy.run(playback, sermon, policy, track.id);
      track.playback = playback;
      track.sermon = sermon;
      track.policy = policy;
    }
    const year = dateOfPath(track.path)?.slice(0, 4) ?? (track.year ? String(track.year) : null);
    const tags = trackFields({
      kind: recording?.kind.name ?? null,
      content,
      // Kategorie "Sprecher": wer predigt (bei einem Lied steht dort z. B. der Chor); eine Korrektur je Titel geht vor
      speaker: speakerOverrides.get(track.path) ?? (file ? (file.speaker ?? null) : speaker),
      occasion: recording?.occasion ?? null,
      year,
      passages: joinPassages([
        file?.passage,
        ...(file?.sermon ? [recording?.passage] : []),
        ...findPassages(title ?? track.title),
      ])?.split(PASSAGE_SEPARATOR) ?? [],
      // Ordner über dem Album, ohne den Albumordner selbst
      folders: dirname(parsed(track.path).albumFolder).split('/').filter(Boolean),
    });
    const wanted = tags.map(([tag, value]) => `${tag}\u0000${value}\u0001`).join('');
    if (wanted !== (derived.get(track.id) ?? '')) {
      clearDerived.run(track.id);
      for (const [tag, value] of tags) addDerived.run(track.id, tag, value, foldValue(value));
    }
  }
}
