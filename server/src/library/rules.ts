import type { DB } from '../db.js';
import { normalizeKey } from './albums.js';
import { albumFolderOf, dateOfPath } from './pathMeta.js';

/**
 * Regeln füllen eigene Alben automatisch, z. B. "Titel enthält Predigt → Album Predigten".
 * Sie werden bei jedem Scan und jeder Änderung in der Verwaltung neu ausgewertet,
 * neue passende Titel landen also ohne Zutun im Album.
 */
export const RULE_FIELDS = ['title', 'artist', 'album', 'genre', 'path'] as const;
export const RULE_OPS = ['contains', 'not_contains', 'starts', 'equals'] as const;
export const MAX_DEPTH = 4;
export const MAX_CONDITIONS = 30;

export type RuleField = (typeof RULE_FIELDS)[number];
export type RuleOp = (typeof RULE_OPS)[number];

/** Eine einzelne Bedingung, z. B. Titel enthält "Predigt" */
export interface RuleLeaf {
  field: RuleField;
  op: RuleOp;
  value: string;
}

/** Gruppe: "all" = alle Bedingungen müssen passen (UND), "any" = mindestens eine (ODER). Beliebig verschachtelbar. */
export interface RuleGroup {
  match: 'all' | 'any';
  conditions: RuleCondition[];
}

export type RuleCondition = RuleLeaf | RuleGroup;

export interface AlbumRule {
  id: number;
  albumId: number;
  condition: RuleCondition;
  /** Passende Titel aus ihrem automatischen Album herausnehmen */
  move: boolean;
}

export const isGroup = (condition: RuleCondition): condition is RuleGroup => 'match' in condition;

/**
 * Prüft eine Bedingung aus der API und bringt sie in Normalform (Werte getrimmt,
 * Gruppen mit nur einem Eintrag aufgelöst). Wirft mit verständlicher Meldung.
 */
export function parseCondition(input: unknown): RuleCondition {
  let count = 0;
  const walk = (node: unknown, depth: number): RuleCondition => {
    if (!node || typeof node !== 'object') throw new Error('Ungültige Bedingung');
    const obj = node as Record<string, unknown>;
    if ('match' in obj || 'conditions' in obj) {
      if (depth >= MAX_DEPTH) throw new Error(`Höchstens ${MAX_DEPTH} Ebenen verschachteln`);
      if (obj.match !== 'all' && obj.match !== 'any') throw new Error('Gruppe braucht "all" (UND) oder "any" (ODER)');
      if (!Array.isArray(obj.conditions) || obj.conditions.length === 0) throw new Error('Eine Gruppe braucht mindestens eine Bedingung');
      const conditions = obj.conditions.map((child) => walk(child, depth + 1));
      return conditions.length === 1 ? conditions[0]! : { match: obj.match, conditions };
    }
    if (++count > MAX_CONDITIONS) throw new Error(`Höchstens ${MAX_CONDITIONS} Bedingungen pro Regel`);
    if (!RULE_FIELDS.includes(obj.field as RuleField)) throw new Error('Unbekanntes Feld in der Bedingung');
    const op = obj.op ?? 'contains';
    if (!RULE_OPS.includes(op as RuleOp)) throw new Error('Unbekannte Bedingung');
    const value = typeof obj.value === 'string' ? obj.value.trim() : '';
    if (!value) throw new Error('Jede Bedingung braucht einen Suchbegriff');
    if (value.length > 200) throw new Error('Suchbegriff ist zu lang');
    return { field: obj.field as RuleField, op: op as RuleOp, value };
  };
  return walk(input, 0);
}

export interface RuleTrack {
  id: number;
  path: string;
  title: string;
  artist: string;
  album_artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  disc_no?: number | null;
  track_no?: number | null;
}

function fieldText(track: RuleTrack, field: RuleField): string {
  switch (field) {
    case 'title':
      return track.title;
    case 'artist':
      return `${track.artist} ${track.album_artist ?? ''}`;
    case 'album':
      return track.album ?? '';
    case 'genre':
      return track.genre ?? '';
    case 'path':
      return track.path;
  }
}

