/**
 * Datum in Ordner- und Dateinamen erkennen ("2026-09-27 Erntedank", "27.09.2026", "27. September 2026").
 * Eigenes Modul ohne Abhängigkeiten, weil Pfad-Ableitung, Alben und Regeln es gleichermaßen brauchen.
 */

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

export interface FoundDate {
  /** ISO-Datum JJJJ-MM-TT */
  date: string;
  /** Stelle und Länge im Namen, um das Datum herauszuschneiden */
  index: number;
  length: number;
}

// Zwischen Jahr, Monat und Tag überall derselbe Trenner (oder keiner): "2026 09 27" ja, "1925 1025" nicht.
const ISO = /(?<!\d)((?:19|20)\d{2})([-_.\s]?)(\d{2})\2(\d{2})(?!\d)/g;
const GERMAN = /(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.(?:\s?((?:19|20)?\d{2})(?!\d))?/g;
const WORDS = /(?<![\d\p{L}])(\d{1,2})\.?\s*([a-zäöü]{3,9})\.?(?:\s*((?:19|20)\d{2})(?!\d))?/giu;

/**
 * Sucht ein Datum im Namen. Erkennt 2026-09-27, 2026_09_27, 20260927, 27.09.2026, 27.9.26 und
 * 27. September 2026. Fehlt das Jahr ("27.09.", "1. Oktober"), gilt `fallbackYear`, sonst zählt es nicht.
 */
export function findDate(name: string, fallbackYear?: number): FoundDate | undefined {
  for (const match of name.matchAll(ISO)) {
    const date = valid(Number(match[1]), Number(match[3]), Number(match[4]));
    if (date) return { date, index: match.index, length: match[0].length };
  }
  for (const match of name.matchAll(GERMAN)) {
    const year = match[3] ? fullYear(match[3]) : fallbackYear;
    if (year === undefined) continue;
    const date = valid(year, Number(match[2]), Number(match[1]));
    if (date) return { date, index: match.index, length: match[0].length };
  }
  for (const match of name.matchAll(WORDS)) {
    const month = MONTHS[match[2]!.toLowerCase()];
    const year = match[3] ? Number(match[3]) : fallbackYear;
    // Ohne Jahr nur mit Punkt nach dem Tag ("3. Mai"), damit "Teil 3 Mai…" kein Datum wird.
    if (!month || year === undefined || (!match[3] && !/^\d{1,2}\./.test(match[0]))) continue;
    const date = valid(year, month, Number(match[1]));
    if (date) return { date, index: match.index, length: match[0].length };
  }
  return undefined;
}

/** Nur das Datum aus einem Namen (siehe findDate) */
export function parseFolderDate(name: string, fallbackYear?: number): string | undefined {
  return findDate(name, fallbackYear)?.date;
}

/** Ein Jahr allein im Namen ("2026", "Predigten 2025"), aber kein vollständiges Datum */
export function yearIn(name: string): number | undefined {
  if (findDate(name)) return undefined;
  const match = /(?<!\d)((?:19|20)\d{2})(?!\d)/.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** Ordnername, der nur aus einer Jahreszahl besteht ("2026") */
export const isYearOnly = (name: string) => /^\s*(?:19|20)\d{2}\s*$/.test(name);
