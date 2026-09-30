import { getMeta, setMeta, type DB } from '../db.js';
import { findPassage } from './bible.js';
import { findDate } from './dateText.js';
import { albumFolderOf, basename, dirname, fileStem, folderDate, folderYear } from './pathMeta.js';
import { foldValue } from './text.js';

/**
 * Regelwerk für Aufnahmen (Gottesdienste, Bibelstunden …), in der Verwaltung einstellbar:
 * woran eine Art zu erkennen ist und wie Ordner- und Dateinamen zu lesen sind. Beispiel:
 *
 *   Audio Aufnahmen/2026/2026_08_30_Einschulung/Predigt - Der gute Hirte.mp3
 *     Ordner "{datum}_{anlass}"       -> Datum 2026-08-30, Anlass "Einschulung"
 *     Datei  "{inhalt} - {titel}"     -> Inhalt "Predigt", Titel "Der gute Hirte"
 *
 *   Audio Aufnahmen/2026/Bibelstunden/2026_01_14_Matthäus 9, 27-38/2026_01_14_001.mp3
 *     Art "Bibelstunde" (Pfad enthält den Ordner "Bibelstunden")
 *     Ordner "{datum}_{bibelstelle}"  -> Bibelstelle "Matthäus 9, 27-38"
 *     Datei  "{datum}_{nr}"           -> Teil 1
 *
 * Trennzeichen in Mustern sind austauschbar: " - ", "_", "." und Leerzeichen passen aufeinander.
 */

export const PLACEHOLDERS = ['datum', 'anlass', 'bibelstelle', 'sprecher', 'inhalt', 'titel', 'nr'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface RecordingKind {
  /** "Gottesdienst", "Bibelstunde" */
  name: string;
  /** Mehrzahl für Überschriften und Filter: "Gottesdienste" */
  plural: string;
  /** Ordnername irgendwo im Pfad, an dem die Art zu erkennen ist; leer: alle übrigen Ordner mit Datum */
  folder: string;
  /** Muster für den Namen des Aufnahme-Ordners */
  folderPattern: string;
  /** Muster für Dateinamen (ohne Endung) */
  filePattern: string;
  /** Vorlage für den Namen des Albums; leer oder ohne Wert: der Name der Art */
  albumTitle: string;
  /** Vorlage für den Titel einer Aufnahme */
  trackTitle: string;
  /** Inhalt, dessen Titel Sprecher und Bibelstelle liefert ("Predigt"); leer: alle Titel */
  sermon: string;
  /** Titel aus den Tags der Datei behalten, wenn es welche gibt */
  preferTags: boolean;
}

export interface Structure {
  kinds: RecordingKind[];
  /** Bekannte Inhalte am Anfang von Dateinamen ("Lied", "Predigt" …); auch mehrere Wörter möglich */
  contents: string[];
  /**
   * Inhalte ohne eigenen Titel: Folgt nur ein Teil ("Begrüßung - Jakob Rauschenberger"), ist das der Name
   * ({sprecher}), nicht der Titel.
   */
  untitled: string[];
}

export const DEFAULT_STRUCTURE: Structure = {
  kinds: [
    {
      name: 'Bibelstunde',
      plural: 'Bibelstunden',
      folder: 'Bibelstunden',
      folderPattern: '{datum}_{bibelstelle}',
      filePattern: '{datum}_{nr}',
      albumTitle: '{bibelstelle}',
      trackTitle: 'Teil {nr}',
      sermon: '',
      preferTags: false,
    },
    {
      name: 'Gottesdienst',
      plural: 'Gottesdienste',
      folder: '',
      folderPattern: '{datum}_{anlass}',
      filePattern: '{inhalt} - {titel} - {sprecher}',
      albumTitle: '{anlass}',
      trackTitle: '{inhalt}: {titel}',
      sermon: 'Predigt',
      preferTags: false,
    },
  ],
  contents: [
    'Lied', 'Predigt', 'Lesung', 'Schriftlesung', 'Gebet', 'Begrüßung', 'Abkündigungen', 'Segen', 'Musik', 'Vorspiel',
    'Nachspiel', 'Chor', 'Zeugnis', 'Kinderpredigt', 'Taufe', 'Abendmahl', 'Grußwort', 'Bericht', 'Einleitung', 'Beitrag',
    'Gedicht', 'Ansage', 'Schlusswort',
  ],
  untitled: ['Begrüßung', 'Abkündigungen', 'Gebet', 'Segen', 'Grußwort', 'Ansage', 'Schlusswort', 'Bericht', 'Zeugnis'],
};

const META_KEY = 'structure';
export const MAX_KINDS = 10;
const MAX_TEXT = 200;
const MAX_CONTENTS = 100;

export class StructureError extends Error {}

const text = (value: unknown, field: string, max = MAX_TEXT): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new StructureError(`${field}: Text erwartet`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new StructureError(`${field} ist zu lang`);
  return trimmed;
};

function checkPattern(pattern: string, field: string): void {
  const seen = new Set<string>();
  for (const match of pattern.matchAll(/\{([^}]*)\}/g)) {
    const name = match[1]!.trim().toLowerCase();
    if (!PLACEHOLDERS.includes(name as Placeholder)) {
      throw new StructureError(`${field}: Unbekannter Platzhalter {${match[1]}}. Möglich: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`);
    }
    if (seen.has(name)) throw new StructureError(`${field}: {${name}} kommt doppelt vor`);
    seen.add(name);
  }
}

