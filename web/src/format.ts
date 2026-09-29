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

export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('de-DE')} ${count === 1 ? one : many}`;
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
