export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '–:––';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "1 Std. 12 Min." für Albumlängen */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} Min.`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

/** "12,3 MB" */
export function formatBytes(bytes: number): string {
  const units = ['Byte', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: unit < 2 ? 0 : 1 })} ${units[unit]}`;
}

export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('de-DE')} ${count === 1 ? one : many}`;
}

const dateOnly = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

/** "Sonntag, 27. September 2026" */
export function formatLongDate(iso: string): string {
  return dateOnly(iso).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** "Sonntag, 27.09.2026" für Karten, wo der Platz knapp ist */
export function formatShortDate(iso: string): string {
  const date = dateOnly(iso);
  return `${date.toLocaleDateString('de-DE', { weekday: 'long' })}, ${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
}

/** "September 2026" für Zwischenüberschriften */
export function formatMonth(iso: string): string {
  return dateOnly(iso).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

export function decadeLabel(decade: number): string {
  return `${decade}er`;
}

export function initials(text: string): string {
  const words = text.split(/[\s\-–&/,.]+/).filter((w) => /\p{L}|\p{N}/u.test(w));
  return words
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join('');
}

/** Stabiler Wert 0…359 aus einem Text, für Platzhalter-Cover */
export function hashHue(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return Math.abs(hash) % 360;
}

const MONTH_WORDS =
  'jan|januar|jänner|feb|februar|mär|mar|märz|maerz|apr|april|mai|jun|juni|jul|juli|aug|august|sep|sept|september|okt|oktober|nov|november|dez|dezember';
/** Dieselben Schreibweisen, die der Server in Ordnernamen als Datum erkennt */
const DATE_IN_NAME = new RegExp(
  [
    String.raw`(?<!\d)(?:19|20)\d{2}[-_.\s]?\d{2}[-_.\s]?\d{2}(?!\d)`,
    String.raw`(?<!\d)\d{1,2}\.\s?\d{1,2}\.\s?(?:19|20)?\d{2}(?!\d)`,
    String.raw`(?<!\d)\d{1,2}\.?\s*(?:${MONTH_WORDS})\.?\s*(?:19|20)\d{2}(?!\d)`,
  ].join('|'),
  'i',
);

/** Name ohne das Datum darin: "2026-09-27 Erntedank" -> "Erntedank", "2026-09-20" -> "" */
export function withoutDate(name: string): string {
  return name.replace(DATE_IN_NAME, ' ').replace(/^[\s._–-]+|[\s._–-]+$/g, '').replace(/\s{2,}/g, ' ');
}

/** "So., 27.09.2026" für Listen */
export function formatCompactDate(iso: string): string {
  const date = dateOnly(iso);
  // Wochentage selbst, weil die Kurzform je nach Browser mit oder ohne Punkt kommt.
  return `${WEEKDAYS[date.getDay()]}, ${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
}
const WEEKDAYS = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];

/**
 * Anzeigename eines Gottesdienstes oder Albums: bei Datum im Ordnernamen der Anlass ohne Datum,
 * z. B. "Erntedank"; ohne Anlass einfach "Gottesdienst". Das Datum steht dann in der Zeile darunter.
 */
export function albumTitle(title: string, date: string | null | undefined, recording?: string | null): string {
  if (!date) return title;
  return withoutDate(title) || recording || 'Gottesdienst';
}

/** Überschrift über einer Aufnahme (ihre Art); heißt sie selbst schon so, keine (das Datum steht unter dem Titel) */
export const serviceEyebrow = (title: string, recording?: string | null) => {
  const kind = recording || 'Gottesdienst';
  return title === kind ? undefined : kind;
};

/** Zeile unter einem Gottesdienst: das Datum, ohne Sprecher (ein Gottesdienst hat oft mehrere) */
export function serviceLine(date: string): string {
  return formatCompactDate(date);
}

/** Album eines Titels in Listen: "Erntedank, So., 27.09.2026" bzw. nur das Datum */
export function albumLabel(album: string | null, date: string | null | undefined): string | null {
  if (!album || !date) return album;
  const rest = withoutDate(album);
  return rest ? `${rest}, ${formatCompactDate(date)}` : formatCompactDate(date);
}

/** Zeile unter einem Albumtitel: bei Gottesdiensten das Datum, sonst Interpret · Jahr */
export function albumSubtitle(album: { artist: string; year: number | null; date?: string | null }): string {
  if (album.date) return serviceLine(album.date);
  return [album.artist, album.year].filter(Boolean).join(' · ');
}