/** Prüft ein Regelwerk aus der Verwaltung und bringt es in Normalform. Wirft mit verständlicher Meldung. */
export function parseStructure(input: unknown): Structure {
  if (!input || typeof input !== 'object') throw new StructureError('Ungültiges Regelwerk');
  const body = input as { kinds?: unknown; contents?: unknown };
  if (!Array.isArray(body.kinds) || body.kinds.length === 0) throw new StructureError('Mindestens eine Art ist nötig');
  if (body.kinds.length > MAX_KINDS) throw new StructureError(`Höchstens ${MAX_KINDS} Arten`);
  const names = new Set<string>();
  const kinds = body.kinds.map((raw, index): RecordingKind => {
    if (!raw || typeof raw !== 'object') throw new StructureError('Ungültige Art');
    const k = raw as Record<string, unknown>;
    const name = text(k.name, 'Name', 60);
    if (!name) throw new StructureError(`Art ${index + 1} braucht einen Namen`);
    if (names.has(foldValue(name))) throw new StructureError(`„${name}“ gibt es doppelt`);
    names.add(foldValue(name));
    const kind: RecordingKind = {
      name,
      plural: text(k.plural, 'Mehrzahl', 60) || name,
      folder: text(k.folder, 'Ordner', 100),
      folderPattern: text(k.folderPattern, 'Muster für Ordner'),
      filePattern: text(k.filePattern, 'Muster für Dateien'),
      albumTitle: text(k.albumTitle, 'Name des Albums'),
      trackTitle: text(k.trackTitle, 'Titel einer Aufnahme'),
      sermon: text(k.sermon, 'Inhalt der Predigt', 60),
      preferTags: k.preferTags === true,
    };
    checkPattern(kind.folderPattern, `${name}, Ordner`);
    checkPattern(kind.filePattern, `${name}, Dateien`);
    checkPattern(kind.albumTitle, `${name}, Name des Albums`);
    checkPattern(kind.trackTitle, `${name}, Titel`);
    return kind;
  });
  const list = (value: unknown, label: string) => {
    const items = Array.isArray(value) ? value.map((c) => text(c, label, 60)).filter(Boolean) : [];
    if (items.length > MAX_CONTENTS) throw new StructureError(`Höchstens ${MAX_CONTENTS} Einträge in „${label}“`);
    return [...new Map(items.map((c) => [foldValue(c), c])).values()];
  };
  const untitled = list((body as { untitled?: unknown }).untitled, 'Inhalte ohne Titel');
  // Inhalte ohne Titel sind auch Inhalte
  const contents = list([...(Array.isArray(body.contents) ? body.contents : []), ...untitled], 'Inhalte');
  return { kinds, contents, untitled };
}

