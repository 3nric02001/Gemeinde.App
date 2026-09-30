import type { DB } from '../db.js';
import { passageBook, type BibleBook } from './bible.js';
import { getTracksByIds } from './queries.js';

/**
 * "Stöbern" auf der Suchseite: Predigten nach Bibelbuch und nach Sprecher. Grundlage sind die Felder, die das
 * Regelwerk je Titel ableitet (track_tags "bibelstelle"), und der Sprecher des Titels samt Korrektur aus der Verwaltung.
 * Titel aus ausgeblendeten Alben zählen nicht.
 */

const VISIBLE = `NOT EXISTS (SELECT 1 FROM albums a WHERE a.id = t.album_id AND a.hidden = 1)`;
const SPEAKER = `coalesce((SELECT speaker FROM track_overrides WHERE path = t.path), t.speaker)`;
/** Neueste zuerst: Datum des Albums, dann die Reihenfolge im Album */
const NEWEST = `(SELECT date FROM albums WHERE id = t.album_id) DESC NULLS LAST, t.disc_no, t.track_no, t.sort_title`;

/** Je Titel seine Bibelstellen; ein Titel zählt je Buch nur einmal, auch mit mehreren Stellen daraus. */
function tracksByBook(db: DB): Map<string, { book: BibleBook; tracks: Set<number> }> {
  const rows = db
    .prepare(
      `SELECT g.track_id AS id, g.value FROM track_tags g JOIN tracks t ON t.id = g.track_id
       WHERE g.tag = 'bibelstelle' AND ${VISIBLE}`,
    )
    .all() as Array<{ id: number; value: string }>;
  const books = new Map<string, { book: BibleBook; tracks: Set<number> }>();
  for (const row of rows) {
    const book = passageBook(row.value);
    if (!book) continue;
    const entry = books.get(book.name) ?? { book, tracks: new Set<number>() };
    entry.tracks.add(row.id);
    books.set(book.name, entry);
  }
  return books;
}

/** Bücher mit Predigten, in Bibel-Reihenfolge */
export function listBooks(db: DB): Array<BibleBook & { count: number }> {
  return [...tracksByBook(db).values()]
    .map(({ book, tracks }) => ({ ...book, count: tracks.size }))
    .sort((a, b) => a.order - b.order);
}

/** Titel zu einem Buch, neueste zuerst; unbekanntes Buch: undefined */
export function tracksOfBook(db: DB, name: string): { book: BibleBook; items: Record<string, unknown>[] } | undefined {
  const entry = tracksByBook(db).get(name);
  if (!entry) return undefined;
  const ids = (
    db
      .prepare(`SELECT t.id FROM tracks t WHERE t.id IN (SELECT value FROM json_each(?)) ORDER BY ${NEWEST}`)
      .all(JSON.stringify([...entry.tracks])) as Array<{ id: number }>
  ).map((row) => row.id);
  return { book: entry.book, items: getTracksByIds(db, ids) };
}

/** Sprecher mit Anzahl ihrer Titel, die meisten zuerst */
export function listSpeakers(db: DB): Array<{ name: string; count: number; latest: string | null }> {
  return db
    .prepare(
      `SELECT ${SPEAKER} AS name, count(*) AS count, max((SELECT date FROM albums WHERE id = t.album_id)) AS latest
       FROM tracks t WHERE ${VISIBLE} AND nullif(trim(${SPEAKER}), '') IS NOT NULL
       GROUP BY name COLLATE NOCASE ORDER BY count DESC, name COLLATE NOCASE`,
    )
    .all() as Array<{ name: string; count: number; latest: string | null }>;
}

/** Titel eines Sprechers, neueste zuerst (Groß- und Kleinschreibung egal) */
export function tracksOfSpeaker(db: DB, name: string): Record<string, unknown>[] {
  const ids = (
    db
      .prepare(`SELECT t.id FROM tracks t WHERE ${VISIBLE} AND ${SPEAKER} = ? COLLATE NOCASE ORDER BY ${NEWEST} LIMIT 500`)
      .all(name.trim()) as Array<{ id: number }>
  ).map((row) => row.id);
  return getTracksByIds(db, ids);
}
