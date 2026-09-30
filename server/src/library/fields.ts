/**
 * Felder, die das Regelwerk aus Ordnern und Dateinamen liest und die Kategorien verwenden können
 * (Verwaltung → Kategorien). rebuildAlbums schreibt sie je Titel in track_tags (derived = 1).
 */
export const TRACK_FIELDS = [
  { tag: 'art', label: 'Art', hint: 'laut Zuordnung' },
  { tag: 'inhalt', label: 'Inhalt', hint: 'Anfang des Dateinamens' },
  { tag: 'sprecher', label: 'Sprecher', hint: 'wer predigt' },
  { tag: 'anlass', label: 'Anlass', hint: 'aus dem Ordnernamen' },
  { tag: 'jahr', label: 'Jahr', hint: 'aus dem Datum' },
  { tag: 'bibelstelle', label: 'Bibelstelle', hint: 'aus Titel und Ordnername' },
  { tag: 'ordner', label: 'Ordner', hint: 'Ordner über dem Album' },
] as const;

export type TrackField = (typeof TRACK_FIELDS)[number]['tag'];
export const TRACK_FIELD_TAGS: readonly string[] = TRACK_FIELDS.map((field) => field.tag);

export interface TrackFieldValues {
  kind: string | null;
  content: string | null;
  speaker: string | null;
  occasion: string | null;
  year: string | null;
  /** Bibelstellen des Titels, auch mehrere */
  passages: string[];
  /** Ordner über dem Albumordner ("Audio Aufnahmen", "2026") */
  folders: string[];
}

/** Werte eines Titels als [Feld, Wert], nach Feld und Wert sortiert (wie beim Vergleich in albums.ts); leere fehlen */
export function trackFields(values: TrackFieldValues): Array<[TrackField, string]> {
  const entries: Array<[TrackField, string | null]> = [
    ['anlass', values.occasion],
    ['art', values.kind],
    ['inhalt', values.content],
    ['jahr', values.year],
    ['sprecher', values.speaker],
    ...[...new Set(values.passages)].map((passage): [TrackField, string] => ['bibelstelle', passage]),
    ...[...new Set(values.folders)].map((folder): [TrackField, string] => ['ordner', folder]),
  ];
  return entries
    .filter((entry): entry is [TrackField, string] => Boolean(entry[1]?.trim()))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}