export function getStructure(db: DB): Structure {
  const stored = getMeta(db, META_KEY);
  if (!stored) return DEFAULT_STRUCTURE;
  try {
    const raw = JSON.parse(stored) as Record<string, unknown>;
    // Gespeichert, bevor es "Inhalte ohne Titel" gab: Vorgabe übernehmen
    if (!('untitled' in raw)) raw.untitled = DEFAULT_STRUCTURE.untitled;
    return parseStructure(raw);
  } catch {
    return DEFAULT_STRUCTURE;
  }
}

export function saveStructure(db: DB, structure: Structure): void {
  setMeta(db, META_KEY, JSON.stringify(structure));
}

// ---------- Muster ----------

// Trennzeichen: Leerzeichen, _ - – . und : ("Predigt: Dankbarkeit")
const SEP_CHARS = String.raw`\s_\-–.:`;
const SEP = `[${SEP_CHARS}]+`;
/** Zwischen zwei freien Textfeldern genügt kein Leerzeichen: "Der gute Hirte" ist ein Titel, kein Sprecher + Titel. */
const STRICT_SEP = String.raw`\s*[_\-–.:]+\s*`;
/** Platzhalter, deren Ende eindeutig ist; neben ihnen passt jedes Trennzeichen, auch ein Leerzeichen */
const BOUNDED = new Set<Placeholder>(['datum', 'nr', 'inhalt']);
const DATE = String.raw`(?:(?:19|20)\d{2}[-_.\s]?\d{2}[-_.\s]?\d{2}|\d{1,2}\.\s?\d{1,2}\.(?:\s?(?:19|20)?\d{2})?)`;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Text zwischen Platzhaltern: Trennzeichen passen auf jedes andere Trennzeichen, der Rest genau.
 * `strict`: ein Trenner aus "-", "_" oder "." verlangt auch eines davon (nicht nur ein Leerzeichen).
 */
function literal(value: string, strict = false): string {
  return value
    .split(new RegExp(`([${SEP_CHARS}]+)`))
    .filter(Boolean)
    .map((part) => {
      if (!new RegExp(`^[${SEP_CHARS}]+$`).test(part)) return escape(part);
      return strict && /[_\-–.:]/.test(part) ? STRICT_SEP : SEP;
    })
    .join('');
}

/**
 * Wie literal(), aber für Dateinamen, die " - " als Trenner verwenden: Dann trennt nur ein Bindestrich mit
 * Leerzeichen, und "Text_Richter 7,1-4" oder "Matthäus 7,7-14" bleiben ein Teil.
 */
function dashLiteral(value: string): string {
  return value
    .split(new RegExp(`([${SEP_CHARS}]+)`))
    .filter(Boolean)
    .map((part) => {
      if (!new RegExp(`^[${SEP_CHARS}]+$`).test(part)) return escape(part);
      return /[_\-–.:]/.test(part) ? String.raw`\s+[-–]\s+` : String.raw`\s+`;
    })
    .join('');
}

/** "01 - Lied - …", "Predigt - …": Der Name verwendet " - " als Trenner. */
const usesDash = (name: string) => /\s[-–]\s/.test(name);

export interface CompiledPattern {
  regex: RegExp;
  placeholders: Placeholder[];
}

/**
 * Übersetzt ein Muster wie "{inhalt} - {titel}" in einen regulären Ausdruck. Alles nach dem ersten
 * Platzhalter ist optional, damit "{datum}_{anlass}" auch auf einen Ordner ohne Anlass passt.
 * Dateimuster, die nicht mit einer Nummer oder einem Datum beginnen, dürfen eine Tracknummer voranstellen.
 */
