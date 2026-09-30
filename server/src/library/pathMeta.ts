import { findDate, isYearOnly, yearIn } from './dateText.js';

/**
 * Leitet Metadaten aus der Ordnerstruktur ab. Das ist der Fallback für Dateien
 * ohne (vollständige) Tags und folgt den üblichen Konventionen:
 *   Interpret/Album/01 - Titel.mp3
 *   Interpret/Album (1999)/CD 2/03 Titel.flac
 *   Interpret - Album/Interpret - Titel.mp3
 */
export interface PathMeta {
  title: string;
  artist?: string;
  album?: string;
  trackNo?: number;
  discNo?: number;
  year?: number;
  /** Ordner, der das Album repräsentiert (Disc-Unterordner zusammengefasst) */
  albumFolder: string;
  /** Datum im Dateinamen ("2026-09-27 Meier - Psalm 23.mp3"), JJJJ-MM-TT */
  date?: string;
  /** Sprecher bei Aufnahmen mit Datum: der Name vor " - " im Dateinamen */
  speaker?: string;
}

export const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'aiff', 'aif']);
export const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

const DISC_FOLDER = /^(?:cd|disc|disk|dvd|seite|side)[\s._-]*(\d{1,2})$/i;
const YEAR_SUFFIX = /^(.*?)[\s._-]*[([]((?:19|20)\d{2})[)\]]$/;
// Nicht bei einem Datum wie "2026-09-27 Erntedank": das bleibt als Ganzes der Albumname.
const YEAR_PREFIX = /^((?:19|20)\d{2})[\s._-]+(?!\d)(.+)$/;

export function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isAudioFile(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extension(path));
}

/** Rang eines Bildes als Cover: kleiner ist besser, undefined heißt kein Cover-Kandidat. */
export function coverRank(path: string): number | undefined {
  if (!IMAGE_EXTENSIONS.has(extension(path))) return undefined;
  const stem = basename(path).replace(/\.[^.]+$/, '').toLowerCase();
  const index = COVER_NAMES.indexOf(stem);
  return index >= 0 ? index : COVER_NAMES.length;
}

export function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? '';
}

/** Dateiname ohne Endung: "Predigten/02 Psalm 23.mp3" -> "02 Psalm 23" */
export function fileStem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '');
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : '';
}

/** Nächstes Jahr in einem Ordner oder darüber ("Predigten/2025/…"), für Daten ohne Jahr wie "1.10." */
export function folderYear(dir: string): number | undefined {
  for (let current = dir; current; current = dirname(current)) {
    const year = yearIn(basename(current));
    if (year) return year;
  }
  return undefined;
}

/** Datum im Namen eines Ordners; fehlt dort das Jahr, gilt das eines übergeordneten Ordners. */
export function folderDate(folder: string): string | undefined {
  return folder ? findDate(basename(folder), folderYear(dirname(folder)))?.date : undefined;
}

/** Datum einer Aufnahme: aus dem Albumordner, sonst aus dem Dateinamen */
export function dateOfPath(path: string): string | undefined {
  return folderDate(albumFolderOf(path)) ?? findDate(fileStem(path), folderYear(dirname(path)))?.date;
}

/**
 * Ordner, dessen Inhalt als ein Album gilt: Disc-Unterordner zählen zum Elternordner, ebenso
 * Unterordner eines Gottesdienstes ("2026-09-27/Predigt", "2026-09-27/Lobpreis"), solange sie
 * selbst kein Datum und kein Jahr im Namen tragen.
 */
export function albumFolderOf(path: string): string {
  let dir = dirname(path);
  if (DISC_FOLDER.test(basename(dir))) dir = dirname(dir);
  const parent = dirname(dir);
  if (parent && !findDate(basename(dir)) && !yearIn(basename(dir)) && folderDate(parent)) return parent;
  return dir;
}

function clean(value: string): string {
  return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitYear(name: string): { name: string; year?: number } {
  const suffix = YEAR_SUFFIX.exec(name);
  if (suffix?.[1]) return { name: clean(suffix[1]), year: Number(suffix[2]) };
  const prefix = YEAR_PREFIX.exec(name);
  if (prefix?.[2]) return { name: clean(prefix[2]), year: Number(prefix[1]) };
  return { name: clean(name) };
}

export function parsePath(path: string): PathMeta {
  const dir = dirname(path);
  const albumFolder = albumFolderOf(path);
  const result: PathMeta = { title: '', albumFolder };
  const datedFolder = folderDate(albumFolder) !== undefined;

  const discMatch = DISC_FOLDER.exec(basename(dir));
  if (discMatch) result.discNo = Number(discMatch[1]);

  // Dateiname: [Datum] [Disc-]Track, optional "Interpret - ", Titel
  let stem = clean(basename(path).replace(/\.[^.]+$/, ''));
  const dated = findDate(stem, folderYear(dir));
  if (dated) {
    const rest = clean(`${stem.slice(0, dated.index)} ${stem.slice(dated.index + dated.length)}`).replace(/^[\s._–-]+|[\s._–-]+$/g, '');
    result.date = dated.date;
    stem = rest || stem;
  }
  const numbered = /^(?:(\d{1,2})[-.])?(\d{1,3})(?:\s*[-.]\s*|\s+)(.+)$/.exec(stem);
  if (numbered?.[3]) {
    if (numbered[1]) result.discNo = Number(numbered[1]);
    result.trackNo = Number(numbered[2]);
    stem = numbered[3];
  }
  // In einem Ordner mit Datum (Gottesdienst) steht vor dem Bindestrich meist der Inhalt ("Lied - …",
  // "Predigt - …"), kein Interpret; das liest das Regelwerk der Verwaltung (structure.ts). Bei einem Datum im
  // Dateinamen selbst ("2026-09-27 Meier - Psalm 23") steht davor, wer predigt.
  const dash = datedFolder && !result.date ? -1 : stem.indexOf(' - ');
  if (dash > 0) {
    result.artist = clean(stem.slice(0, dash));
    stem = stem.slice(dash + 3);
    if (result.date) result.speaker = result.artist;
  }
  result.title = clean(stem) || basename(path);

  // Ordner: Interpret/Album oder "Interpret - Album"
  const segments = albumFolder.split('/').filter(Boolean);
  const albumSegment = segments[segments.length - 1];
  const artistSegment = segments[segments.length - 2];
  if (albumSegment) {
    let albumName = albumSegment;
    const folderDash = albumName.indexOf(' - ');
    // "2026-09-27 - Erntedank" ist Datum und Anlass, kein Interpret
    if (folderDash > 0 && !YEAR_PREFIX.test(albumName) && !findDate(albumName.slice(0, folderDash))) {
      result.artist ??= clean(albumName.slice(0, folderDash));
      albumName = albumName.slice(folderDash + 3);
    }
    const { name, year } = splitYear(albumName);
    result.album = name;
    if (year) result.year = year;
    // Der Ordner über einem Gottesdienst ("Gottesdienste", "2026") ist eine Sammlung, kein Interpret.
    if (artistSegment && !datedFolder && !isYearOnly(artistSegment) && !findDate(artistSegment)) {
      result.artist ??= clean(artistSegment);
    }
  }
  return result;
}
