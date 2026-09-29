/**
 * Vergleichsschlüssel für Tag-Werte: Groß-/Kleinschreibung, Akzente und doppelte Leerzeichen
 * spielen keine Rolle ("Lied", "lied ", "Lìed" landen beim selben Wert).
 */
export function foldValue(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
