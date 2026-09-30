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

/**
 * Die 66 Bücher in Bibel-Reihenfolge mit ihren Schreibweisen aus BOOKS, für "Stöbern nach Bibelbuch".
 * Nummerierte Bücher ("1. Korinther") stehen einzeln; ein Buch mit Nummer, aber ohne eigenen Eintrag
 * ("1. Johannes") ist der Brief, ohne Nummer das Evangelium.
 */
const CANON: Array<{ name: string; testament: 'at' | 'nt'; spellings: string[]; number?: number }> = [
  ...[1, 2, 3, 4, 5].map((n) => ({
    name: `${n}. Mose`,
    testament: 'at' as const,
    number: n,
    spellings: ['Mose', ...[['Genesis', 'Gen'], ['Exodus', 'Ex'], ['Levitikus', 'Lev'], ['Numeri', 'Num'], ['Deuteronomium', 'Dtn']][n - 1]!],
  })),
  { name: 'Josua', testament: 'at', spellings: ['Josua', 'Jos'] },
  { name: 'Richter', testament: 'at', spellings: ['Richter'] },
  { name: 'Rut', testament: 'at', spellings: ['Rut', 'Ruth'] },
  ...[1, 2].map((n) => ({ name: `${n}. Samuel`, testament: 'at' as const, number: n, spellings: ['Samuel', 'Sam'] })),
  ...[1, 2].map((n) => ({ name: `${n}. Könige`, testament: 'at' as const, number: n, spellings: ['Könige', 'Kön', 'Koenige'] })),
  ...[1, 2].map((n) => ({ name: `${n}. Chronik`, testament: 'at' as const, number: n, spellings: ['Chronik', 'Chr'] })),
  { name: 'Esra', testament: 'at', spellings: ['Esra', 'Esr'] },
  { name: 'Nehemia', testament: 'at', spellings: ['Nehemia', 'Neh'] },
  { name: 'Ester', testament: 'at', spellings: ['Ester', 'Esther', 'Est'] },
  { name: 'Hiob', testament: 'at', spellings: ['Hiob', 'Ijob'] },
  { name: 'Psalmen', testament: 'at', spellings: ['Psalmen', 'Psalm', 'Ps'] },
  { name: 'Sprüche', testament: 'at', spellings: ['Sprüche', 'Spr'] },
  { name: 'Prediger', testament: 'at', spellings: ['Prediger', 'Pred', 'Kohelet', 'Koh'] },
  { name: 'Hoheslied', testament: 'at', spellings: ['Hoheslied', 'Hld'] },
  { name: 'Jesaja', testament: 'at', spellings: ['Jesaja', 'Jes'] },
  { name: 'Jeremia', testament: 'at', spellings: ['Jeremia', 'Jer'] },
  { name: 'Klagelieder', testament: 'at', spellings: ['Klagelieder', 'Klgl'] },
  { name: 'Hesekiel', testament: 'at', spellings: ['Hesekiel', 'Hes', 'Ezechiel', 'Ez'] },
  { name: 'Daniel', testament: 'at', spellings: ['Daniel', 'Dan'] },
  { name: 'Hosea', testament: 'at', spellings: ['Hosea', 'Hos'] },
  { name: 'Joel', testament: 'at', spellings: ['Joel'] },
  { name: 'Amos', testament: 'at', spellings: ['Amos'] },
  { name: 'Obadja', testament: 'at', spellings: ['Obadja', 'Obd'] },
  { name: 'Jona', testament: 'at', spellings: ['Jona'] },
  { name: 'Micha', testament: 'at', spellings: ['Micha'] },
  { name: 'Nahum', testament: 'at', spellings: ['Nahum', 'Nah'] },
  { name: 'Habakuk', testament: 'at', spellings: ['Habakuk', 'Hab'] },
  { name: 'Zefanja', testament: 'at', spellings: ['Zefanja', 'Zef'] },
  { name: 'Haggai', testament: 'at', spellings: ['Haggai', 'Hag'] },
  { name: 'Sacharja', testament: 'at', spellings: ['Sacharja', 'Sach'] },
  { name: 'Maleachi', testament: 'at', spellings: ['Maleachi', 'Mal'] },
  { name: 'Matthäus', testament: 'nt', spellings: ['Matthäus', 'Matthaeus', 'Mt'] },
  { name: 'Markus', testament: 'nt', spellings: ['Markus', 'Mk'] },
  { name: 'Lukas', testament: 'nt', spellings: ['Lukas', 'Lk'] },
  { name: 'Johannes', testament: 'nt', spellings: ['Johannes', 'Joh'] },
  { name: 'Apostelgeschichte', testament: 'nt', spellings: ['Apostelgeschichte', 'Apg'] },
  { name: 'Römer', testament: 'nt', spellings: ['Römer', 'Roemer', 'Röm'] },
  ...[1, 2].map((n) => ({ name: `${n}. Korinther`, testament: 'nt' as const, number: n, spellings: ['Korinther', 'Kor'] })),
  { name: 'Galater', testament: 'nt', spellings: ['Galater', 'Gal'] },
  { name: 'Epheser', testament: 'nt', spellings: ['Epheser', 'Eph'] },
  { name: 'Philipper', testament: 'nt', spellings: ['Philipper', 'Phil'] },
  { name: 'Kolosser', testament: 'nt', spellings: ['Kolosser', 'Kol'] },
  ...[1, 2].map((n) => ({ name: `${n}. Thessalonicher`, testament: 'nt' as const, number: n, spellings: ['Thessalonicher', 'Thess'] })),
  ...[1, 2].map((n) => ({ name: `${n}. Timotheus`, testament: 'nt' as const, number: n, spellings: ['Timotheus', 'Tim'] })),
  { name: 'Titus', testament: 'nt', spellings: ['Titus', 'Tit'] },
  { name: 'Philemon', testament: 'nt', spellings: ['Philemon', 'Phlm'] },
  { name: 'Hebräer', testament: 'nt', spellings: ['Hebräer', 'Hebr', 'Heb'] },
  { name: 'Jakobus', testament: 'nt', spellings: ['Jakobus', 'Jak'] },
  ...[1, 2].map((n) => ({ name: `${n}. Petrus`, testament: 'nt' as const, number: n, spellings: ['Petrus', 'Petr'] })),
  ...[1, 2, 3].map((n) => ({ name: `${n}. Johannes`, testament: 'nt' as const, number: n, spellings: ['Johannes', 'Joh'] })),
  { name: 'Judas', testament: 'nt', spellings: ['Judas', 'Jud'] },
  { name: 'Offenbarung', testament: 'nt', spellings: ['Offenbarung', 'Offb'] },
];

