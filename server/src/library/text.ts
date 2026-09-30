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
