import type { FastifyBaseLogger } from 'fastify';
import { getMeta, setMeta, type DB } from '../db.js';
import { rebuildAlbums } from './albums.js';
import { isGroup, type RuleCondition } from './rules.js';

const META_KEY = 'musicBase';

/**
 * Rechnet einen Pfad der Bibliothek von einem Bezugsordner auf einen anderen um,
 * z. B. "Hillsong/a.mp3" unter /Gemeinde/Musik zu "Musik/Hillsong/a.mp3" unter /Gemeinde.
 * undefined, wenn der Pfad nicht unter dem neuen Bezugsordner liegt.
 */
export function movePath(path: string, from: string, to: string): string | undefined {
  const full = path ? `${from}/${path}` : from;
  if (to === '') return full.replace(/^\/+/, '');
  if (full === to) return '';
  return full.startsWith(`${to}/`) ? full.slice(to.length + 1) : undefined;
}

/**
 * Alle Pfade in der Bibliothek beziehen sich auf einen Ordner (bei einem Musikordner dieser selbst,
 * bei mehreren ihr gemeinsamer Elternordner). Ändert er sich, weil Ordner dazukommen oder wegfallen,
 * werden gespeicherte Pfade und alles, was daran hängt (eigene Alben, Korrekturen, Regeln), umgerechnet.
 * So bleiben Album-IDs und Eingriffe aus der Verwaltung erhalten und der Scan muss nichts neu lesen.
 *
 * Datenbanken aus der Zeit vor mehreren Ordnern kennen ihren Bezugsordner nicht; dort gilt der
 * erste angegebene Musikordner als der bisherige.
 */
export function relocateLibrary(db: DB, base: string, musicPaths: string[], log: FastifyBaseLogger): void {
  const hasTracks = db.prepare('SELECT 1 FROM tracks LIMIT 1').get() !== undefined;
  const previous = getMeta(db, META_KEY) ?? (hasTracks ? musicPaths[0] : undefined);
  if (previous === undefined || previous === base) {
    setMeta(db, META_KEY, base);
    return;
  }

  const move = (path: string) => movePath(path, previous, base);
  const moveKey = (key: string) => {
    const split = key.indexOf('\u0000');
    if (split < 0) return undefined;
    const folder = move(key.slice(0, split));
    return folder === undefined ? undefined : folder + key.slice(split);
  };
  // "beginnt mit" und "ist genau" beim Ordner beziehen sich auf den Pfadanfang und wandern mit.
  const moveRule = (condition: RuleCondition): RuleCondition => {
    if (isGroup(condition)) return { ...condition, conditions: condition.conditions.map(moveRule) };
    if (condition.field !== 'path' || (condition.op !== 'starts' && condition.op !== 'equals')) return condition;
    const value = move(condition.value);
    return value === undefined ? condition : { ...condition, value };
  };

  let moved = 0;
  db.transaction(() => {
    const update = (table: string, column: string, map: (value: string) => string | undefined, where = '') => {
      const rows = db.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} ${where}`).all() as Array<{
        id: number;
        value: string | null;
      }>;
      const set = db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        if (row.value === null) continue;
        const next = map(row.value);
        if (next !== undefined && next !== row.value) {
          set.run(next, row.id);
          if (table === 'tracks') moved++;
        }
      }
    };
    // Tabellen WITHOUT ROWID haben keine rowid; dort über den ganzen Schlüssel.
    const updateKeyed = (table: string, column: string, keys: string[], map: (value: string) => string | undefined) => {
      const rows = db.prepare(`SELECT ${[column, ...keys].join(', ')} FROM ${table}`).all() as Array<Record<string, string>>;
      const set = db.prepare(
        `UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${[column, ...keys].map((c) => `${c} = ?`).join(' AND ')}`,
      );
      for (const row of rows) {
        const next = map(row[column]!);
        if (next !== undefined && next !== row[column]) set.run(next, row[column], ...keys.map((k) => row[k]));
      }
    };

    // Titel außerhalb des neuen Bezugsordners liegen in keinem Musikordner mehr; der Scan würde sie ohnehin
    // entfernen. Vorher löschen, damit ihre alten Pfade nicht mit umgerechneten zusammenstoßen.
    const removeTrack = db.prepare('DELETE FROM tracks WHERE id = ?');
    for (const row of db.prepare('SELECT id, path FROM tracks').all() as Array<{ id: number; path: string }>) {
      if (move(row.path) === undefined) removeTrack.run(row.id);
    }
    update('tracks', 'path', move);
    update('albums', 'folder', move, "WHERE kind = 'auto'");
    update('albums', 'cover_path', move);
    update('albums', 'key', moveKey, "WHERE kind = 'auto'");
    updateKeyed('folder_covers', 'folder', [], move);
    updateKeyed('folder_covers', 'path', ['folder'], move);
    updateKeyed('album_overrides', 'key', [], moveKey);
    updateKeyed('track_exclusions', 'path', ['album_key'], move);
    updateKeyed('track_exclusions', 'album_key', ['path'], moveKey);
    updateKeyed('manual_album_tracks', 'path', ['album_id'], move);
    updateKeyed('manual_album_removed', 'path', ['album_id'], move);
    update('album_rules', 'condition', (json) => JSON.stringify(moveRule(JSON.parse(json) as RuleCondition)));
    setMeta(db, META_KEY, base);
  })();
  rebuildAlbums(db);
  log.info({ from: previous || '/', to: base || '/', tracks: moved }, 'Bezugsordner der Bibliothek geändert, Pfade umgerechnet');
}
