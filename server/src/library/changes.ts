import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';

/**
 * Änderungsprotokoll der Verwaltung: wer hat wann welches Album, welchen
 * Benutzer oder welche Einstellung geändert. Geschrieben wird nach jeder erfolgreichen Änderung
 * unter /api/admin; Lesezugriffe, Vorschauen und Verbindungstests zählen nicht.
 */

/** So viele Einträge bleiben erhalten; ältere fallen weg. */
export const MAX_CHANGES = 5000;

export interface Change {
  id: number;
  at: number;
  userId: number | null;
  userName: string;
  action: string;
  target: string | null;
  albumId: number | null;
}

export function recordChange(
  db: DB,
  entry: { userId: number | null; userName: string; action: string; target?: string | null; albumId?: number | null },
  now = Date.now(),
): void {
  const { id } = db
    .prepare('INSERT INTO changes (at, user_id, user_name, action, target, album_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .get(now, entry.userId, entry.userName, entry.action, entry.target ?? null, entry.albumId ?? null) as { id: number };
  if (id > MAX_CHANGES) db.prepare('DELETE FROM changes WHERE id <= ?').run(id - MAX_CHANGES);
}

const COLUMNS = 'id, at, user_id AS userId, user_name AS userName, action, target, album_id AS albumId';

export function listChanges(db: DB, limit: number, offset: number): { items: Change[]; total: number } {
  const { total } = db.prepare('SELECT count(*) AS total FROM changes').get() as { total: number };
  const items = db.prepare(`SELECT ${COLUMNS} FROM changes ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset) as Change[];
  return { items, total };
}

export function lastChange(db: DB, albumId: number): Change | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM changes WHERE album_id = ? ORDER BY id DESC LIMIT 1`).get(albumId) as
    | Change
    | undefined;
}

const FIELD_NAMES: Record<string, string> = {
  title: 'Name',
  artist: 'Interpret',
  year: 'Jahr',
  genre: 'Genre',
  speaker: 'Sprecher',
  passage: 'Bibelstelle',
  description: 'Beschreibung',
};

type Body = Record<string, unknown> | undefined;
type Params = Record<string, string | number | undefined>;
interface Described {
  action: string;
  /** Name des betroffenen Albums, Titels, Benutzers usw., vor der Änderung gelesen */
  target?: string | null;
  albumId?: number | null;
}

const one = (db: DB, sql: string, id: unknown) => (db.prepare(sql).get(id) as { name: string } | undefined)?.name ?? null;
const albumName = (db: DB, id: unknown) => one(db, 'SELECT title AS name FROM albums WHERE id = ?', id);
const trackName = (db: DB, id: unknown) => one(db, 'SELECT title AS name FROM tracks WHERE id = ?', id);

/**
 * Beschreibt eine Änderung in Worten, bevor sie ausgeführt wird (danach wäre z. B. ein gelöschtes
 * Album nicht mehr lesbar). undefined heißt: nicht protokollieren.
 */
function describe(db: DB, method: string, route: string, params: Params, body: Body): Described | undefined {
  const albumId = params.id !== undefined ? Number(params.id) : undefined;
  const album = () => ({ target: albumName(db, albumId), albumId });
  const key = `${method} ${route}`;
  switch (key) {
    case 'POST /api/admin/albums':
      return { action: 'Album angelegt', target: typeof body?.title === 'string' ? body.title : null };
    case 'PATCH /api/admin/albums/:id': {
      if (body?.hidden === true) return { action: 'Album ausgeblendet', ...album() };
      if (body?.hidden === false && Object.keys(body).length === 1) return { action: 'Album wieder eingeblendet', ...album() };
      const fields = Object.keys(body ?? {})
        .map((name) => FIELD_NAMES[name])
        .filter(Boolean);
      return { action: fields.length ? `Album bearbeitet (${fields.join(', ')})` : 'Album bearbeitet', ...album() };
    }
    case 'DELETE /api/admin/albums/:id':
      return { action: 'Album gelöscht', ...album() };
    case 'POST /api/admin/albums/:id/tracks': {
      const count = Array.isArray(body?.trackIds) ? body.trackIds.length : 0;
      return { action: count === 1 ? '1 Titel hinzugefügt' : `${count} Titel hinzugefügt`, ...album() };
    }
    case 'PUT /api/admin/albums/:id/tracks':
      return { action: 'Titel umsortiert', ...album() };
    case 'DELETE /api/admin/albums/:id/tracks/:trackId':
      return { action: `Titel herausgenommen: ${trackName(db, params.trackId) ?? '?'}`, ...album() };
    case 'POST /api/admin/albums/:id/tracks/:trackId/restore':
      return { action: `Titel zurückgeholt: ${trackName(db, params.trackId) ?? '?'}`, ...album() };
    case 'PATCH /api/admin/albums/:id/tracks/:trackId':
      return { action: `Titel bearbeitet: ${trackName(db, params.trackId) ?? '?'}`, ...album() };
    case 'PUT /api/admin/albums/:id/cover':
      return { action: 'Titelbild hochgeladen', ...album() };
    case 'DELETE /api/admin/albums/:id/cover':
      return { action: 'Titelbild entfernt', ...album() };
    case 'POST /api/admin/albums/:id/rules':
      return { action: 'Regel hinzugefügt', ...album() };
    case 'PUT /api/admin/albums/:id/rules/:ruleId':
      return { action: 'Regel geändert', ...album() };
    case 'DELETE /api/admin/albums/:id/rules/:ruleId':
      return { action: 'Regel gelöscht', ...album() };
    case 'PATCH /api/admin/users/:id':
      return {
        action: body?.disabled ? 'Benutzer gesperrt' : 'Benutzer entsperrt',
        target: one(db, 'SELECT name FROM users WHERE id = ?', params.id),
      };
    case 'DELETE /api/admin/users/:id':
      return { action: 'Benutzer entfernt', target: one(db, 'SELECT name FROM users WHERE id = ?', params.id) };
    case 'PUT /api/admin/groups/:name': {
      const action =
        body?.enabled === true ? 'Gruppe freigeschaltet' : body?.enabled === false ? 'Gruppe gesperrt' : 'Rolle der Gruppe geändert';
      return { action, target: String(params.name ?? '') };
    }
    case 'DELETE /api/admin/groups/:name':
      return { action: 'Gruppe entfernt', target: String(params.name ?? '') };
    case 'PUT /api/admin/structure':
      return { action: 'Zuordnung von Aufnahmen geändert' };
    case 'PUT /api/admin/branding':
      return { action: 'Name und Begrüßung geändert' };
    case 'PUT /api/admin/oidc':
      return { action: 'Anmeldung über das Gemeinde-Konto geändert' };
    case 'POST /api/scan':
      return body?.removeMissing ? { action: 'Fehlende Titel aus der Bibliothek entfernt' } : undefined;
    default:
      return undefined;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    change?: Described;
  }
}

/** Hängt das Protokoll an alle Änderungen der Verwaltung; nach der Anmeldung registrieren (braucht request.user). */
export function registerChangeLog(app: FastifyInstance, db: DB): void {
  app.addHook('preHandler', async (request: FastifyRequest) => {
    if (request.method === 'GET' || request.method === 'HEAD' || !request.user) return;
    const route = request.routeOptions.url;
    if (!route) return;
    try {
      request.change = describe(db, request.method, route, request.params as Params, request.body as Body);
    } catch (error) {
      request.log.warn({ err: error }, 'Änderung ließ sich nicht beschreiben');
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    if (!request.change || !request.user || reply.statusCode >= 400) return;
    try {
      recordChange(db, { userId: request.user.id, userName: request.user.name, ...request.change });
    } catch (error) {
      request.log.warn({ err: error }, 'Änderung ließ sich nicht protokollieren');
    }
  });
}
