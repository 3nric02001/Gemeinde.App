import { parseBuffer, type IAudioMetadata } from 'music-metadata';
import { parsePath } from './pathMeta.js';

/**
 * Was die App aus einer Audiodatei liest. Tags (Titel, Album, Interpret, Genre …) zählen nicht: Titel, Album,
 * Nummer und Jahr kommen aus Ordner und Dateiname, aus der Datei selbst nur Dauer und eingebettetes Bild.
 */
export interface TrackMeta {
  title: string;
  album: string | undefined;
  trackNo: number | undefined;
  discNo: number | undefined;
  year: number | undefined;
  duration: number | undefined;
  /** Eingebettetes Cover, falls vorhanden */
  picture: Picture | undefined;
}

/** Titelname und Sprecher aus der Verwaltung und dem Dateinamen sollen in der Suche zählen. */
export function searchText(values: Array<string | null | undefined>): string | null {
  const added = values.filter(Boolean).join(' ');
  return added || null;
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

/** Bildformate, die als Cover ausgeliefert werden dürfen. */
export const COVER_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function pickPicture(pictures: Array<{ data: Uint8Array; format: string; type?: string }> | undefined): Picture | undefined {
  if (!pictures?.length) return undefined;
  const front = pictures.find((p) => /front/i.test(p.type ?? '')) ?? pictures[0]!;
  const raw = (front.format.includes('/') ? front.format : `image/${front.format || 'jpeg'}`).trim().toLowerCase();
  const mime = raw === 'image/jpg' ? 'image/jpeg' : raw;
  // Nur echte Rasterbilder: Ein SVG oder HTML im Tag liefe sonst als Skript auf der Seite der App.
  if (!COVER_MIME_TYPES.includes(mime) || front.data.byteLength === 0 || front.data.byteLength > MAX_PICTURE_BYTES) return undefined;
  return { data: Buffer.from(front.data), mime };
}

/**
 * Dauer der ganzen Datei, auch wenn nur ihr Anfang gelesen wurde. music-metadata kennt dann nur den Ausschnitt:
 * Bei MP3 mit fester Bitrate ohne Xing/Info-Header schätzt es aus dessen Länge, bei Ogg zählt es bis zur
 * letzten Seite darin. Beides ergäbe wenige Sekunden je Titel, also rechnen wir auf die ganze Datei hoch.
 */
function fullDuration(format: IAudioMetadata['format'], head: Buffer, size: number | undefined): number | undefined {
  const { duration } = format;
  if (!duration || !size || size <= head.length) return duration;
  if (format.container === 'MPEG' && format.codecProfile === 'CBR' && format.numberOfSamples && format.sampleRate) {
    // Aus einem Xing/Info-Header stammt die Dauer schon für die ganze Datei; nur die Schätzung aus dem Ausschnitt hochrechnen.
    if (Math.abs(duration - format.numberOfSamples / format.sampleRate) > 0.5) return duration;
    const start = Math.min(tagSpan(head) ?? 0, head.length - 1);
    return (duration * (size - start)) / (head.length - start);
  }
  if (format.container === 'Ogg') return format.bitrate ? (size * 8) / format.bitrate : undefined;
  return duration;
}

/**
 * Liest Dauer und eingebettetes Bild aus dem Dateianfang; alles Übrige kommt aus dem Pfad.
 * Scheitert das Parsen (z. B. MP4 mit Metadaten am Dateiende), fehlen nur Dauer und Bild.
 * `size` ist die ganze Dateigröße: Ist `head` nur der Anfang, rechnet die Dauer damit statt mit dem Ausschnitt.
 */
export async function extractMetadata(path: string, head: Buffer, mimeType?: string, size?: number): Promise<TrackMeta> {
  const fromPath = parsePath(path);
  let picture: Picture | undefined;
  let duration: number | undefined;
  try {
    const parsed = await parseBuffer(head, { mimeType, path }, { duration: false, skipCovers: false });
    picture = pickPicture(parsed.common.picture);
    duration = fullDuration(parsed.format, head, size);
  } catch {
    // Ohne lesbaren Kopf bleibt es beim Pfad
  }
  return {
    title: fromPath.title,
    album: fromPath.album,
    trackNo: fromPath.trackNo,
    discNo: fromPath.discNo,
    year: fromPath.year,
    duration: duration && Number.isFinite(duration) ? Math.round(duration * 10) / 10 : undefined,
    picture,
  };
}
