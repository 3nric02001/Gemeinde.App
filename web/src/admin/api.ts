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
export type RuleOp = 'contains' | 'starts' | 'equals';

export interface AlbumRule {
  id: number;
  field: RuleField;
  op: RuleOp;
  value: string;
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
  starts: 'beginnt mit',
  equals: 'ist genau',
};

export function describeRule(rule: Pick<AlbumRule, 'field' | 'op' | 'value'>): string {
  return `${RULE_FIELD_LABELS[rule.field]} ${RULE_OP_LABELS[rule.op]} „${rule.value}“`;
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
  if (method !== 'GET') clearCache();
  return (res.status === 204 ? undefined : await res.json()) as T;
}