/** Groß-/Kleinschreibung, Umlaute, Akzente und Satzzeichen spielen keine Rolle. */
export function ruleMatcher(condition: RuleCondition): (track: RuleTrack) => boolean {
  if (isGroup(condition)) {
    const children = condition.conditions.map(ruleMatcher);
    return condition.match === 'all'
      ? (track) => children.every((matches) => matches(track))
      : (track) => children.some((matches) => matches(track));
  }
  const needle = normalizeKey(condition.value);
  if (!needle) return () => false;
  return (track) => {
    const text = normalizeKey(fieldText(track, condition.field));
    switch (condition.op) {
      case 'equals':
        return text === needle;
      case 'starts':
        return text.startsWith(needle);
      case 'not_contains':
        return !text.includes(needle);
      default:
        return text.includes(needle);
    }
  };
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/**
 * Reihenfolge der Titel, die eine Regel hinzufügt: nach Datum (Ordner- oder Dateiname), neueste zuerst
 * (passt zu Gottesdienst-Aufnahmen), Titel ohne Datum danach. Innerhalb eines Datums bzw. Ordners
 * wie im Album: nach CD und Tracknummer, sonst nach Dateiname ("2 …" vor "10 …").
 */
export function sortRuleTracks<T extends RuleTrack>(tracks: T[]): T[] {
  const keyed = tracks.map((track) => ({ track, date: dateOfPath(track.path) ?? '', folder: albumFolderOf(track.path) }));
  keyed.sort((a, b) => {
    if (a.date !== b.date) return a.date && b.date ? b.date.localeCompare(a.date) : a.date ? -1 : 1;
    return (
      collator.compare(a.folder, b.folder) ||
      (a.track.disc_no ?? 1) - (b.track.disc_no ?? 1) ||
      Number(a.track.track_no == null) - Number(b.track.track_no == null) ||
      (a.track.track_no ?? 0) - (b.track.track_no ?? 0) ||
      collator.compare(a.track.path, b.track.path)
    );
  });
  return keyed.map((entry) => entry.track);
}

export function listRules(db: DB, albumId?: number): AlbumRule[] {
  const rows = db
    .prepare(
      `SELECT id, album_id AS albumId, condition, move FROM album_rules
       ${albumId === undefined ? '' : 'WHERE album_id = ?'} ORDER BY id`,
    )
    .all(...(albumId === undefined ? [] : [albumId])) as Array<{ id: number; albumId: number; condition: string; move: number }>;
  return rows.map((row) => ({ ...row, condition: JSON.parse(row.condition) as RuleCondition, move: Boolean(row.move) }));
}

export interface RuleResult<T extends RuleTrack> {
  /** Titel je Album, die durch Regeln hineinkommen, in Regel-Reihenfolge */
  members: Map<number, T[]>;
  /** Titel, die eine Regel mit "verschieben" aus ihrem automatischen Album nimmt */
  moved: Set<number>;
}

export function evaluateRules<T extends RuleTrack>(db: DB, tracks: T[]): RuleResult<T> {
  const members = new Map<number, T[]>();
  const moved = new Set<number>();
  const rules = listRules(db);
  if (!rules.length) return { members, moved };
  const removed = new Set(
    (db.prepare('SELECT album_id, path FROM manual_album_removed').all() as Array<{ album_id: number; path: string }>).map(
      (row) => `${row.album_id}\u0000${row.path}`,
    ),
  );
  for (const rule of rules) {
    const matches = ruleMatcher(rule.condition);
    const list = members.get(rule.albumId) ?? [];
    const seen = new Set(list.map((t) => t.id));
    for (const track of tracks) {
      if (seen.has(track.id) || !matches(track)) continue;
      if (removed.has(`${rule.albumId}\u0000${track.path}`)) continue;
      list.push(track);
      seen.add(track.id);
      if (rule.move) moved.add(track.id);
    }
    members.set(rule.albumId, list);
  }
  for (const [albumId, list] of members) members.set(albumId, sortRuleTracks(list));
  return { members, moved };
}
