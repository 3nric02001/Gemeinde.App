import { getMeta, type DB } from '../db.js';
import { albumFolderOf, basename } from './pathMeta.js';

/** Ein unterster Musikordner mit Datum im Namen, z. B. "2026-09-27 Gottesdienst" */
export interface DatedFolder {
  /** Ordnerpfad relativ zum Musikordner, dient auch als Schlüssel */
  folder: string;
  name: string;
  /** ISO-Datum JJJJ-MM-TT */
  date: string;
  trackCount: number;
  duration: number;
  /** Titel, dessen Bild als Cover dient (Titelbild oder Albumcover) */
  coverTrackId: number | null;
  /** Album des ersten Titels; liefert Sprecher, Bibelstelle und Beschreibung */
  albumId: number | null;
}

export interface SermonInfo {
  speaker: string | null;
  passage: string | null;
  description: string | null;
}

/** Sprecher, Bibelstelle und Beschreibung aus dem zugehörigen Album (Tags oder Verwaltung), zur Anfragezeit gelesen. */
export function withSermonInfo<T extends DatedFolder>(db: DB, folders: T[]): Array<T & SermonInfo> {
  const ids = folders.map((f) => f.albumId).filter((id): id is number => id !== null);
  const rows = ids.length
    ? (db
        .prepare('SELECT id, speaker, passage, description FROM albums WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(ids)) as Array<SermonInfo & { id: number }>)
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return folders.map((folder) => {
    const info = folder.albumId !== null ? byId.get(folder.albumId) : undefined;
    return { ...folder, speaker: info?.speaker ?? null, passage: info?.passage ?? null, description: info?.description ?? null };
  });
}

const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, jänner: 1, feb: 2, februar: 2, mär: 3, mar: 3, märz: 3, maerz: 3, apr: 4, april: 4,
  mai: 5, jun: 6, juni: 6, jul: 7, juli: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10, nov: 11, november: 11, dez: 12, dezember: 12,
};

function valid(y: number, m: number, d: number): string | undefined {
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return undefined; // z. B. 31.02.
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/**
 * Liest ein Datum aus einem Ordnernamen. Erkennt 2026-09-27, 2026_09_27, 20260927,
 * 27.09.2026, 27.9.26 und 27. September 2026.
 */
export function parseFolderDate(name: string): string | undefined {
  const iso = /(?<!\d)((?:19|20)\d{2})[-_.\s]?(\d{2})[-_.\s]?(\d{2})(?!\d)/.exec(name);
  if (iso) {
    const date = valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (date) return date;
  }
  const german = /(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.\s?((?:19|20)?\d{2})(?!\d)/.exec(name);
  if (german) {
    const date = valid(fullYear(german[3]!), Number(german[2]), Number(german[1]));
    if (date) return date;
  }
  const words = /(?<!\d)(\d{1,2})\.?\s*([a-zäöü]{3,9})\.?\s*((?:19|20)\d{2})(?!\d)/i.exec(name);
  if (words) {
    const month = MONTHS[words[2]!.toLowerCase()];
    if (month) return valid(Number(words[3]), month, Number(words[1]));
  }
  return undefined;
}

const caches = new WeakMap<DB, { key: string; folders: DatedFolder[] }>();

/**
 * Alle untersten Ordner mit Datum im Namen, neueste zuerst. Disc-Unterordner (CD 1, CD 2)
 * zählen wie bei den Alben zum Elternordner. Wird nach jedem Scan neu berechnet.
 */
export function listDatedFolders(db: DB): DatedFolder[] {
  const { n } = db.prepare('SELECT count(*) AS n FROM tracks').get() as { n: number };
  const key = `${getMeta(db, 'lastScanAt') ?? ''}:${n}`;
  const cache = caches.get(db);
  if (cache?.key === key) return cache.folders;

  const rows = db
    .prepare(
      `SELECT t.id, t.path, t.duration, t.album_id,
              (t.cover_id IS NOT NULL OR a.cover_path IS NOT NULL OR a.cover_id IS NOT NULL) AS hasCover
       FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
       ORDER BY coalesce(t.disc_no, 1), t.track_no IS NULL, t.track_no, t.path`,
    )
    .all() as Array<{ id: number; path: string; duration: number | null; hasCover: number; album_id: number | null }>;

  const byFolder = new Map<string, DatedFolder>();
  for (const row of rows) {
    const folder = albumFolderOf(row.path);
    let entry = byFolder.get(folder);
    if (!entry) {
      const date = parseFolderDate(basename(folder));
      if (!date) continue;
      entry = { folder, name: basename(folder), date, trackCount: 0, duration: 0, coverTrackId: null, albumId: row.album_id };
      byFolder.set(folder, entry);
    }
    entry.trackCount++;
    entry.albumId ??= row.album_id;
    entry.duration += row.duration ?? 0;
    if (entry.coverTrackId === null && row.hasCover) entry.coverTrackId = row.id;
  }
  const folders = [...byFolder.values()].sort(
    (a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, 'de'),
  );
  caches.set(db, { key, folders });
  return folders;
}

/** Titel-IDs eines Datumsordners in Abspielreihenfolge */
export function datedFolderTrackIds(db: DB, folder: string): number[] {
  const rows = db
    .prepare(
      `SELECT id, path FROM tracks WHERE path LIKE ? ESCAPE '\\'
       ORDER BY coalesce(disc_no, 1), track_no IS NULL, track_no, path`,
    )
    .all(`${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`) as Array<{ id: number; path: string }>;
  // Nur Titel, die wirklich zu diesem Ordner gehören (nicht aus tieferen Unterordnern)
  return rows.filter((row) => albumFolderOf(row.path) === folder).map((row) => row.id);
}
