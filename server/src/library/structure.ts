import { getMeta, setMeta, type DB } from '../db.js';
import { findPassage } from './bible.js';
import { findDate } from './dateText.js';
import { albumFolderOf, basename, dirname, fileStem, folderDate, folderYear } from './pathMeta.js';
import {
  compilePolicies,
  KIND_FIELDS,
  folderCondition,
  parsePolicies,
  parsePolicyCondition,
  PolicyError,
  policyMatcher,
  REMOVED_POLICY_FIELDS,
  withoutFields,
  type Decision,
  type ManualDecision,
  type Player,
  type Policy,
  type PolicyCondition,
  type PolicySubject,
} from './policies.js';
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
 *     Art "Bibelstunde" (Bedingung: Ordner heißt "Bibelstunden")
 *     Ordner "{datum}_{bibelstelle}"  -> Bibelstelle "Matthäus 9, 27-38"
 *     Datei  "{datum}_{nr}"           -> Teil 1
 *
 * Trennzeichen in Mustern sind austauschbar: " - ", "_", "." und Leerzeichen passen aufeinander.
 *
 * Was als Predigt gilt und welchen Player ein Titel bekommt, legen die Policies fest (policies.ts).
 */

export const PLACEHOLDERS = ['datum', 'anlass', 'bibelstelle', 'sprecher', 'inhalt', 'titel', 'nr'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface RecordingKind {
  /** "Gottesdienst", "Bibelstunde" */
  name: string;
  /** Mehrzahl für Überschriften und Filter: "Gottesdienste" */
  plural: string;
  /** Muster für den Namen des Aufnahme-Ordners */
  folderPattern: string;
  /** Muster für Dateinamen (ohne Endung) */
  filePattern: string;
  /** Vorlage für den Namen des Albums; leer oder ohne Wert: der Name der Art */
  albumTitle: string;
  /** Vorlage für den Titel einer Aufnahme */
  trackTitle: string;
}

/**
 * Feste Zuordnungen neben den Arten: Musik (von einer Regel oder von Hand) und Sonstiges für alles, dem nichts eine Art
 * gibt. Beide sind keine Aufnahmen: kein Regelwerk für Namen, keine Policy nach Art.
 */
export const MUSIC_KIND = 'Musik';
export const OTHER_KIND = 'Sonstiges';
export const FIXED_KINDS = [MUSIC_KIND, OTHER_KIND] as const;

/** Wie ein Album zählt: Aufnahme einer Art, Musik oder Sonstiges */
export type Section = 'recording' | 'music' | 'other';

/** "Art bestimmen": Wenn ein Albumordner passt, dann ist er diese Art (oder Musik bzw. Sonstiges). */
export interface KindRule {
  name: string;
  enabled: boolean;
  /** Bedingung auf Ordner, Pfad und Dateiname; passt, wenn der Ordner oder eine Datei darin passt */
  when: PolicyCondition;
  /** Name der Art, oder Musik bzw. Sonstiges (MUSIC_KIND, OTHER_KIND) */
  kind: string;
  /** Nur Ordner mit Datum im Namen */
  datedOnly: boolean;
}

export interface Structure {
  kinds: RecordingKind[];
  /** Art eines Albumordners, von oben nach unten; die erste passende Regel gilt */
  kindRules: KindRule[];
  /** Art der übrigen Ordner mit Datum, wenn keine Regel passt; auch Musik oder Sonstiges. Ordner ohne Datum: Sonstiges */
  defaultKind: string;
  /** Bekannte Inhalte am Anfang von Dateinamen ("Lied", "Predigt" …); auch mehrere Wörter möglich */
  contents: string[];
  /**
   * Inhalte ohne eigenen Titel: Folgt nur ein Teil ("Begrüßung - Jakob Rauschenberger"), ist das der Name
   * ({sprecher}), nicht der Titel.
   */
  untitled: string[];
  /** Was als Predigt gilt und welcher Player läuft, von oben nach unten */
  policies: Policy[];
}

/** Ohne passende Policy bekommen Titel ab dieser Länge den Predigt-Player (wie web/src/me.ts) */
export const LONG_TRACK_SECONDS = 10 * 60;

export const DEFAULT_STRUCTURE: Structure = {
  kinds: [
    {
      name: 'Bibelstunde',
      plural: 'Bibelstunden',
      folderPattern: '{datum}_{bibelstelle}',
      filePattern: '{datum}_{nr}',
      albumTitle: '{bibelstelle}',
      trackTitle: 'Teil {nr}',
    },
    {
      name: 'Gottesdienst',
      plural: 'Gottesdienste',
      folderPattern: '{datum}_{anlass}',
      filePattern: '{inhalt} - {titel} - {sprecher}',
      albumTitle: '{anlass}',
      trackTitle: '{inhalt}: {titel}',
    },
  ],
  kindRules: [
    { name: 'Bibelstunden', enabled: true, when: folderCondition('Bibelstunden'), kind: 'Bibelstunde', datedOnly: true },
    { name: 'Musik', enabled: true, when: folderCondition('Musik'), kind: MUSIC_KIND, datedOnly: false },
  ],
  defaultKind: 'Gottesdienst',
  contents: [
    'Lied', 'Predigt', 'Lesung', 'Schriftlesung', 'Gebet', 'Begrüßung', 'Abkündigungen', 'Segen', 'Musik', 'Vorspiel',
    'Nachspiel', 'Chor', 'Zeugnis', 'Kinderpredigt', 'Taufe', 'Abendmahl', 'Grußwort', 'Bericht', 'Einleitung', 'Beitrag',
    'Gedicht', 'Ansage', 'Schlusswort',
  ],
  untitled: ['Begrüßung', 'Abkündigungen', 'Gebet', 'Segen', 'Grußwort', 'Ansage', 'Schlusswort', 'Bericht', 'Zeugnis'],
  policies: [
    {
      name: 'Predigt im Gottesdienst',
      enabled: true,
      when: {
        match: 'all',
        conditions: [
          { field: 'kind', op: 'equals', value: 'Gottesdienst' },
          { field: 'content', op: 'equals', value: 'Predigt' },
        ],
      },
      sermon: true,
      player: 'sermon',
    },
    { name: 'Bibelstunden', enabled: true, when: { field: 'kind', op: 'equals', value: 'Bibelstunde' }, sermon: true, player: 'sermon' },
  ],
};

const META_KEY = 'structure';
export const MAX_KINDS = 10;
const MAX_KIND_RULES = 30;
const MAX_TEXT = 200;
const MAX_CONTENTS = 100;

export class StructureError extends Error {}

/**
 * Policies aus dem früheren Feld "Inhalt der Predigt" je Art: mit Inhalt gilt nur dieser als Predigt,
 * ohne alle Titel der Art. Für Regelwerke, die gespeichert wurden, bevor es Policies gab.
 */
function legacyPolicies(kinds: Array<Record<string, unknown>>): Policy[] {
  return kinds
    .filter((k) => typeof k.name === 'string' && k.name.trim())
    .map((k): Policy => {
      const kind: PolicyCondition = { field: 'kind', op: 'equals', value: String(k.name).trim() };
      const sermon = typeof k.sermon === 'string' ? k.sermon.trim() : '';
      return {
        name: sermon ? `${sermon} (${String(k.name).trim()})` : String(k.name).trim(),
        enabled: true,
        when: sermon ? { match: 'all', conditions: [kind, { field: 'content', op: 'equals', value: sermon }] } : kind,
        sermon: true,
        player: 'sermon',
      };
    });
}

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
  const body = input as { kinds?: unknown; contents?: unknown; policies?: unknown; kindRules?: unknown; defaultKind?: unknown };
  if (!Array.isArray(body.kinds) || body.kinds.length === 0) throw new StructureError('Mindestens eine Art ist nötig');
  if (body.kinds.length > MAX_KINDS) throw new StructureError(`Höchstens ${MAX_KINDS} Arten`);
  const names = new Set<string>();
  const kinds = body.kinds.map((raw, index): RecordingKind => {
    if (!raw || typeof raw !== 'object') throw new StructureError('Ungültige Art');
    const k = raw as Record<string, unknown>;
    const name = text(k.name, 'Name', 60);
    if (!name) throw new StructureError(`Art ${index + 1} braucht einen Namen`);
    if (names.has(foldValue(name))) throw new StructureError(`„${name}“ gibt es doppelt`);
    if (FIXED_KINDS.some((fixed) => foldValue(fixed) === foldValue(name))) {
      throw new StructureError(`„${name}“ gibt es schon fest; bitte einen anderen Namen für die Art`);
    }
    names.add(foldValue(name));
    const kind: RecordingKind = {
      name,
      plural: text(k.plural, 'Mehrzahl', 60) || name,
      folderPattern: text(k.folderPattern, 'Muster für Ordner'),
      filePattern: text(k.filePattern, 'Muster für Dateien'),
      albumTitle: text(k.albumTitle, 'Name des Albums'),
      trackTitle: text(k.trackTitle, 'Titel einer Aufnahme'),
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
  let policies: Policy[];
  try {
    policies = body.policies === undefined ? legacyPolicies(body.kinds as Array<Record<string, unknown>>) : parsePolicies(body.policies);
  } catch (error) {
    if (error instanceof PolicyError) throw new StructureError(error.message);
    throw error;
  }
  // Früher hieß "" keine Art, also Musik
  const kindName = (value: unknown, label: string): string => {
    const wanted = text(value, label, 60);
    if (!wanted) return MUSIC_KIND;
    const fixed = FIXED_KINDS.find((name) => foldValue(name) === foldValue(wanted));
    if (fixed) return fixed;
    const found = kinds.find((k) => foldValue(k.name) === foldValue(wanted));
    if (!found) throw new StructureError(`${label}: Die Art „${wanted}“ gibt es nicht`);
    return found.name;
  };
  let kindRules: KindRule[];
  let defaultKind: string;
  if (body.kindRules === undefined) {
    // Früher erkannte jede Art ihre Ordner an einem Ordnernamen ("folder"); ohne ihn nahm sie die übrigen Ordner mit Datum.
    const raw = body.kinds as Array<Record<string, unknown>>;
    kindRules = kinds
      .map((kind, i) => ({ kind, folder: text(raw[i]!.folder, 'Ordner', 100) }))
      .filter(({ folder }) => folder)
      .map(({ kind, folder }) => ({ name: kind.plural, enabled: true, when: folderCondition(folder), kind: kind.name, datedOnly: true }));
    defaultKind = kinds.find((_, i) => !text(raw[i]!.folder, 'Ordner', 100))?.name ?? MUSIC_KIND;
  } else {
    if (!Array.isArray(body.kindRules)) throw new StructureError('Art bestimmen: Liste erwartet');
    if (body.kindRules.length > MAX_KIND_RULES) throw new StructureError(`Höchstens ${MAX_KIND_RULES} Regeln in „Art bestimmen“`);
    kindRules = body.kindRules.map((rawRule, index): KindRule => {
      if (!rawRule || typeof rawRule !== 'object') throw new StructureError('Ungültige Regel in „Art bestimmen“');
      const r = rawRule as Record<string, unknown>;
      const ruleName = text(r.name, 'Name der Regel', 80) || `Regel ${index + 1}`;
      const label = `Art bestimmen, „${ruleName}“`;
      let when: PolicyCondition;
      try {
        when = parsePolicyCondition(r.when, KIND_FIELDS, label);
      } catch (error) {
        if (error instanceof PolicyError) throw new StructureError(error.message);
        throw error;
      }
      return { name: ruleName, enabled: r.enabled !== false, when, kind: kindName(r.kind, label), datedOnly: r.datedOnly !== false };
    });
    defaultKind = kindName(body.defaultKind, 'Übrige Ordner mit Datum');
  }
  return { kinds, kindRules, defaultKind, contents, untitled, policies };
}

export function getStructure(db: DB): Structure {
  const stored = getMeta(db, META_KEY);
  if (!stored) return DEFAULT_STRUCTURE;
  try {
    const raw = JSON.parse(stored) as Record<string, unknown>;
    // Gespeichert, bevor es "Inhalte ohne Titel" gab: Vorgabe übernehmen
    if (!('untitled' in raw)) raw.untitled = DEFAULT_STRUCTURE.untitled;
    // Bedingungen auf Tags (Interpret, Album, Genre) gibt es nicht mehr: weglassen, Regeln ohne Bedingung entfallen
    if (Array.isArray(raw.kindRules)) {
      raw.kindRules = raw.kindRules.flatMap((rule: Record<string, unknown>) => {
        const when = withoutFields(rule?.when, REMOVED_POLICY_FIELDS);
        return when ? [{ ...rule, when }] : [];
      });
    }
    if (Array.isArray(raw.policies)) {
      raw.policies = raw.policies.flatMap((policy: Record<string, unknown>) => {
        const when = withoutFields(policy?.when, REMOVED_POLICY_FIELDS);
        return when ? [{ ...policy, when }] : [];
      });
    }
    // Eine eigene Art "Musik" oder "Sonstiges" von früher geht in der festen Zuordnung gleichen Namens auf
    if (Array.isArray(raw.kinds)) {
      const kinds = raw.kinds.filter(
        (kind: Record<string, unknown>) => !FIXED_KINDS.some((fixed) => typeof kind?.name === 'string' && foldValue(kind.name) === foldValue(fixed)),
      );
      if (kinds.length) raw.kinds = kinds;
    }
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
            : // Trennt der Name mit " - ", ist nur der Titel mehrteilig ("Kolosser 1 - Apg 3,7"); Name, Anlass usw.
              // sind ein Teil, damit ein Name am Ende nicht die übrigen Teile mitnimmt.
              options.dashOnly && name !== 'titel'
              ? String.raw`(?:(?!\s[-–]\s).)+?`
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
  folder?: CompiledPattern;
  file?: CompiledPattern;
  /** Dasselbe Dateimuster für Namen mit " - " als Trenner */
  fileDash?: CompiledPattern;
  /** Inhalte ohne Titel, als Vergleichsschlüssel */
  untitled: Set<string>;
  /** Policies: gilt als Predigt, Player */
  decide: (subject: PolicySubject) => Decision;
}

export interface CompiledStructure {
  structure: Structure;
  kinds: CompiledKind[];
  decide: (subject: PolicySubject) => Decision;
  kindRules: Array<{ rule: KindRule; matches: (subject: PolicySubject) => boolean }>;
}

export function compileStructure(structure: Structure): CompiledStructure {
  const decide = compilePolicies(structure.policies);
  return {
    structure,
    decide,
    kindRules: structure.kindRules.filter((rule) => rule.enabled).map((rule) => ({ rule, matches: policyMatcher(rule.when) })),
    kinds: structure.kinds.map((kind) => ({
      kind,
      decide,
      folder: compilePattern(kind.folderPattern),
      file: compilePattern(kind.filePattern, structure.contents, { leadingNumber: true }),
      fileDash: compilePattern(kind.filePattern, structure.contents, { leadingNumber: true, dashOnly: true }),
      untitled: new Set(structure.untitled.map(foldValue)),
    })),
  };
}

/** Woher die Art eines Albums kommt: von Hand, aus einer Regel in "Art bestimmen" oder als Vorgabe für Ordner mit Datum */
export type KindSource = { by: 'manual' } | { by: 'rule'; rule: string } | { by: 'default' } | { by: 'none' };

export interface KindOfFolder {
  /** Art der Aufnahme; undefined bei Musik und Sonstiges */
  kind: CompiledKind | undefined;
  section: Section;
  source: KindSource;
}

const findKind = (compiled: CompiledStructure, name: string) => {
  const key = foldValue(name);
  return key ? compiled.kinds.find((k) => foldValue(k.kind.name) === key) : undefined;
};

/** Art, Musik oder Sonstiges zu einem Namen aus Regel, Vorgabe oder Verwaltung ("" hieß früher Musik) */
function resolveKind(compiled: CompiledStructure, name: string, source: KindSource): KindOfFolder {
  const key = foldValue(name);
  if (!key || key === foldValue(MUSIC_KIND)) return { kind: undefined, section: 'music', source };
  const kind = findKind(compiled, name);
  return kind ? { kind, section: 'recording', source } : { kind: undefined, section: 'other', source };
}

/** Vorgabe für Ordner mit Datum, auf die keine Regel passt */
export const defaultKindOf = (compiled: CompiledStructure): KindOfFolder =>
  resolveKind(compiled, compiled.structure.defaultKind, { by: 'default' });

/** Art von Hand in Normalform: "" (früher keine Art) ist Musik */
export const normalizeManualKind = (manual: string | null | undefined): string | null | undefined =>
  manual === '' ? MUSIC_KIND : manual;

/**
 * Art eines Albumordners nach "Art bestimmen": die erste passende Regel, sonst bei Ordnern mit Datum die Vorgabe.
 * Eine Regel passt, wenn ihre Bedingung auf den Ordner oder eine Datei darin passt (Pfad, Dateiname).
 * Passt nichts, ist das Album Sonstiges. `manual`: in der Verwaltung für dieses Album gesetzte Art (auch Musik oder
 * Sonstiges); sie geht allen Regeln vor, auch bei Titeln ohne eigenen Ordner.
 */
export function kindOfFolder(
  compiled: CompiledStructure,
  folder: string,
  files: Array<Omit<PolicySubject, 'content' | 'kind' | 'duration'>> = [],
  manual?: string | null,
): KindOfFolder {
  if (manual !== undefined && manual !== null) return resolveKind(compiled, manual, { by: 'manual' });
  if (!folder) return { kind: undefined, section: 'other', source: { by: 'none' } };
  const dated = Boolean(folderDate(folder));
  // Der Ordner selbst zählt mit ("Ordner im Pfad ist genau …"); der Schrägstrich macht ihn zum Ordner statt zur Datei
  const subjects = [{ path: `${folder}/` }, ...files];
  for (const { rule, matches } of compiled.kindRules) {
    if (rule.datedOnly && !dated) continue;
    if (subjects.some(matches)) return resolveKind(compiled, rule.kind, { by: 'rule', rule: rule.name });
  }
  if (dated) return defaultKindOf(compiled);
  return { kind: undefined, section: 'other', source: { by: 'none' } };
}

export interface FileInfo {
  path: string;
  /** Titel aus dem Dateinamen, wie gescannt */
  title: string;
  duration: number | null;
  /** Korrektur aus der Verwaltung; geht den Policies vor */
  manual?: ManualDecision;
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
  /** Gilt laut Policies als Predigt (liefert Sprecher und Bibelstelle) */
  sermon: boolean;
  /** Player laut Policies oder Korrektur; undefined: nach Länge */
  player?: Player;
  /** Was die Policies ohne Korrektur ergeben */
  auto: Decision;
}

export interface FolderResult {
  kind: RecordingKind;
  /** Name des Albums nach der Vorlage (leer: keiner) */
  title: string;
  /** Anlass aus dem Ordnernamen ("Einschulung") */
  occasion?: string;
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
  // Policies entscheiden, was als Predigt gilt; nur die Predigt nennt den Sprecher ("Lied - Befiehl du deine Wege" nicht)
  const decide = (file: FileInfo, values: Values | undefined, title: string | undefined) => {
    const auto = compiled.decide({
      title: title ?? file.title,
      content: values?.inhalt,
      kind: kind.name,
      path: file.path,
      duration: file.duration,
    });
    return withManual(auto, file.manual);
  };
  const parsed = files.map((file) => {
    const values = readFileName(compiled, fileStem(file.path));
    const nr = values?.nr ?? values?.lead;
    return { file, values, nr: nr !== undefined ? Number(nr) : undefined, sermon: false };
  });
  for (const entry of parsed) {
    const { file, values, nr } = entry;
    if (!values) {
      const decision = decide(file, undefined, undefined);
      entry.sermon = decision.sermon === true;
      results.set(file.path, {
        matched: false,
        content: decision.content,
        sermon: entry.sermon,
        player: decision.player,
        auto: decision.auto,
      });
      continue;
    }
    const all: Values = { ...folderValues, ...values, nr: nr !== undefined ? String(nr) : undefined };
    if (all.datum) all.datum = findDate(all.datum, folderYear(dirname(file.path)))?.date ?? all.datum;
    const template = (inhalt: string | undefined) => fillTemplate(kind.trackTitle || '{titel}', { ...all, inhalt }) || undefined;
    const decision = decide(file, values, template(values.inhalt));
    // Ein Inhalt aus den Policies ersetzt den aus dem Dateinamen, auch im Titel ("{inhalt}: {titel}")
    const content = decision.content ?? values.inhalt;
    const title = template(content);
    entry.sermon = decision.sermon === true;
    results.set(file.path, {
      matched: true,
      title,
      content,
      speaker: entry.sermon ? values.sprecher : undefined,
      performer: values.sprecher,
      passage: values.bibelstelle,
      nr,
      sermon: entry.sermon,
      player: decision.player,
      auto: decision.auto,
    });
  }

  // Predigt: die längste Aufnahme, die laut Policies als Predigt gilt
  const sermons = parsed
    .filter(({ sermon }) => sermon)
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
    occasion: folderValues.anlass,
    passage: passage ?? undefined,
    speaker: speaker ?? undefined,
    files: results,
  };
}

/** Korrektur aus der Verwaltung über das Ergebnis der Policies legen; `auto` bleibt zum Anzeigen */
export function withManual(
  auto: Decision,
  manual: ManualDecision | undefined,
): { sermon?: boolean; player?: Player; content?: string; auto: Decision } {
  return {
    sermon: manual?.sermon ?? auto.sermon,
    player: manual?.player ?? auto.player,
    content: auto.content,
    auto,
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
  tracks: Array<{ file: string; title: string; content: string | null; matched: boolean; sermon: boolean; player: Player }>;
}

export interface Preview {
  kinds: Array<{ name: string; albums: number; unmatchedFiles: number; examples: PreviewAlbum[] }>;
}

/** Was das Regelwerk aus der aktuellen Bibliothek machen würde: je Art Anzahl und die neuesten Beispiele. */
export function previewStructure(db: DB, structure: Structure, examples = 4): Preview {
  const compiled = compileStructure(structure);
  const rows = db.prepare('SELECT path, title, duration FROM tracks').all() as Array<{
    path: string;
    title: string;
    duration: number | null;
  }>;
  const byFolder = new Map<string, typeof rows>();
  for (const row of rows) {
    const folder = albumFolderOf(row.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), row]);
  }
  const result = compiled.kinds.map((k) => ({ name: k.kind.name, albums: 0, unmatchedFiles: 0, examples: [] as PreviewAlbum[] }));
  const folders = [...byFolder].sort((a, b) => (folderDate(b[0]) ?? '').localeCompare(folderDate(a[0]) ?? ''));
  for (const [folder, files] of folders) {
    const { kind } = kindOfFolder(compiled, folder, files);
    if (!kind) continue;
    const entry = result[compiled.kinds.indexOf(kind)]!;
    const applied = applyToFolder(kind, folder, files);
    entry.albums++;
    const tracks = [...files]
      .sort((a, b) => a.path.localeCompare(b.path, 'de', { numeric: true }))
      .map((f) => {
        const r = applied.files.get(f.path)!;
        if (!r.matched) entry.unmatchedFiles++;
        return {
          file: basename(f.path),
          title: r.title ?? f.title,
          content: r.content ?? null,
          matched: r.matched,
          sermon: r.sermon,
          player: playerOf(r.player, f.duration),
        };
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

/** Player eines Titels: laut Policy, sonst nach Länge */
export const playerOf = (player: Player | undefined | null, duration: number | null | undefined): Player =>
  player ?? ((duration ?? 0) >= LONG_TRACK_SECONDS ? 'sermon' : 'music');
