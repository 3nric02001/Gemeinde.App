import type { DB } from '../db.js';
import { CurationError } from './curation.js';
import { foldValue } from './text.js';

/**
 * Frei definierbare Kategorien. Eine Kategorie nimmt ihre Werte aus einem oder mehreren Tag-Feldern
 * (z. B. artist + albumartist) und kann Werte unter einem eigenen Namen zusammenfassen
 * ("Musik" <- Musik, Lied). Die Tags selbst stehen je Titel in track_tags.
 */

export interface CategoryGroup {
  label: string;
  values: string[];
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  position: number;
  inNav: boolean;
  groupedOnly: boolean;
  fields: string[];
  groups: CategoryGroup[];
}

export interface CategoryInput {
  name?: string;
  fields?: string[];
  groups?: CategoryGroup[];
  inNav?: boolean;
  groupedOnly?: boolean;
}

export interface CategoryValue {
  value: string;
  trackCount: number;
  /** Zusammengefasster Wert statt eines Werts aus den Tags */
  grouped: boolean;
  /** Bei zusammengefassten Werten: welche Tag-Werte dazugehören */
  sources?: string[];
}

/** Welche Titel zu einem Wert einer Kategorie gehören, als Filter für Titel- und Albumlisten */
export interface CategoryFilter {
  fields: string[];
  vkeys: string[];
}

export const MAX_CATEGORIES = 30;
export const MAX_FIELDS = 10;
export const MAX_GROUPS = 100;
export const MAX_GROUP_VALUES = 50;
/** Diese Pfade belegt die Weboberfläche schon */
const RESERVED_SLUGS = new Set(['admin', 'verwaltung', 'suche', 'alben', 'album', 'titel', 'datum', 'start', 'kategorie']);

export function slugify(name: string): string {
  return (
    foldValue(name)
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'kategorie'
  );
}

function uniqueSlug(db: DB, name: string, ownId?: number): string {
  const base = slugify(name);
  const taken = db.prepare('SELECT 1 FROM categories WHERE slug = ? AND id IS NOT ?');
  for (let n = 1; ; n++) {
    if (n === 1 && RESERVED_SLUGS.has(base)) continue;
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!taken.get(slug, ownId ?? null)) return slug;
  }
}

interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  position: number;
  in_nav: number;
  grouped_only: number;
}

export function listCategories(db: DB): Category[] {
  const rows = db
    .prepare('SELECT id, name, slug, position, in_nav, grouped_only FROM categories ORDER BY position, id')
    .all() as CategoryRow[];
  const fields = db.prepare('SELECT category_id AS id, tag FROM category_fields ORDER BY tag').all() as Array<{
    id: number;
    tag: string;
  }>;
  const groups = db
    .prepare(
      `SELECT g.category_id AS id, g.id AS groupId, g.label, v.value FROM category_groups g
       LEFT JOIN category_group_values v ON v.group_id = g.id ORDER BY g.position, g.id, v.value COLLATE NOCASE`,
    )
    .all() as Array<{ id: number; groupId: number; label: string; value: string | null }>;
  return rows.map((row) => {
    const byGroup = new Map<number, CategoryGroup>();
    for (const g of groups) {
      if (g.id !== row.id) continue;
      let group = byGroup.get(g.groupId);
      if (!group) byGroup.set(g.groupId, (group = { label: g.label, values: [] }));
      if (g.value !== null) group.values.push(g.value);
    }
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      position: row.position,
      inNav: Boolean(row.in_nav),
      groupedOnly: Boolean(row.grouped_only),
      fields: fields.filter((f) => f.id === row.id).map((f) => f.tag),
      groups: [...byGroup.values()],
    };
  });
}

export function getCategory(db: DB, idOrSlug: number | string): Category | undefined {
  return listCategories(db).find((c) => (typeof idOrSlug === 'number' ? c.id === idOrSlug : c.slug === idOrSlug));
}

function requireCategory(db: DB, id: number): Category {
  const category = getCategory(db, id);
  if (!category) throw new CurationError(404, 'Kategorie nicht gefunden');
  return category;
}

function cleanFields(fields: string[]): string[] {
  const clean = [...new Set(fields.map((f) => f.trim().toLowerCase()).filter(Boolean))];
  if (clean.length === 0) throw new CurationError(400, 'Mindestens ein Tag-Feld auswählen');
  if (clean.length > MAX_FIELDS) throw new CurationError(400, `Höchstens ${MAX_FIELDS} Tag-Felder je Kategorie`);
  return clean;
}

