import type { DB } from '../db.js';
import { normalizeKey } from './albums.js';
import { parseFolderDate } from './dates.js';
import { albumFolderOf, basename } from './pathMeta.js';

/**
 * Regeln füllen eigene Alben automatisch, z. B. "Titel enthält Predigt → Album Predigten".
 * Sie werden bei jedem Scan und jeder Änderung in der Verwaltung neu ausgewertet,
 * neue passende Titel landen also ohne Zutun im Album.
 */
export const RULE_FIELDS = ['title', 'artist', 'album', 'genre', 'path'] as const;
export const RULE_OPS = ['contains', 'starts', 'equals'] as const;

export type RuleField = (typeof RULE_FIELDS)[number];
export type RuleOp = (typeof RULE_OPS)[number];

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
}

export interface AlbumRule extends RuleCondition {
  id: number;
  albumId: number;
  /** Passende Titel aus ihrem automatischen Album herausnehmen */
  move: boolean;
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
  const needle = normalizeKey(condition.value);
  if (!needle) return () => false;
  return (track) => {
    const text = normalizeKey(fieldText(track, condition.field));
    if (condition.op === 'equals') return text === needle;
    if (condition.op === 'starts') return text.startsWith(needle);
    return text.includes(needle);
  };
}

/**
 * Reihenfolge der Titel, die eine Regel hinzufügt: nach Datum im Ordnernamen, neueste zuerst
 * (passt zu Gottesdienst-Aufnahmen), Titel ohne Datum danach nach Pfad.
 */
export function compareRuleTracks(a: RuleTrack, b: RuleTrack): number {
  const da = parseFolderDate(basename(albumFolderOf(a.path))) ?? '';
  const db = parseFolderDate(basename(albumFolderOf(b.path))) ?? '';
  if (da !== db) return da && db ? db.localeCompare(da) : da ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function listRules(db: DB, albumId?: number): AlbumRule[] {
  const rows = db
    .prepare(
      `SELECT id, album_id AS albumId, field, op, value, move FROM album_rules
       ${albumId === undefined ? '' : 'WHERE album_id = ?'} ORDER BY id`,
    )
    .all(...(albumId === undefined ? [] : [albumId])) as Array<Omit<AlbumRule, 'move'> & { move: number }>;
  return rows.map((row) => ({ ...row, move: Boolean(row.move) }));
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
    const matches = ruleMatcher(rule);
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
  for (const list of members.values()) list.sort(compareRuleTracks);
  return { members, moved };
}
