import { ApiError, clearCache, type Album, type AlbumDetail } from '../api';
import { sessionExpired } from '../auth';

export interface AdminAlbum extends Album {
  kind: 'auto' | 'manual';
  hidden: boolean;
}

export interface AlbumFields {
  title: string | null;
  year: number | null;
  speaker: string | null;
  passage: string | null;
  description: string | null;
  /** Art der Aufnahme von Hand; "" heißt keine Art, null: nach dem Regelwerk */
  recording?: string | null;
}

export interface AdminAlbumDetail extends AlbumDetail {
  /** Art von Hand ("" = keine Art), null: nach dem Regelwerk (Verwaltung → Zuordnung) */
  manualRecording?: string | null;
  /** Woher die Art kommt: von Hand, Regel in „Art bestimmen“, Vorgabe für Ordner mit Datum oder keine */
  recordingSource?: { by: 'manual' } | { by: 'rule'; rule: string } | { by: 'default' } | { by: 'none' };
  kind: 'auto' | 'manual';
  hidden: boolean;
  /** Vom Admin festgelegte Werte; null heißt automatisch */
  overrides: AlbumFields;
  /** Aus einem automatischen Album herausgenommene Titel */
  excluded: Array<{ id: number; title: string; duration: number | null }>;
  /** Titel eines eigenen Albums, die gerade nicht in der Nextcloud liegen */
  missing: string[];
  rules: AlbumRule[];
  /** Titel, die über eine Regel statt von Hand im Album stehen */
  ruleTrackIds: number[];
  /** Titel eines automatischen Albums, die eine Regel in ein eigenes Album verschiebt */
  movedByRule: Array<{ id: number; title: string; albumId: number; albumTitle: string }>;
  /** Je Titel: Name und Sprecher aus der Datei und die Korrekturen der Verwaltung */
  trackEdits: TrackEdit[];
  /** Albumordner in der Nextcloud; bei Gottesdiensten kommt das Datum aus seinem Namen */
  folder: string;
  /** Ein eigenes Titelbild ist hochgeladen */
  customCover: boolean;
  /** Letzte Änderung an diesem Album in der Verwaltung */
  lastChange: Change | null;
}

export interface TrackEdit {
  id: number;
  fileTitle: string;
  title: string | null;
  speaker: string | null;
  fileSpeaker: string | null;
  /** Korrektur: gilt als Predigt; null: nach den Policies */
  sermon?: boolean | null;
  /** Korrektur des Players; null: nach den Policies */
  player?: 'sermon' | 'music' | null;
  /** Was die Policies im Regelwerk ergeben, mit Namen der Policy */
  auto?: { sermon?: boolean; sermonBy?: string; player?: 'sermon' | 'music'; playerBy?: string; content?: string; contentBy?: string };
}

/** Felder, die sich je Titel korrigieren lassen; null heißt automatisch */
export interface TrackFields {
  title?: string | null;
  speaker?: string | null;
  sermon?: boolean | null;
  player?: 'sermon' | 'music' | null;
}

export interface Change {
  id: number;
  at: number;
  userId: number | null;
  userName: string;
  action: string;
  target: string | null;
  albumId: number | null;
}

export type RuleField = 'title' | 'album' | 'content' | 'speaker' | 'path';
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
  album: 'Album (Ordner)',
  content: 'Inhalt',
  speaker: 'Sprecher',
  path: 'Ordner/Dateiname',
};

export const RULE_OP_LABELS: Record<RuleOp, string> = {
  contains: 'enthält',
  not_contains: 'enthält nicht',
  starts: 'beginnt mit',
  equals: 'ist genau',
};

/** Lesbare Form, z. B. Titel enthält „Predigt“ und (Sprecher ist genau „A“ oder Sprecher ist genau „B“) */
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

export async function adminRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  // Die Sitzung steckt im Cookie; Rechte prüft der Server anhand der Rolle.
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) sessionExpired();
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `Fehler ${res.status}`);
  }
  // Nach Änderungen sollen Player-Seiten sofort den neuen Stand laden.
  if (method !== 'GET' && !url.endsWith('/preview')) clearCache();
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Lädt ein Bild hoch; der Body ist die Datei selbst (siehe PUT /api/admin/albums/:id/cover). */
export async function adminUpload<T>(url: string, file: Blob): Promise<T> {
  const res = await fetch(url, { method: 'PUT', headers: { accept: 'application/json', 'content-type': file.type }, body: file });
  if (res.status === 401) sessionExpired();
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `Fehler ${res.status}`);
  }
  clearCache();
  return (await res.json()) as T;
}

/** Kategorie mit Zuordnung, wie die Verwaltung sie bearbeitet */
export interface AdminCategory {
  id: number;
  name: string;
  slug: string;
  position: number;
  inNav: boolean;
  /** Nur zusammengefasste Werte zeigen */
  groupedOnly: boolean;
  /** Felder aus Ordner- und Dateinamen, aus denen die Werte kommen (art, inhalt, sprecher …) */
  fields: string[];
  /** Zusammengefasste Werte: label <- values */
  groups: Array<{ label: string; values: string[] }>;
}

/** Feld aus Ordner- und Dateinamen, aus dem Kategorien ihre Werte nehmen (Art, Inhalt, Sprecher …) */
export interface TagField {
  tag: string;
  label: string;
  hint: string;
  trackCount: number;
  valueCount: number;
  samples: string[];
}

/** Lesbare Namen der Felder aus Ordner- und Dateinamen (wie server/src/library/fields.ts) */
export const TAG_LABELS: Record<string, string> = {
  art: 'Art',
  inhalt: 'Inhalt',
  sprecher: 'Sprecher',
  anlass: 'Anlass',
  jahr: 'Jahr',
};

export const tagLabel = (tag: string) => TAG_LABELS[tag] ?? tag;

/** "Musik, Lied" -> ["Musik", "Lied"] */
export const splitValues = (text: string) =>
  text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
