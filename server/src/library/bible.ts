/**
 * Erkennt Bibelstellen in Titeln und Dateinamen ("Psalm 23", "Joh 3,16", "1. Kor 13,1-13"),
 * damit Predigten auch ohne Tag-Feld "Bibelstelle" eine bekommen.
 */

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

// Längere Namen zuerst, damit "Psalmen" nicht als "Ps" + Rest endet.
const BOOK = [...BOOKS].sort((a, b) => b.length - a.length).join('|');
const REFERENCE = new RegExp(
  String.raw`(?<![\p{L}\d])(?:([1-5])\.?\s*)?(${BOOK})\.?\s+(\d{1,3})(?:\s*[,:]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?)?(?![\p{L}\d])`,
  'u',
);

/** Die erste Bibelstelle im Text, so geschrieben wie dort, oder undefined */
export function findPassage(text: string): string | undefined {
  const match = REFERENCE.exec(text);
  if (!match) return undefined;
  const [, number, book, chapter, verse, to] = match;
  return `${number ? `${number}. ` : ''}${book} ${chapter}${verse ? `,${verse}${to ? `-${to}` : ''}` : ''}`;
}
