/**
 * Erkennt Bibelstellen in Titeln und Dateinamen ("Psalm 23", "Joh 3,16", "1. Kor 13,1-13"),
 * damit Predigten eine Bibelstelle bekommen. Weitere Schreibweisen stehen in der Verwaltung (settings.ts).
 */
import { librarySettings, onLibrarySettings } from './settings.js';

// Deutsche Buchnamen (Luther, Elberfelder, Einheitsübersetzung) und die üblichen Abkürzungen. Ohne "Mo", "Mi",
// "Am", "Hi" und "Ri": "Mi 18 Uhr" oder "Am 27." sollen keine Bibelstelle werden.
const BOOKS = [
  'Mose', 'Genesis', 'Gen', 'Exodus', 'Ex', 'Levitikus', 'Lev', 'Numeri', 'Num', 'Deuteronomium', 'Dtn',
  'Josua', 'Jos', 'Richter', 'Rut', 'Ruth', 'Samuel', 'Sam', 'Könige', 'Kön', 'Koenige', 'Chronik', 'Chr',
  'Esra', 'Esr', 'Nehemia', 'Neh', 'Ester', 'Esther', 'Est', 'Hiob', 'Ijob', 'Psalmen', 'Psalm', 'Ps', 'Sprüche',
  'Spr', 'Prediger', 'Pred', 'Kohelet', 'Koh', 'Hoheslied', 'Hld', 'Jesaja', 'Jes', 'Jeremia', 'Jer', 'Klagelieder',
  'Klgl', 'Hesekiel', 'Hes', 'Ezechiel', 'Ez', 'Daniel', 'Dan', 'Hosea', 'Hos', 'Joel', 'Amos', 'Obadja', 'Obd',
  'Jona', 'Micha', 'Nahum', 'Nah', 'Habakuk', 'Hab', 'Zefanja', 'Zef', 'Haggai', 'Hag', 'Sacharja', 'Sach',
  'Maleachi', 'Mal', 'Matthäus', 'Matthaeus', 'Mt', 'Markus', 'Mk', 'Lukas', 'Lk', 'Johannes', 'Joh',
  'Apostelgeschichte', 'Apg', 'Römer', 'Roemer', 'Röm', 'Korinther', 'Kor', 'Galater', 'Gal', 'Epheser', 'Eph',
  'Philipper', 'Phil', 'Kolosser', 'Kol', 'Thessalonicher', 'Thess', 'Timotheus', 'Tim', 'Titus', 'Tit',
  'Philemon', 'Phlm', 'Hebräer', 'Hebr', 'Heb', 'Jakobus', 'Jak', 'Petrus', 'Petr', 'Judas', 'Jud', 'Offenbarung', 'Offb',
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Buchnamen samt weiteren Schreibweisen aus der Verwaltung; längere zuerst, damit "Psalmen" nicht als "Ps" + Rest endet. */
function reference(extra: string[]): RegExp {
  const book = [...new Set([...BOOKS, ...extra.map((b) => b.trim()).filter(Boolean)])]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');
  return new RegExp(
    String.raw`(?<![\p{L}\d])(?:([1-5])\.?\s*)?(${book})\.?\s+(\d{1,3})(?:\s*[,:]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?)?(?![\p{L}\d])`,
    'u',
  );
}

let REFERENCE = reference(librarySettings().bookSpellings);
onLibrarySettings(() => {
  REFERENCE = reference(librarySettings().bookSpellings);
});

const format = ([, number, book, chapter, verse, to]: RegExpMatchArray) =>
  `${number ? `${number}. ` : ''}${book} ${chapter}${verse ? `,${verse}${to ? `-${to}` : ''}` : ''}`;

/** Die erste Bibelstelle im Text, so geschrieben wie dort, oder undefined */
export function findPassage(text: string): string | undefined {
  const match = REFERENCE.exec(text);
  return match ? format(match) : undefined;
}

/** Alle Bibelstellen im Text ("Psalm 23 und Joh 3,16"), in der Reihenfolge des Textes */
export function findPassages(text: string): string[] {
  return [...text.matchAll(new RegExp(REFERENCE.source, 'gu'))].map(format);
}

/** Trennzeichen, mit dem mehrere Bibelstellen eines Albums in einem Feld stehen */
export const PASSAGE_SEPARATOR = '; ';

/**
 * Fasst Bibelstellen zu einem Feld zusammen: leere weg, doppelte ("Joh 3, 16" und "Joh 3,16") nur einmal,
 * in der Reihenfolge des ersten Auftretens. Ein Wert mit ";" zählt als mehrere Stellen.
 */
export function joinPassages(values: Array<string | null | undefined>): string | null {
  const seen = new Map<string, string>();
  for (const value of values) {
    for (const part of value?.split(';') ?? []) {
      const passage = part.trim();
      if (!passage) continue;
      const key = (findPassage(passage) ?? passage).toLowerCase().replace(/[\s.]/g, '');
      if (!seen.has(key)) seen.set(key, passage);
    }
  }
  return seen.size ? [...seen.values()].join(PASSAGE_SEPARATOR) : null;
}
