import type { DB } from '../db.js';

/**
 * Ersetzungen für Tippfehler in Titeln (Verwaltung → Schreibweisen), z. B. "Tema" → "Thema".
 * Sie gelten für die angezeigten Titel und Albumnamen, die rebuildAlbums aus Dateien und Regelwerk
 * bildet; die Dateien in der Nextcloud bleiben unverändert. Korrekturen einzelner Titel und Alben
 * in der Verwaltung gehen ihnen vor.
 */
export interface Replacement {
  id: number;
  search: string;
  replacement: string;
  /** Nur ganze Wörter ersetzen ("Tema", nicht "Tematik") */
  wholeWord: boolean;
}

export type ReplacementInput = Omit<Replacement, 'id'>;

export const MAX_REPLACEMENTS = 500;
const MAX_LENGTH = 100;

export class ReplacementError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const upper = (value: string) => value === value.toUpperCase() && value !== value.toLowerCase();

/**
 * Überträgt die Schreibweise des Fundes auf den Ersatz: "TEMA" → "THEMA", "Tema" → "Thema".
 * Sonst bleibt der Ersatz, wie er eingetragen ist ("tema" → "Thema" bei Ersatz "Thema").
 */
function matchCase(found: string, replacement: string): string {
  if (found.length > 1 && upper(found)) return replacement.toUpperCase();
  if (upper(found[0] ?? '')) return (replacement[0] ?? '').toUpperCase() + replacement.slice(1);
  return replacement;
}

/** Baut aus den Ersetzungen eine Funktion, die sie der Reihe nach auf einen Text anwendet. */
export function compileReplacements(list: ReplacementInput[]): (text: string) => string {
  const steps = list.map(({ search, replacement, wholeWord }) => {
    const pattern = wholeWord ? `(?<![\\p{L}\\p{N}])${escape(search)}(?![\\p{L}\\p{N}])` : escape(search);
    return { regex: new RegExp(pattern, 'giu'), replacement };
  });
  if (!steps.length) return (text) => text;
  return (text) => {
    let result = text;
    for (const { regex, replacement } of steps) result = result.replace(regex, (found) => matchCase(found, replacement));
    // Ein ersatzlos gestrichenes Wort soll keine doppelten Leerzeichen hinterlassen.
    return result === text ? text : result.replace(/ {2,}/g, ' ').trim();
  };
}

export function listReplacements(db: DB): Replacement[] {
  return (
    db.prepare('SELECT id, search, replacement, whole_word AS wholeWord FROM title_replacements ORDER BY id').all() as Array<
      Omit<Replacement, 'wholeWord'> & { wholeWord: number }
    >
  ).map((row) => ({ ...row, wholeWord: row.wholeWord === 1 }));
}

/** Prüft eine Ersetzung aus der API; wirft mit verständlicher Meldung. */
export function parseReplacement(input: unknown): ReplacementInput {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const search = typeof obj.search === 'string' ? obj.search.trim() : '';
  const replacement = typeof obj.replacement === 'string' ? obj.replacement.trim() : '';
  if (!search) throw new ReplacementError('Bitte angeben, was ersetzt werden soll');
  if (search.length > MAX_LENGTH || replacement.length > MAX_LENGTH) throw new ReplacementError('Text ist zu lang');
  if (search === replacement) throw new ReplacementError('Suchbegriff und Ersatz sind gleich');
  return { search, replacement, wholeWord: obj.wholeWord !== false };
}

function checkDuplicate(db: DB, input: ReplacementInput, id?: number): void {
  const others = listReplacements(db).filter((r) => r.id !== id);
  if (others.some((r) => r.search.toLowerCase() === input.search.toLowerCase())) {
    throw new ReplacementError(`Für „${input.search}“ gibt es schon eine Ersetzung`, 409);
  }
}

export function addReplacement(db: DB, input: ReplacementInput, now = Date.now()): Replacement {
  checkDuplicate(db, input);
  const { count } = db.prepare('SELECT count(*) AS count FROM title_replacements').get() as { count: number };
  if (count >= MAX_REPLACEMENTS) throw new ReplacementError(`Höchstens ${MAX_REPLACEMENTS} Ersetzungen`);
  const { id } = db
    .prepare('INSERT INTO title_replacements (search, replacement, whole_word, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .get(input.search, input.replacement, input.wholeWord ? 1 : 0, now) as { id: number };
  return { id, ...input };
}

export function updateReplacement(db: DB, id: number, input: ReplacementInput): Replacement {
  checkDuplicate(db, input, id);
  const { changes } = db
    .prepare('UPDATE title_replacements SET search = ?, replacement = ?, whole_word = ? WHERE id = ?')
    .run(input.search, input.replacement, input.wholeWord ? 1 : 0, id);
  if (!changes) throw new ReplacementError('Ersetzung nicht gefunden', 404);
  return { id, ...input };
}

export function deleteReplacement(db: DB, id: number): void {
  const { changes } = db.prepare('DELETE FROM title_replacements WHERE id = ?').run(id);
  if (!changes) throw new ReplacementError('Ersetzung nicht gefunden', 404);
}

export interface ReplacementPreview {
  tracks: { total: number; items: Array<{ id: number; before: string; after: string }> };
  albums: { total: number; items: Array<{ id: number; before: string; after: string }> };
}

const PREVIEW_ITEMS = 50;

/**
 * Was eine neue oder geänderte Ersetzung (id: die bearbeitete) bewirkt, zusammen mit den übrigen.
 * Titel ohne eigene Korrektur werden aus ihrem Namen vor allen Ersetzungen neu berechnet,
 * Albumnamen ohne Korrektur aus dem jetzigen Namen.
 */
export function previewReplacement(db: DB, input: ReplacementInput, id?: number): ReplacementPreview {
  const others = listReplacements(db).filter((r) => r.id !== id);
  const without = compileReplacements(others);
  const withIt = compileReplacements([...others, input]);
  const single = compileReplacements([input]);
  const tracks = db
    .prepare(
      `SELECT id, coalesce(raw_title, title) AS source FROM tracks t
       WHERE NOT EXISTS (SELECT 1 FROM track_overrides o WHERE o.path = t.path AND o.title IS NOT NULL)
       ORDER BY sort_title, id`,
    )
    .all() as Array<{ id: number; source: string }>;
  const trackItems = tracks
    .map(({ id, source }) => ({ id, before: without(source), after: withIt(source) }))
    .filter((t) => t.before !== t.after);
  const albums = db
    .prepare(
      `SELECT a.id, a.title FROM albums a
       WHERE a.kind = 'auto' AND NOT EXISTS (SELECT 1 FROM album_overrides o WHERE o.key = a.key AND o.title IS NOT NULL)
       ORDER BY a.sort_title, a.id`,
    )
    .all() as Array<{ id: number; title: string }>;
  const albumItems = albums
    .map(({ id, title }) => ({ id, before: title, after: single(title) }))
    .filter((a) => a.before !== a.after);
  return {
    tracks: { total: trackItems.length, items: trackItems.slice(0, PREVIEW_ITEMS) },
    albums: { total: albumItems.length, items: albumItems.slice(0, PREVIEW_ITEMS) },
  };
}
