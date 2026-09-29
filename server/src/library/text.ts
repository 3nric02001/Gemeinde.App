/**
 * Vergleichsschlüssel für Tag-Werte: Groß-/Kleinschreibung, Akzente und doppelte Leerzeichen
 * spielen keine Rolle ("Lied", "lied ", "Lìed" landen beim selben Wert).
 */
export function foldValue(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Sortierschlüssel wie im Telefonbuch: Umlaute wie ihr Grundbuchstabe ("Ärger" bei A, nicht hinter Z),
 * Groß-/Kleinschreibung egal, Zahlen nach ihrem Wert ("2 Lieder" vor "10 Gebote"), Satzzeichen am
 * Anfang zählen nicht, ein englisches "The" am Anfang auch nicht ("The Brook" steht bei B).
 * Das Ergebnis wird in SQLite binär verglichen und lässt sich deshalb mit einem Index sortieren.
 */
export function sortKey(value: string | null | undefined): string {
  if (!value) return '';
  const folded = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the (?=\S)/, '');
  // Zahlen auf feste Breite bringen, damit sie als Text richtig herum stehen.
  return folded.replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, '').padStart(8, '0'));
}

const FEATURING = /\s*[([]?\s*\b(?:feat\.?|ft\.|featuring)\s+/i;

/**
 * Einzelne Interpreten aus einem Interpreten-Feld: "Hillsong feat. Anna & Ben" ergibt
 * Hillsong, Anna und Ben. Der Hauptinterpret wird nicht an "&" getrennt (Simon & Garfunkel).
 */
export function artistNames(value: string): string[] {
  const match = FEATURING.exec(value);
  if (!match) return value.trim() ? [value.trim()] : [];
  const main = value.slice(0, match.index).trim();
  const guests = value
    .slice(match.index + match[0].length)
    .replace(/[)\]]\s*$/, '')
    .split(/\s*(?:,|&|\bund\b|\band\b)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
  return [main, ...guests].filter(Boolean);
}

/** Hauptinterpret ohne Gäste: "Hillsong feat. Anna" -> "Hillsong" */
export function mainArtist(value: string): string {
  return artistNames(value)[0] ?? value.trim();
}

/** Gleicher Interpret trotz anderer Schreibweise ("Hillsong UNITED", "Hillsong United") */
export function artistKey(value: string): string {
  return sortKey(value);
}