/** Gruppen säubern: Namen nötig, Werte ohne Dubletten, ein Tag-Wert höchstens in einer Gruppe */
function cleanGroups(groups: CategoryGroup[]): CategoryGroup[] {
  if (groups.length > MAX_GROUPS) throw new CurationError(400, `Höchstens ${MAX_GROUPS} zusammengefasste Werte`);
  const labels = new Set<string>();
  const used = new Map<string, string>();
  return groups.map((group) => {
    const label = group.label.trim();
    if (!label) throw new CurationError(400, 'Zusammengefasster Wert braucht einen Namen');
    if (labels.has(foldValue(label))) throw new CurationError(400, `„${label}“ ist doppelt`);
    labels.add(foldValue(label));
    const values: string[] = [];
    const seen = new Set<string>();
    for (const raw of group.values) {
      const value = raw.trim();
      const key = foldValue(value);
      if (!key || seen.has(key)) continue;
      const other = used.get(key);
      if (other) throw new CurationError(400, `„${value}“ steht schon bei „${other}“`);
      used.set(key, label);
      seen.add(key);
      values.push(value);
    }
    if (values.length === 0) throw new CurationError(400, `„${label}“ braucht mindestens einen Tag-Wert`);
    if (values.length > MAX_GROUP_VALUES) throw new CurationError(400, `Höchstens ${MAX_GROUP_VALUES} Werte je Eintrag`);
    return { label, values };
  });
}

function writeDetails(db: DB, id: number, input: CategoryInput): void {
  if (input.fields) {
    const fields = cleanFields(input.fields);
    db.prepare('DELETE FROM category_fields WHERE category_id = ?').run(id);
    const add = db.prepare('INSERT INTO category_fields (category_id, tag) VALUES (?, ?)');
    for (const tag of fields) add.run(id, tag);
  }
  if (input.groups) {
    const groups = cleanGroups(input.groups);
    db.prepare('DELETE FROM category_groups WHERE category_id = ?').run(id);
    const addGroup = db.prepare('INSERT INTO category_groups (category_id, label, position) VALUES (?, ?, ?) RETURNING id');
    const addValue = db.prepare('INSERT INTO category_group_values (group_id, value, vkey) VALUES (?, ?, ?)');
    groups.forEach((group, position) => {
      const { id: groupId } = addGroup.get(id, group.label, position) as { id: number };
      for (const value of group.values) addValue.run(groupId, value, foldValue(value));
    });
  }
}

function cleanName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new CurationError(400, 'Name fehlt');
  return clean;
}

export function createCategory(db: DB, input: CategoryInput & { name: string; fields: string[] }): Category {
  return db.transaction(() => {
    const { count } = db.prepare('SELECT count(*) AS count FROM categories').get() as { count: number };
    if (count >= MAX_CATEGORIES) throw new CurationError(400, `Höchstens ${MAX_CATEGORIES} Kategorien`);
    const name = cleanName(input.name);
    const { id } = db
      .prepare(
        `INSERT INTO categories (name, slug, position, in_nav, grouped_only, created_at)
         VALUES (?, ?, (SELECT coalesce(max(position) + 1, 0) FROM categories), ?, ?, ?) RETURNING id`,
      )
      .get(name, uniqueSlug(db, name), input.inNav === false ? 0 : 1, input.groupedOnly ? 1 : 0, Date.now()) as {
      id: number;
    };
    writeDetails(db, id, { fields: input.fields, groups: input.groups ?? [] });
    return requireCategory(db, id);
  })();
}

export function updateCategory(db: DB, id: number, input: CategoryInput): Category {
  return db.transaction(() => {
    const current = requireCategory(db, id);
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      // Beim Umbenennen wandert auch die Adresse mit, damit sie zum Namen passt.
      const slug = name === current.name ? current.slug : uniqueSlug(db, name, id);
      db.prepare('UPDATE categories SET name = ?, slug = ? WHERE id = ?').run(name, slug, id);
    }
    if (input.inNav !== undefined) db.prepare('UPDATE categories SET in_nav = ? WHERE id = ?').run(input.inNav ? 1 : 0, id);
    if (input.groupedOnly !== undefined) {
      db.prepare('UPDATE categories SET grouped_only = ? WHERE id = ?').run(input.groupedOnly ? 1 : 0, id);
    }
    writeDetails(db, id, input);
    return requireCategory(db, id);
  })();
}