export interface BibleBook {
  name: string;
  testament: 'at' | 'nt';
  /** Stelle in der Bibel, 0 = 1. Mose */
  order: number;
}

const fold = (value: string) => value.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
/** "nummer|schreibweise" (ohne Nummer: "|schreibweise") -> Buch */
const BOOK_INDEX = new Map<string, BibleBook>();
CANON.forEach((book, order) => {
  for (const spelling of book.spellings) BOOK_INDEX.set(`${book.number ?? ''}|${fold(spelling)}`, { name: book.name, testament: book.testament, order });
});
/** Ohne Nummer gemeint, aber nur mit Nummer bekannt ("Mose 3" statt "1. Mose 3"): das erste Buch */
CANON.forEach((book, order) => {
  for (const spelling of book.spellings) {
    const key = `|${fold(spelling)}`;
    if (!BOOK_INDEX.has(key)) BOOK_INDEX.set(key, { name: book.name, testament: book.testament, order });
  }
});

/** Buch einer Bibelstelle ("Joh 3,16" -> Johannes, "1. Kor 13" -> 1. Korinther); unbekannte Schreibweisen: undefined */
export function passageBook(passage: string): BibleBook | undefined {
  const match = REFERENCE.exec(passage);
  if (!match) return undefined;
  const [, number, book] = match;
  return BOOK_INDEX.get(`${number ?? ''}|${fold(book!)}`) ?? BOOK_INDEX.get(`|${fold(book!)}`);
}
