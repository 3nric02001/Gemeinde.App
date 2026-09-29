import { parseBuffer } from 'music-metadata';
import { parsePath } from './pathMeta.js';

export interface TrackMeta {
  title: string;
  artist: string;
  albumArtist: string | undefined;
  album: string | undefined;
  trackNo: number | undefined;
  discNo: number | undefined;
  year: number | undefined;
  genre: string | undefined;
  duration: number | undefined;
  compilation: boolean;
}

export const UNKNOWN_ARTIST = 'Unbekannter Interpret';

function text(value: string | undefined | null): string | undefined {
  const trimmed = value?.replace(/\0/g, '').trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Genres kommen in vielen Formen: "Rock; Pop", "Rock/Pop", ID3v1-Nummern wie "(17)".
 * Wir behalten das erste echte Genre in normalisierter Schreibweise.
 */
export function normalizeGenre(raw: string | undefined): string | undefined {
  const first = text(raw)
    ?.replace(/^\(\d+\)/, '')
    .split(/[;,/|]|\s{2,}/)[0]
    ?.trim();
  if (!first || /^\d+$/.test(first)) return undefined;
  return first
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase());
}

function validYear(year: number | undefined): number | undefined {
  return year && year >= 1000 && year <= 2999 ? year : undefined;
}

/**
 * Liest Tags aus dem Dateianfang und ergänzt Fehlendes aus dem Pfad.
 * Scheitert das Parsen (z. B. MP4 mit Metadaten am Dateiende), bleibt der Pfad-Fallback.
 */
export async function extractMetadata(path: string, head: Buffer, mimeType?: string): Promise<TrackMeta> {
  const fromPath = parsePath(path);
  let common: Awaited<ReturnType<typeof parseBuffer>>['common'] | undefined;
  let duration: number | undefined;
  try {
    const parsed = await parseBuffer(head, { mimeType, path }, { duration: false, skipCovers: true });
    common = parsed.common;
    duration = parsed.format.duration;
  } catch {
    common = undefined;
  }

  const artist = text(common?.artist) ?? text(common?.albumartist) ?? fromPath.artist ?? UNKNOWN_ARTIST;
  return {
    title: text(common?.title) ?? fromPath.title,
    artist,
    albumArtist: text(common?.albumartist),
    album: text(common?.album) ?? fromPath.album,
    trackNo: common?.track?.no ?? fromPath.trackNo,
    discNo: common?.disk?.no ?? fromPath.discNo,
    year: validYear(common?.year) ?? fromPath.year,
    genre: normalizeGenre(common?.genre?.[0]),
    duration: duration && Number.isFinite(duration) ? Math.round(duration * 10) / 10 : undefined,
    compilation: common?.compilation === true,
  };
}