export function deleteCategory(db: DB, id: number): void {
  requireCategory(db, id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

export function orderCategories(db: DB, ids: number[]): Category[] {
  const known = listCategories(db).map((c) => c.id);
  if (ids.length !== known.length || !known.every((id) => ids.includes(id))) {
    throw new CurationError(400, 'Reihenfolge muss alle Kategorien genau einmal enthalten');
  }
  const set = db.prepare('UPDATE categories SET position = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, position) => set.run(position, id)))();
  return listCategories(db);
}

type Definition = Pick<Category, 'fields' | 'groups' | 'groupedOnly'>;

/** Tag-Wert (vkey) -> Name des zusammengefassten Werts */
function groupMap(definition: Definition): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of definition.groups) for (const value of group.values) map.set(foldValue(value), group.label);
  return map;
}

/**
 * Alle Werte einer Kategorie mit Anzahl Titel. Zusammengefasste Werte zählen jeden Titel einmal,
 * auch wenn er mehrere der zugeordneten Tag-Werte trägt.
 */
export function categoryValues(db: DB, definition: Definition, q?: string): CategoryValue[] {
  if (definition.fields.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT vkey, min(value) AS value, count(DISTINCT track_id) AS trackCount FROM track_tags
       WHERE tag IN (SELECT value FROM json_each(?)) GROUP BY vkey`,
    )
    .all(JSON.stringify(definition.fields)) as Array<{ vkey: string; value: string; trackCount: number }>;
  const groups = groupMap(definition);
  const values: CategoryValue[] = [];
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const label = groups.get(row.vkey);
    if (label) grouped.set(label, [...(grouped.get(label) ?? []), row.vkey]);
    else if (!definition.groupedOnly) values.push({ value: row.value, trackCount: row.trackCount, grouped: false });
  }
  if (grouped.size > 0) {
    const count = db.prepare(
      `SELECT count(DISTINCT track_id) AS n FROM track_tags
       WHERE tag IN (SELECT value FROM json_each(?)) AND vkey IN (SELECT value FROM json_each(?))`,
    );
    for (const group of definition.groups) {
      const vkeys = grouped.get(group.label);
      if (!vkeys) continue;
      const { n } = count.get(JSON.stringify(definition.fields), JSON.stringify(vkeys)) as { n: number };
      const present = new Set(vkeys);
      values.push({
        value: group.label,
        trackCount: n,
        grouped: true,
        sources: group.values.filter((v) => present.has(foldValue(v))),
      });
    }
  }
  const needle = q ? foldValue(q) : '';
  return values
    .filter((v) => !needle || foldValue(v.value).includes(needle))
    .sort((a, b) => a.value.localeCompare(b.value, 'de', { sensitivity: 'base', numeric: true }));
}

/**
 * Filter für einen Wert der Kategorie: ein zusammengefasster Name steht für alle zugeordneten Tag-Werte.
 * Ein Tag-Wert, der in einer Gruppe steckt, ist nur noch über die Gruppe erreichbar.
 */
export function categoryFilter(definition: Definition, value: string): CategoryFilter | undefined {
  const key = foldValue(value);
  const group = definition.groups.find((g) => foldValue(g.label) === key);
  if (group) return { fields: definition.fields, vkeys: group.values.map(foldValue) };
  if (definition.groupedOnly || groupMap(definition).has(key)) return undefined;
  return { fields: definition.fields, vkeys: [key] };
}

/** Alle Tag-Felder der Bibliothek, für die Auswahl in der Verwaltung */
export function listTagFields(db: DB) {
  const fields = db
    .prepare(
      `SELECT tag, count(DISTINCT track_id) AS trackCount, count(DISTINCT vkey) AS valueCount
       FROM track_tags GROUP BY tag ORDER BY trackCount DESC, tag`,
    )
    .all() as Array<{ tag: string; trackCount: number; valueCount: number }>;
  const samples = db.prepare(
    `SELECT min(value) AS value FROM track_tags WHERE tag = ? GROUP BY vkey ORDER BY count(*) DESC LIMIT 5`,
  );
  return fields.map((field) => ({
    ...field,
    samples: (samples.all(field.tag) as Array<{ value: string }>).map((s) => s.value),
  }));
}

/** Aktueller Inhalt eines Tag-Felds: alle Werte mit Anzahl Titel, häufigste zuerst */
export function tagFieldValues(db: DB, tag: string, q: string | undefined, limit: number) {
  const params: Record<string, unknown> = { tag: tag.toLowerCase(), limit };
  let filter = '';
  if (q && foldValue(q)) {
    filter = "AND instr(vkey, @needle) > 0";
    params.needle = foldValue(q);
  }
  const { total } = db
    .prepare(`SELECT count(DISTINCT vkey) AS total FROM track_tags WHERE tag = @tag ${filter}`)
    .get(params) as { total: number };
  const items = db
    .prepare(
      `SELECT min(value) AS value, count(DISTINCT track_id) AS trackCount FROM track_tags WHERE tag = @tag ${filter}
       GROUP BY vkey ORDER BY trackCount DESC, vkey LIMIT @limit`,
    )
    .all(params) as Array<{ value: string; trackCount: number }>;
  return { total, items };
}
