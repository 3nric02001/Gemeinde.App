/**
 * Ab dieser Länge läuft ein Titel ohne Policy im Predigt-Player (Sprünge, Tempo, Weiterhören). Einstellbar in der
 * Verwaltung → Zuordnung („Predigt-Player“); der Server meldet den Wert mit dem Anmeldestatus.
 */
let sermonSeconds = 10 * 60;

export const sermonMinSeconds = () => sermonSeconds;

export function setSermonMinutes(minutes: number | undefined): void {
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) sermonSeconds = minutes * 60;
}
