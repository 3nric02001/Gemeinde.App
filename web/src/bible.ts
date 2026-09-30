import { getAuth } from './auth';

/** Mehrere Bibelstellen stehen durch ";" getrennt in einem Feld. */
export const splitPassages = (value: string | null | undefined): string[] =>
  (value ?? '').split(';').map((p) => p.trim()).filter(Boolean);

/**
 * Bibeltext zu einer Stelle bei bibleserver.com, in der Übersetzung aus der Verwaltung. bibleserver versteht die
 * üblichen deutschen Namen und Abkürzungen ("Joh 3,16", "1. Kor 13"); Leerzeichen fallen weg.
 */
export function bibleUrl(passage: string, translation = getAuth().bibleTranslation || 'LUT'): string {
  const reference = passage.replace(/\s+/g, '').replace(/–/g, '-');
  return `https://www.bibleserver.com/${encodeURIComponent(translation)}/${encodeURIComponent(reference)}`;
}
