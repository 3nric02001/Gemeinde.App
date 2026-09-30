import type { DB } from '../db.js';
import { albumsByIds } from './listener.js';
import { albumTierSql, decayFactor } from './popularity.js';
import { searchAlbums, searchTracks } from './queries.js';
import { foldValue } from './text.js';

/**
 * "Häufig gesucht" und "Oft gehört" für die leere Suchseite.
 *
 * Datenschutz: Gezählt wird ein Suchbegriff erst, wenn jemand daraus einen Treffer öffnet, und nur,
 * wenn er in der Bibliothek etwas findet. Angezeigt wird er erst, wenn mindestens MIN_SEARCHERS
 * verschiedene Personen ihn verwendet haben; wer was gesucht hat, erscheint nirgends in Oberfläche
 * oder API. Nach RETENTION_MS ist ein Eintrag gelöscht, mit dem Benutzer sofort.
 */

export const MIN_SEARCHERS = 3;
export const RETENTION_MS = 90 * 24 * 3600 * 1000;
const MAX_LENGTH = 60;
const MAX_WORDS = 6;

/** Anzeigeform und Vergleichsschlüssel ("Pastor Meier" und "pastor  meier" sind derselbe Begriff). */
export function normalizeSearch(input: string): { text: string; key: string } | undefined {
  const text = input.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const key = foldValue(text);
  if (key.length < 2 || text.length > MAX_LENGTH || text.split(' ').length > MAX_WORDS) return undefined;
  return { text, key };
}

function hasResults(db: DB, q: string): boolean {
  return (
    searchTracks(db, { q, limit: 1, offset: 0 }).total > 0 || searchAlbums(db, { q, sort: 'title', limit: 1, offset: 0 }).total > 0
  );
}

/** Einen Suchbegriff merken, nach dem jemand einen Treffer geöffnet hat. `false`: nicht gezählt. */
export function recordSearch(db: DB, userId: number, q: string, now = Date.now()): boolean {
  const search = normalizeSearch(q);
  if (!search || !hasResults(db, search.text)) return false;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO search_log (key, user_id, text, at) VALUES (@key, @userId, @text, @now)
       ON CONFLICT(key, user_id) DO UPDATE SET text = excluded.text, at = excluded.at`,
    ).run({ ...search, userId, now });
    db.prepare('DELETE FROM search_log WHERE at < ?').run(now - RETENTION_MS);
  })();
  return true;
}

/** Begriffe, die mehrere Personen zuletzt gesucht haben und die noch etwas finden. */
export function popularSearches(db: DB, limit = 8, now = Date.now()): string[] {
  const rows = db
    .prepare(
      `SELECT (SELECT text FROM search_log s WHERE s.key = l.key ORDER BY s.at DESC LIMIT 1) AS text
       FROM search_log l WHERE l.at >= @since
       GROUP BY l.key HAVING count(*) >= @min
       ORDER BY count(*) DESC, max(l.at) DESC LIMIT @candidates`,
    )
    .all({ since: now - RETENTION_MS, min: MIN_SEARCHERS, candidates: limit * 3 }) as Array<{ text: string }>;
  // Die Bibliothek kann sich seitdem geändert haben: nur zeigen, was noch Treffer bringt.
  return rows
    .map((row) => row.text)
    .filter((text) => hasResults(db, text))
    .slice(0, limit);
}

/** Alben, die zuletzt wirklich gehört wurden (verdecktes Scoring), das Beliebteste zuerst. */
export function popularAlbums(db: DB, limit = 12, now = Date.now()): Record<string, unknown>[] {
  const ids = (
    db
      .prepare(
        `SELECT id FROM (SELECT a.id, a.date, a.year, a.sort_title, ${albumTierSql('a')} AS tier FROM albums a WHERE a.hidden = 0)
         WHERE tier >= 1 ORDER BY tier DESC, date DESC NULLS LAST, year DESC, sort_title LIMIT @limit`,
      )
      .all({ decay: decayFactor(now), limit }) as Array<{ id: number }>
  ).map((row) => row.id);
  return albumsByIds(db, ids);
}
