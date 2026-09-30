import type { DB } from '../db.js';
import { SPEAKER_TAGS } from './metadata.js';
import { getStructure } from './structure.js';
import { artistKey, artistNames, foldValue } from './text.js';

/**
 * Interpreten zusammenführen (Verwaltung → Interpreten): Ein Name aus Dateien, Tags oder dem Regelwerk
 * wird überall als ein anderer geführt, z. B. "J. Rauschenberger" als "Jakob Rauschenberger".
 * Das gilt für Titel, Alben, Sprecher, die Interpretenliste und Kategorien aus Interpreten- und
 * Sprecher-Feldern. Die Dateien in der Nextcloud bleiben unverändert.
 */

/** Tag-Felder, deren Werte Interpreten bzw. Sprecher sind; Kategorien daraus folgen den Zusammenführungen. */
export const ARTIST_TAGS = ['artist', 'albumartist', ...SPEAKER_TAGS];

export interface ArtistAlias {
  source: string;
  target: string;
}

export class ArtistError extends Error {}

/** Zusammenführungen je Datenbank im Speicher, damit auch SQL (artist_alias) sie ohne Abfrage nutzen kann */
const caches = new WeakMap<DB, { map: Map<string, string>; version: number }>();
let versions = 0;

export function loadArtistAliases(db: DB): void {
  const rows = db.prepare('SELECT source_key, target FROM artist_aliases').all() as Array<{ source_key: string; target: string }>;
  caches.set(db, { map: new Map(rows.map((row) => [row.source_key, row.target])), version: ++versions });
}

/** Stand der Zusammenführungen, für Zwischenspeicher, die davon abhängen */
export function aliasVersion(db: DB): number {
  return caches.get(db)?.version ?? 0;
}

/**
 * Name, unter dem ein Interpret geführt wird. "J. Rauschenberger feat. Chor" wird Teil für Teil übersetzt,
 * wenn der ganze Name keine eigene Zuordnung hat.
 */
export function aliasOf(db: DB, name: string): string {
  const map = caches.get(db)?.map;
  if (!map?.size || !name) return name;
  const whole = map.get(artistKey(name));
  if (whole) return whole;
  const parts = artistNames(name);
  if (parts.length < 2) return name;
  const mapped = parts.map((part) => map.get(artistKey(part)) ?? part);
  if (mapped.every((part, i) => part === parts[i])) return name;
  const [main, ...guests] = mapped;
  return `${main} feat. ${guests.join(' & ')}`;
}

export function listArtistAliases(db: DB): ArtistAlias[] {
  return db.prepare('SELECT source, target FROM artist_aliases ORDER BY target COLLATE NOCASE, source COLLATE NOCASE').all() as ArtistAlias[];
}

/**
 * Führt Namen unter einem Zielnamen zusammen. Stand ein Quellname schon als Ziel anderer Namen da, zeigen
 * diese nun ebenfalls auf das neue Ziel; ist das Ziel selbst zugeordnet, gilt dessen Ziel (keine Ketten).
 */
export function mergeArtists(db: DB, sources: string[], target: string): void {
  let goal = target.trim();
  if (!goal) throw new ArtistError('Der Name, unter dem zusammengeführt wird, fehlt');
  if (goal.length > 200) throw new ArtistError('Der Name ist zu lang');
  const names = [...new Set(sources.map((s) => s.trim()).filter(Boolean))];
  if (!names.length) throw new ArtistError('Mindestens ein Name ist nötig');
  if (names.length > 200) throw new ArtistError('Höchstens 200 Namen auf einmal');
  goal = caches.get(db)?.map.get(artistKey(goal)) ?? goal;
  const goalKey = artistKey(goal);
  db.transaction(() => {
    // Das Ziel ist kein Quellname mehr
    db.prepare('DELETE FROM artist_aliases WHERE source_key = ?').run(goalKey);
    const upsert = db.prepare(
      `INSERT INTO artist_aliases (source_key, source, target) VALUES (?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET source = excluded.source, target = excluded.target`,
    );
    const retarget = db.prepare('UPDATE artist_aliases SET target = ? WHERE target = ? COLLATE NOCASE');
    const targets = db.prepare('SELECT DISTINCT target FROM artist_aliases').all() as Array<{ target: string }>;
    for (const name of names) {
      const key = artistKey(name);
      if (!key || key === goalKey) continue;
      upsert.run(key, name, goal);
      for (const { target: old } of targets) if (artistKey(old) === key) retarget.run(goal, old);
    }
    // Schreibweise des Ziels einheitlich (Groß-/Kleinschreibung wie eingegeben)
    for (const { target: old } of targets) if (artistKey(old) === goalKey && old !== goal) retarget.run(goal, old);
  })();
  loadArtistAliases(db);
}

/** Hebt die Zuordnung eines Namens auf; er erscheint wieder unter eigenem Namen. */
export function unmergeArtist(db: DB, source: string): void {
  const { changes } = db.prepare('DELETE FROM artist_aliases WHERE source_key = ?').run(artistKey(source));
  if (!changes) throw new ArtistError('Dieser Name ist keinem anderen zugeordnet');
  loadArtistAliases(db);
}

/**
 * Kategorien aus Interpreten- oder Sprecher-Feldern bekommen die Zusammenführungen als Gruppen dazu,
 * "Jakob Rauschenberger" steht dort dann für alle zugeordneten Schreibweisen. Eigene Gruppen der
 * Kategorie gehen vor.
 */