export function compilePattern(
  pattern: string,
  contents: string[] = [],
  options: { leadingNumber?: boolean; dashOnly?: boolean } = {},
): CompiledPattern | undefined {
  const parts = pattern.split(/(\{[^}]*\})/).filter((part) => part !== '');
  const placeholders: Placeholder[] = [];
  const known = [...contents].sort((a, b) => b.length - a.length).map((c) => literal(c)).join('|');
  let source = '';
  let pendingLiteral = '';
  for (const part of parts) {
    const name = /^\{([^}]*)\}$/.exec(part)?.[1]?.trim().toLowerCase() as Placeholder | undefined;
    if (!name) {
      pendingLiteral += part;
      continue;
    }
    const body =
      name === 'datum'
        ? DATE
        : name === 'nr'
          ? String.raw`\d{1,4}`
          : name === 'inhalt'
            ? `(?:${known ? `${known}|` : ''}[^${SEP_CHARS}\\d][^${SEP_CHARS}]*)`
            : '.+?';
    const group = `(?<${name}>${body})`;
    const previous = placeholders[placeholders.length - 1];
    const strict = previous !== undefined && !BOUNDED.has(previous) && !BOUNDED.has(name);
    const sep = (value: string) => (options.dashOnly ? dashLiteral(value) : literal(value, strict));
    if (!placeholders.length) source += `${sep(pendingLiteral)}${group}`;
    else source += `(?:${sep(pendingLiteral)}${group})?`;
    placeholders.push(name);
    pendingLiteral = '';
  }
  if (!placeholders.length) return undefined;
  source += pendingLiteral ? `(?:${options.dashOnly ? dashLiteral(pendingLiteral) : literal(pendingLiteral)})?` : '';
  const lead = options.leadingNumber && placeholders[0] !== 'nr' && placeholders[0] !== 'datum' ? `(?:(?<lead>\\d{1,3})${SEP})?` : '';
  return { regex: new RegExp(`^${lead}${source}[${SEP_CHARS}]*$`, 'iu'), placeholders };
}

export type Values = Partial<Record<Placeholder | 'lead', string>>;

export function matchPattern(compiled: CompiledPattern | undefined, name: string): Values | undefined {
  if (!compiled) return undefined;
  const match = compiled.regex.exec(name.normalize('NFC'));
  if (!match?.groups) return undefined;
  const values: Values = {};
  for (const [key, value] of Object.entries(match.groups)) {
    const trimmed = value?.replace(/^[\s_–-]+|[\s_–-]+$/g, '').trim();
    if (trimmed) values[key as Placeholder] = trimmed;
  }
  return values;
}

/** Füllt eine Vorlage; leere Platzhalter verschwinden samt übrig gebliebener Trenner ("Predigt: " -> "Predigt"). */
export function fillTemplate(template: string, values: Values): string {
  return template
    .replace(/\{([^}]*)\}/g, (_, name: string) => values[name.trim().toLowerCase() as Placeholder] ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([:,])/g, '$1')
    .replace(/^[\s:,·–-]+|[\s:,·–-]+$/g, '')
    .replace(/([:,])\s*(?=[:,])/g, '')
    .trim();
}

// ---------- Anwenden ----------

export interface CompiledKind {
  kind: RecordingKind;
  folderKey: string;
  folder?: CompiledPattern;
  file?: CompiledPattern;
  /** Dasselbe Dateimuster für Namen mit " - " als Trenner */
  fileDash?: CompiledPattern;
  /** Inhalte ohne Titel, als Vergleichsschlüssel */
  untitled: Set<string>;
}

export interface CompiledStructure {
  structure: Structure;
  kinds: CompiledKind[];
}

export function compileStructure(structure: Structure): CompiledStructure {
  return {
    structure,
    kinds: structure.kinds.map((kind) => ({
      kind,
      folderKey: foldValue(kind.folder),
      folder: compilePattern(kind.folderPattern),
      file: compilePattern(kind.filePattern, structure.contents, { leadingNumber: true }),
      fileDash: compilePattern(kind.filePattern, structure.contents, { leadingNumber: true, dashOnly: true }),
      untitled: new Set(structure.untitled.map(foldValue)),
    })),
  };
}

