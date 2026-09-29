import { ApiError, clearCache, type Album, type AlbumDetail } from '../api';

export interface AdminAlbum extends Album {
  kind: 'auto' | 'manual';
  hidden: boolean;
}

export interface AlbumFields {
  title: string | null;
  artist: string | null;
  year: number | null;
  genre: string | null;
}

export interface AdminAlbumDetail extends AlbumDetail {
  kind: 'auto' | 'manual';
  hidden: boolean;
  /** Vom Admin festgelegte Werte; null heißt automatisch */
  overrides: AlbumFields;
  /** Aus einem automatischen Album herausgenommene Titel */
  excluded: Array<{ id: number; title: string; artist: string; duration: number | null }>;
  /** Titel eines eigenen Albums, die gerade nicht in der Nextcloud liegen */
  missing: string[];
  rules: AlbumRule[];
  /** Titel, die über eine Regel statt von Hand im Album stehen */
  ruleTrackIds: number[];
  /** Titel eines automatischen Albums, die eine Regel in ein eigenes Album verschiebt */
  movedByRule: Array<{ id: number; title: string; artist: string; albumId: number; albumTitle: string }>;
}

export type RuleField = 'title' | 'artist' | 'album' | 'genre' | 'path';
export type RuleOp = 'contains' | 'not_contains' | 'starts' | 'equals';

export interface RuleLeaf {
  field: RuleField;
  op: RuleOp;
  value: string;
}

/** "all" = alle Bedingungen (UND), "any" = mindestens eine (ODER); beliebig verschachtelbar */
export interface RuleGroup {
  match: 'all' | 'any';
  conditions: RuleCondition[];
}

export type RuleCondition = RuleLeaf | RuleGroup;

export const isGroup = (condition: RuleCondition): condition is RuleGroup => 'match' in condition;

export interface AlbumRule {
  id: number;
  condition: RuleCondition;
  move: boolean;
}

export const RULE_FIELD_LABELS: Record<RuleField, string> = {
  title: 'Titel',
  artist: 'Interpret',
  album: 'Album (Tag)',
  genre: 'Genre',
  path: 'Ordner/Dateiname',
};

export const RULE_OP_LABELS: Record<RuleOp, string> = {
  contains: 'enthält',
  not_contains: 'enthält nicht',
  starts: 'beginnt mit',
  equals: 'ist genau',
};

/** Lesbare Form, z. B. Titel enthält „Predigt“ und (Interpret ist genau „A“ oder Interpret ist genau „B“) */
export function describeRule(condition: RuleCondition, nested = false): string {
  if (!isGroup(condition)) return `${RULE_FIELD_LABELS[condition.field]} ${RULE_OP_LABELS[condition.op]} „${condition.value}“`;
  const text = condition.conditions.map((c) => describeRule(c, true)).join(condition.match === 'all' ? ' und ' : ' oder ');
  return nested && condition.conditions.length > 1 ? `(${text})` : text;
}

/** Alle Bedingungen haben einen Suchbegriff und keine Gruppe ist leer */
export function isComplete(condition: RuleCondition): boolean {
  return isGroup(condition)
    ? condition.conditions.length > 0 && condition.conditions.every(isComplete)
    : condition.value.trim().length > 0;
}

const KEY = 'gemeinde.adminToken';

// Vorläufige Anmeldung mit dem ADMIN_TOKEN des Servers; wird durch OIDC ersetzt.
export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // Ohne Speicher bleibt man nur bis zum Neuladen angemeldet.
  }
  memoryToken = token;
}

let memoryToken = getToken();

export async function adminRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${memoryToken ?? ''}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `Fehler ${res.status}`);
  }
  // Nach Änderungen sollen Player-Seiten sofort den neuen Stand laden.
  if (method !== 'GET' && !url.endsWith('/preview')) clearCache();
  return (res.status === 204 ? undefined : await res.json()) as T;
}