export function withArtistGroups<T extends { fields: string[]; groups: Array<{ label: string; values: string[] }> }>(
  db: DB,
  definition: T,
): T {
  const aliases = listArtistAliases(db);
  if (!aliases.length || !definition.fields.some((field) => ARTIST_TAGS.includes(field))) return definition;
  const taken = new Set(definition.groups.flatMap((g) => g.values.map(foldValue)));
  const byTarget = new Map<string, string[]>();
  for (const { source, target } of aliases) byTarget.set(target, [...(byTarget.get(target) ?? []), source]);
  const extra: Array<{ label: string; values: string[] }> = [];
  for (const [target, sources] of byTarget) {
    const own = definition.groups.find((g) => foldValue(g.label) === foldValue(target));
    const values = [target, ...sources].filter((v) => !taken.has(foldValue(v)));
    if (own) own.values = [...own.values, ...values];
    else if (values.length) extra.push({ label: target, values });
  }
  return { ...definition, groups: [...definition.groups, ...extra] };
}

// ---------- Übersicht für die Verwaltung ----------

export interface ArtistEntry {
  name: string;
  trackCount: number;
  /** Zielname, wenn dieser Name zugeordnet ist */
  target: string | null;
}

export interface ArtistOverview {
  items: ArtistEntry[];
  /** Namen, die vermutlich dieselbe Person oder Gruppe meinen */
  suggestions: Array<{ names: string[]; target: string }>;
}

/**
 * Alle Namen, wie sie aus Dateien, Tags und Regelwerk kommen (vor der Zusammenführung), mit Anzahl
 * Titel: Interpret, Album-Interpret, Sprecher-Felder und Sprecher aus Korrekturen.
 */
export function artistOverview(db: DB): ArtistOverview {
  const rows = db
    .prepare(
      `SELECT name, count(DISTINCT id) AS n FROM (
         SELECT id, coalesce(raw_artist, display_artist, artist) AS name FROM tracks
         UNION ALL SELECT id, album_artist FROM tracks WHERE album_artist IS NOT NULL
         UNION ALL SELECT track_id, value FROM track_tags WHERE tag IN (SELECT value FROM json_each(?))
         UNION ALL SELECT t.id, o.speaker FROM track_overrides o JOIN tracks t ON t.path = o.path WHERE o.speaker IS NOT NULL
       ) WHERE name IS NOT NULL AND name <> '' GROUP BY name`,
    )
    .all(JSON.stringify(SPEAKER_TAGS)) as Array<{ name: string; n: number }>;
  const map = caches.get(db)?.map ?? new Map<string, string>();
  // Die Art ("Gottesdienst", "Bibelstunde") steht bei Aufnahmen ohne Sprecher als Interpret, ist aber keiner.
  const kinds = new Set(getStructure(db).kinds.map((kind) => artistKey(kind.name)));
  const counts = new Map<string, { name: string; trackCount: number }>();
  for (const row of rows) {
    for (const name of artistNames(row.name)) {
      const key = artistKey(name);
      if (!key || kinds.has(key)) continue;
      const entry = counts.get(key);
      if (!entry) counts.set(key, { name, trackCount: row.n });
      else entry.trackCount += row.n;
    }
  }
  // Zielnamen, die selbst in keiner Datei vorkommen, trotzdem zeigen
  for (const target of new Set(map.values())) {
    if (!counts.has(artistKey(target))) counts.set(artistKey(target), { name: target, trackCount: 0 });
  }
  const items = [...counts]
    .map(([key, entry]) => ({ ...entry, target: map.get(key) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  return { items, suggestions: suggestMerges(items.filter((item) => !item.target)) };
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return row[b.length]!;
}

/**
 * Vorschläge: gleicher Nachname und passender Vorname oder Initiale ("J. Rauschenberger",
 * "Jakob Rauschenberger"), gleiche Buchstaben ohne Leer- und Satzzeichen ("Gemeinde Chor", "Gemeindechor")
 * oder ein bis zwei Tippfehler bei längeren Namen ("Rauschenbeger"). Ziel ist der Name mit den meisten Titeln.
 */
export function suggestMerges(entries: Array<{ name: string; trackCount: number }>): Array<{ names: string[]; target: string }> {
  const words = (name: string) => foldValue(name).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(Boolean);
  const compact = (name: string) => words(name).join('');
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (a: number, b: number) => (parent[find(a)] = find(b));
  const similar = (a: string, b: string) => {
    if (compact(a) === compact(b)) return true;
    const wa = words(a);
    const wb = words(b);
    if (wa.length >= 2 && wb.length >= 2 && wa.at(-1) === wb.at(-1) && wa.at(-1)!.length >= 4) {
      const [fa, fb] = [wa[0]!, wb[0]!];
      if (fa === fb || (fa.length === 1 && fb.startsWith(fa)) || (fb.length === 1 && fa.startsWith(fb))) return true;
    }
    const [ca, cb] = [compact(a), compact(b)];
    return Math.min(ca.length, cb.length) >= 8 && ca.slice(0, 3) === cb.slice(0, 3) && distance(ca, cb) <= 2;
  };
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) if (similar(entries[i]!.name, entries[j]!.name)) join(i, j);
  }
  const groups = new Map<number, Array<{ name: string; trackCount: number }>>();
  entries.forEach((entry, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), entry]));
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = [...group].sort((a, b) => b.trackCount - a.trackCount || b.name.length - a.name.length);
      return { names: sorted.map((e) => e.name), target: sorted[0]!.name };
    })
    .slice(0, 50);
}