/** Art eines Albumordners mit Datum: die erste, deren Ordner im Pfad vorkommt, sonst die erste ohne Ordner. */
export function kindOfFolder(compiled: CompiledStructure, folder: string): CompiledKind | undefined {
  if (!folder || !folderDate(folder)) return undefined;
  const segments = folder.split('/').map(foldValue);
  return (
    compiled.kinds.find((k) => k.folderKey && segments.includes(k.folderKey)) ?? compiled.kinds.find((k) => !k.folderKey)
  );
}

export interface FileInfo {
  path: string;
  /** Titel aus Tag oder Pfad, wie gescannt */
  title: string;
  /** Titel steht in einem Tag (nicht aus dem Dateinamen abgeleitet) */
  titleTagged: boolean;
  duration: number | null;
}

export interface FileResult {
  /** Titel nach der Vorlage, undefined: gescannten Titel behalten */
  title?: string;
  content?: string;
  /** Sprecher, nur bei der Predigt (für Album und Kategorie "Sprecher") */
  speaker?: string;
  /** Name aus {sprecher} bei jeder Aufnahme: bei der Predigt der Prediger, bei einem Lied z. B. der Chor */
  performer?: string;
  /** Bibelstelle aus {bibelstelle} im Dateinamen */
  passage?: string;
  nr?: number;
  matched: boolean;
}

export interface FolderResult {
  kind: RecordingKind;
  /** Name des Albums nach der Vorlage (leer: keiner) */
  title: string;
  passage?: string;
  speaker?: string;
  files: Map<string, FileResult>;
}

/**
 * Wendet das Regelwerk auf einen Albumordner an. Ordner- und Dateiwerte werden gemeinsam verwendet:
 * Eine Vorlage für Titel kann {bibelstelle} aus dem Ordner und {nr} aus der Datei nutzen.
 */
export function applyToFolder(compiled: CompiledKind, folder: string, files: FileInfo[]): FolderResult {
  const { kind } = compiled;
  const folderValues = matchPattern(compiled.folder, basename(folder)) ?? {};
  if (folderValues.anlass) folderValues.anlass = tidy(folderValues.anlass);
  const results = new Map<string, FileResult>();
  const sermonKey = foldValue(kind.sermon);
  // Sprecher nur von der Predigt; "Lied - Befiehl du deine Wege" nennt keinen Sprecher
  const isSermon = (values: Values | undefined) => !sermonKey || (values?.inhalt !== undefined && foldValue(values.inhalt) === sermonKey);
  const parsed = files.map((file) => {
    const values = readFileName(compiled, fileStem(file.path));
    const nr = values?.nr ?? values?.lead;
    return { file, values, nr: nr !== undefined ? Number(nr) : undefined };
  });
  for (const { file, values, nr } of parsed) {
    if (!values) {
      results.set(file.path, { matched: false });
      continue;
    }
    const all: Values = { ...folderValues, ...values, nr: nr !== undefined ? String(nr) : undefined };
    if (all.datum) all.datum = findDate(all.datum, folderYear(dirname(file.path)))?.date ?? all.datum;
    const title = kind.preferTags && file.titleTagged ? undefined : fillTemplate(kind.trackTitle || '{titel}', all) || undefined;
    results.set(file.path, {
      matched: true,
      title,
      content: values.inhalt,
      speaker: isSermon(values) ? values.sprecher : undefined,
      performer: values.sprecher,
      passage: values.bibelstelle,
      nr,
    });
  }

  // Predigt: der Titel mit dem eingestellten Inhalt, sonst der längste
  const sermons = parsed
    .filter(({ values }) => isSermon(values))
    .sort((a, b) => (b.file.duration ?? 0) - (a.file.duration ?? 0));
  const speaker =
    folderValues.sprecher ?? sermons.map(({ values }) => values?.sprecher).find(Boolean) ?? undefined;
  const passage =
    folderValues.bibelstelle ??
    sermons.map(({ values }) => values?.bibelstelle).find(Boolean) ??
    [...sermons.map(({ values, file }) => values?.titel ?? file.title), basename(folder)].map((t) => findPassage(t)).find(Boolean);

  return {
    kind,
    title: fillTemplate(kind.albumTitle, { ...folderValues, sprecher: speaker }),
    passage: passage ?? undefined,
    speaker: speaker ?? undefined,
    files: results,
  };
}

