import { parseBuffer } from 'music-metadata';
import { fileStem, parsePath } from './pathMeta.js';

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
  /** Alle Text-Tags als [Name, Wert], Name klein geschrieben; Grundlage für frei definierbare Kategorien */
  tags: Array<[string, string]>;
  /** Sortier-Tags der Datei (TSOT, TSOP, TSOA, TSO2 bzw. TITLESORT …), falls gesetzt */
  sort: { title?: string; artist?: string; album?: string; albumArtist?: string };
  /** Albumname steht im Tag (sonst aus dem Ordner abgeleitet) */
  albumTagged: boolean;
}

/** Standardfelder, die immer mit den aufbereiteten Werten (inkl. Pfad-Fallback) belegt werden */
const CORE_TAGS = new Set(['title', 'artist', 'albumartist', 'album', 'genre', 'year']);
/** Keine Kategorie-Kandidaten: technische, sehr lange oder je Titel eindeutige Felder */
const SKIPPED_TAGS = new Set([
  'title', 'artists', 'picture', 'track', 'disk', 'lyrics', 'comment', 'description', 'encodedby', 'encodersettings', 'encoder', 'isrc',
  'barcode', 'catalognumber', 'musicbrainz_recordingid', 'musicbrainz_trackid', 'musicbrainz_albumid',
  'musicbrainz_artistid', 'musicbrainz_albumartistid', 'musicbrainz_releasegroupid', 'musicbrainz_workid',
  'musicbrainz_releasetrackid', 'acoustid_id', 'acoustid_fingerprint', 'replaygain_track_gain', 'replaygain_track_peak',
  'replaygain_album_gain', 'replaygain_album_peak', 'compilation', 'gapless', 'bpm', 'titlesort', 'artistsort',
  'albumsort', 'albumartistsort', 'composersort', 'date', 'originaldate', 'releasedate', 'originalyear',
  'tracknumber', 'tracktotal', 'totaltracks', 'discnumber', 'disctotal', 'totaldiscs', 'vendor', 'itunsmpb', 'itunnorm',
  'waveformatextensible', 'notes', 'averagelevel', 'peaklevel', 'podcast', 'podcasturl', 'podcastid', 'podcastkeywords',
]);
const MAX_TAG_VALUE = 200;

/** Eigene Felder, aus denen der Sprecher einer Predigt kommt (Name klein geschrieben) */
export const SPEAKER_TAGS = ['sprecher', 'speaker', 'prediger', 'predigerin', 'referent', 'referentin'];
/** Eigene Felder mit der Bibelstelle einer Predigt */
export const PASSAGE_TAGS = ['bibelstelle', 'bibeltext', 'predigttext', 'scripture', 'passage'];

/**
 * Text für die Suche aus allen Feldern außer denen, die schon in eigenen Spalten stehen
 * (Titel, Interpret, Album, Genre, Jahr): so findet "Meier" auch den Sprecher.
 */
export function searchExtra(tags: Array<[string, string]>): string | null {
  const values = tags.filter(([tag]) => !CORE_TAGS.has(tag)).map(([, value]) => value);
  return values.length ? values.join(' ') : null;
}
const MAX_TAGS = 60;

/** Mehrfachwerte ("Lobpreis; Chor") aufteilen, leere und überlange verwerfen */
function tagValues(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    for (const part of String(item).replace(/\0/g, ';').split(';')) {
      const value = part.trim();
      if (value && value.length <= MAX_TAG_VALUE) out.push(value);
    }
  }
  return out;
}

/**
 * Name eines eigenen Tag-Felds oder undefined für Standardfelder, die schon über `common` kommen.
 * ID3: nur TXXX-Felder; Vorbis/APE: alle Felder; MP4: nur "----:"-Felder.
 */
function customTagName(format: string, id: string): string | undefined {
  let name: string | undefined;
  if (format.startsWith('ID3v2')) name = /^TXXX:(.+)$/i.exec(id)?.[1];
  else if (format === 'vorbis' || format.startsWith('APE')) name = id;
  else if (format === 'iTunes') name = /^----:[^:]*:(.+)$/.exec(id)?.[1];
  name = name?.trim().toLowerCase();
  return name && name.length <= 60 ? name : undefined;
}

/** Sammelt Tags aus den vereinheitlichten Feldern und eigenen Feldern (TXXX, Vorbis, APE, iTunes). */
function collectTags(
  common: Record<string, unknown> | undefined,
  native: Record<string, Array<{ id: string; value: unknown }>> | undefined,
  core: Record<string, string | number | undefined>,
): Array<[string, string]> {
  const seen = new Set<string>();
  const tags: Array<[string, string]> = [];
  const add = (name: string | undefined, values: string[]) => {
    if (!name || SKIPPED_TAGS.has(name)) return;
    for (const value of values) {
      const key = `${name}\u0000${value.toLowerCase()}`;
      if (seen.has(key) || tags.length >= MAX_TAGS) continue;
      seen.add(key);
      tags.push([name, value]);
    }
  };
  for (const [name, value] of Object.entries(core)) add(name, tagValues(value));
  for (const [name, value] of Object.entries(common ?? {})) {
    if (CORE_TAGS.has(name) && name !== 'genre') continue;
    add(name, name === 'genre' ? tagValues(value).map((g) => normalizeGenre(g) ?? '').filter(Boolean) : tagValues(value));
  }
  for (const [format, frames] of Object.entries(native ?? {})) {
    for (const frame of frames) {
      const name = customTagName(format, frame.id);
      if (name && !CORE_TAGS.has(name)) add(name, tagValues(frame.value));
    }
  }
  return tags;
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
  let native: Awaited<ReturnType<typeof parseBuffer>>['native'] | undefined;
  let duration: number | undefined;
  try {
    const parsed = await parseBuffer(head, { mimeType, path }, { duration: false, skipCovers: false });
    common = parsed.common;
    native = parsed.native;
    duration = parsed.format.duration;
  } catch {
    common = undefined;
  }

  const artist = text(common?.artist) ?? text(common?.albumartist) ?? fromPath.artist ?? UNKNOWN_ARTIST;
  const title = text(common?.title) ?? fromPath.title;
  const albumArtist = text(common?.albumartist);
  const album = text(common?.album) ?? fromPath.album;
  const year = validYear(common?.year) ?? fromPath.year;
  const genre = normalizeGenre(common?.genre?.[0]);
  const tags = collectTags(
    common as unknown as Record<string, unknown>,
    native as Record<string, Array<{ id: string; value: unknown }>>,
    { artist, albumartist: albumArtist, album, year, filename: fileStem(path) },
  );
  // Sprecher aus dem Dateinamen ("2026-09-27 Meier - Psalm 23.mp3"), wenn kein Tag-Feld ihn nennt;
  // so erscheint er auch in der Suche und in der Kategorie "Sprecher".
  if (fromPath.speaker && !tags.some(([tag]) => SPEAKER_TAGS.includes(tag))) tags.push(['sprecher', fromPath.speaker]);
  return {
    title,
    artist,
    albumArtist,
    album,
    trackNo: common?.track?.no ?? fromPath.trackNo,
    discNo: common?.disk?.no ?? fromPath.discNo,
    year,
    genre,
    tags,
    albumTagged: text(common?.album) !== undefined,
    sort: {
      title: text(common?.titlesort),
      artist: text(common?.artistsort),
      album: text(common?.albumsort),
      albumArtist: text(common?.albumartistsort),
    },
    duration: duration && Number.isFinite(duration) ? Math.round(duration * 10) / 10 : undefined,
    compilation: common?.compilation === true,
    picture: pickPicture(common?.picture),
  };
}
