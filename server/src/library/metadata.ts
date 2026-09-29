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
  /** Eingebettetes Cover, falls vorhanden */
  picture: Picture | undefined;
}

export interface Picture {
  data: Buffer;
  mime: string;
}

/** Größere eingebettete Bilder ignorieren wir, damit die Datenbank schlank bleibt. */
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

/**
 * Wie viele Bytes vom Dateianfang nötig sind, um alle Tags samt eingebettetem Cover zu lesen.
 * Kennt ID3v2 (MP3) und FLAC; für andere Formate `undefined`. Reicht der Puffer nicht einmal
 * bis zum nächsten FLAC-Blockkopf, kommt eine Schätzung, die mindestens diesen Kopf enthält.
 */
export function tagSpan(head: Buffer): number | undefined {
  if (head.length >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
    const size = ((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f);
    const footer = head[5]! & 0x10 ? 10 : 0;
    return 10 + size + footer;
  }
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'fLaC') {
    let offset = 4;
    while (offset + 4 <= head.length) {
      const last = (head[offset]! & 0x80) !== 0;
      const length = (head[offset + 1]! << 16) | (head[offset + 2]! << 8) | head[offset + 3]!;
      offset += 4 + length;
      if (last) return offset;
    }
    return offset + 4 + 64 * 1024;
  }
  return undefined;
}

function pickPicture(pictures: Array<{ data: Uint8Array; format: string; type?: string }> | undefined): Picture | undefined {
  if (!pictures?.length) return undefined;
  const front = pictures.find((p) => /front/i.test(p.type ?? '')) ?? pictures[0]!;
  const mime = front.format.includes('/') ? front.format : `image/${front.format.toLowerCase() || 'jpeg'}`;
  if (!mime.startsWith('image/') || front.data.byteLength === 0 || front.data.byteLength > MAX_PICTURE_BYTES) return undefined;
  return { data: Buffer.from(front.data), mime: mime === 'image/jpg' ? 'image/jpeg' : mime };
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
    const parsed = await parseBuffer(head, { mimeType, path }, { duration: false, skipCovers: false });
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
    picture: pickPicture(common?.picture),
  };
}