/**
 * Lesbarer Titel aus einem Teil des Dateinamens: "Text_Richter 7,1-4" -> "Richter 7,1-4",
 * "Bergpredigt Text_Matthäus 7,7-14" -> "Bergpredigt (Matthäus 7,7-14)"; übrige Unterstriche werden Leerzeichen.
 */
export function tidy(value: string): string {
  return value
    .replace(/^\s*(?:Text|Predigttext|Bibeltext)_\s*/i, '')
    .replace(/^(.+?)\s+(?:Text|Predigttext|Bibeltext)_\s*(.+)$/i, '$1 ($2)')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Liest einen Dateinamen nach dem Muster der Art. Verwendet der Name " - " als Trenner, wird nur dort getrennt.
 * Bei Inhalten ohne Titel ist ein einzelner Teil nach dem Inhalt der Name, nicht der Titel.
 */
export function readFileName(compiled: CompiledKind, stem: string): Values | undefined {
  const values = (usesDash(stem) && matchPattern(compiled.fileDash, stem)) || matchPattern(compiled.file, stem);
  if (!values) return undefined;
  const placeholders = compiled.file?.placeholders ?? [];
  if (
    values.inhalt &&
    compiled.untitled.has(foldValue(values.inhalt)) &&
    values.titel &&
    !values.sprecher &&
    placeholders.includes('sprecher')
  ) {
    values.sprecher = values.titel;
    delete values.titel;
  }
  for (const key of ['titel', 'anlass', 'sprecher'] as const) if (values[key]) values[key] = tidy(values[key]!);
  return values;
}

// ---------- Vorschau ----------

export interface PreviewAlbum {
  folder: string;
  date: string | undefined;
  title: string;
  speaker: string | null;
  passage: string | null;
  tracks: Array<{ file: string; title: string; content: string | null; matched: boolean }>;
}

export interface Preview {
  kinds: Array<{ name: string; albums: number; unmatchedFiles: number; examples: PreviewAlbum[] }>;
}

/** Was das Regelwerk aus der aktuellen Bibliothek machen würde: je Art Anzahl und die neuesten Beispiele. */
export function previewStructure(db: DB, structure: Structure, examples = 4): Preview {
  const compiled = compileStructure(structure);
  const rows = db.prepare('SELECT path, title, duration FROM tracks').all() as Array<{ path: string; title: string; duration: number | null }>;
  const byFolder = new Map<string, typeof rows>();
  for (const row of rows) {
    const folder = albumFolderOf(row.path);
    if (!folderDate(folder)) continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), row]);
  }
  const result = compiled.kinds.map((k) => ({ name: k.kind.name, albums: 0, unmatchedFiles: 0, examples: [] as PreviewAlbum[] }));
  const folders = [...byFolder].sort((a, b) => (folderDate(b[0]) ?? '').localeCompare(folderDate(a[0]) ?? ''));
  for (const [folder, files] of folders) {
    const kind = kindOfFolder(compiled, folder);
    if (!kind) continue;
    const entry = result[compiled.kinds.indexOf(kind)]!;
    const applied = applyToFolder(
      kind,
      folder,
      files.map((f) => ({ ...f, titleTagged: false })),
    );
    entry.albums++;
    const tracks = [...files]
      .sort((a, b) => a.path.localeCompare(b.path, 'de', { numeric: true }))
      .map((f) => {
        const r = applied.files.get(f.path)!;
        if (!r.matched) entry.unmatchedFiles++;
        return { file: basename(f.path), title: r.title ?? f.title, content: r.content ?? null, matched: r.matched };
      });
    if (entry.examples.length < examples) {
      entry.examples.push({
        folder,
        date: folderDate(folder),
        title: applied.title || kind.kind.name,
        speaker: applied.speaker ?? null,
        passage: applied.passage ?? null,
        tracks: tracks.slice(0, 8),
      });
    }
  }
  return { kinds: result };
}
