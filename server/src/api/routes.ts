import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getMeta, type DB } from '../db.js';
import { categoryFilter, categoryValues, getListenerCategory, listCategories } from '../library/categories.js';
import { datedAlbumForFolder, listDatedAlbums } from '../library/dates.js';
import type { LibraryScanner } from '../library/scanner.js';
import type { CoverThumbnails } from '../library/thumbnails.js';
import type { NextcloudClient } from '../nextcloud/webdav.js';
import { registerAdminRoutes } from './admin.js';
import { registerMeRoutes } from './me.js';
import { popularAlbums, popularSearches } from '../library/searches.js';
import {
  getAlbum,
  getAlbumCover,
  getCoverImage,
  getFacets,
  getTrackCover,
  getTrackFile,
  listArtists,
  searchAlbums,
  searchTracks,
  ALBUM_SORTS,
  type AlbumFilter,
  type CoverSource,
} from '../library/queries.js';

export interface RouteDeps {
  db: DB;
  client: NextcloudClient;
  scanner: LibraryScanner;
  thumbnails: CoverThumbnails;
  /** Abweichende Wartezeit bis zur ersten Antwort der Nextcloud (Tests) */
  streamTimeoutMs?: number;
}

const paging = {
  limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
  offset: { type: 'integer', minimum: 0, default: 0 },
} as const;
const filters = {
  q: { type: 'string', maxLength: 200 },
  artist: { type: 'string', maxLength: 200 },
  genre: { type: 'string', maxLength: 100 },
  year: { type: 'integer', minimum: 1000, maximum: 2999 },
  decade: { type: 'integer', minimum: 1000, maximum: 2990, multipleOf: 10 },
  // Wert einer Kategorie: category=interpreten&value=Chor
  category: { type: 'string', maxLength: 60 },
  value: { type: 'string', maxLength: 200 },
} as const;
const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

/** So lange darf die Nextcloud brauchen, bis eine Datei zu fließen beginnt. */
export const UPSTREAM_TIMEOUT_MS = 15_000;

/** Header, die beim Streaming von der Nextcloud an den Browser durchgereicht werden. */
const PASS_THROUGH = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

type IdRequest = FastifyRequest<{ Params: { id: number } }>;
type SlugRequest = FastifyRequest<{ Params: { slug: string }; Querystring: { q?: string } }>;
type CategoryQuery = { category?: string; value?: string };

/** category/value aus der Anfrage in einen Filter übersetzen; null heißt "kein Treffer möglich". */
function withCategory<T extends CategoryQuery>(db: DB, query: T) {
  const { category, value, ...rest } = query;
  if (category === undefined && value === undefined) return rest;
  const definition = category !== undefined ? getListenerCategory(db, category) : undefined;
  const filter = definition && value !== undefined ? categoryFilter(definition, value) : undefined;
  return filter ? { ...rest, category: filter } : null;
}

async function proxyFile(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  fallbackType: string | null,
): Promise<FastifyReply> {
  const controller = new AbortController();
  // Bricht der Hörer ab (Skip, Tab zu), soll auch der Download aus der Nextcloud enden.
  // Nicht request.raw: dessen 'close' feuert, sobald die Anfrage gelesen ist, nicht erst beim Abbruch.
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  const headers: Record<string, string> = {};
  if (typeof request.headers.range === 'string') headers.Range = request.headers.range;

  // Nur bis die Antwort beginnt; das Streamen selbst darf so lange dauern wie der Titel.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.streamTimeoutMs ?? UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await deps.client.get(path, headers, controller.signal);
  } catch (error) {
    if (reply.raw.destroyed) return reply;
    request.log.warn({ err: error, path, timedOut }, 'Nextcloud-Abruf fehlgeschlagen');
    return reply
      .code(timedOut ? 504 : 502)
      .send({ error: timedOut ? 'Nextcloud antwortet nicht' : 'Nextcloud nicht erreichbar' });
  } finally {
    clearTimeout(timer);
  }
  if (upstream.status === 404) return reply.code(404).send({ error: 'Datei nicht mehr in der Nextcloud vorhanden' });
  if (upstream.status === 416) return reply.code(416).send();
  if (!upstream.ok || !upstream.body) {
    request.log.warn({ status: upstream.status, path }, 'Nextcloud-Abruf fehlgeschlagen');
    return reply.code(502).send({ error: 'Nextcloud nicht erreichbar' });
  }

  reply.code(upstream.status);
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name);
    if (value) reply.header(name, value);
  }
  if (!upstream.headers.get('content-type') && fallbackType) reply.header('content-type', fallbackType);
  reply.header('cache-control', 'private, max-age=3600');
  return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
}

async function sendCover(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  source: CoverSource | undefined,
): Promise<FastifyReply> {
  if (!source) return reply.code(404).send({ error: 'Kein Cover vorhanden' });
  const thumb = await deps.thumbnails.get(source);
  if (thumb) {
    reply.header('etag', thumb.etag).header('cache-control', 'private, max-age=86400');
    if (request.headers['if-none-match'] === thumb.etag) return reply.code(304).send();
    return reply.type('image/webp').send(thumb.data);
  }
  // Nicht verkleinerbar (z. B. sehr groß oder unbekanntes Format): das Original wie bisher.
  if ('path' in source) return proxyFile(deps, request, reply, source.path, null);
  const image = getCoverImage(deps.db, source.coverId);
  if (!image) return reply.code(404).send({ error: 'Kein Cover vorhanden' });
  const etag = `"${image.hash.slice(0, 32)}"`;
  reply.header('etag', etag).header('cache-control', 'private, max-age=86400');
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.type(image.mime).send(image.data);
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, scanner } = deps;

  // Für Docker: prüft, ob die Datenbank antwortet. Die Nextcloud bewusst nicht, sonst startete Docker
  // den Container bei jeder Nextcloud-Wartung neu; ihren Zustand zeigt die Verwaltung.
  app.get('/api/health', async (request, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { status: 'ok' };
    } catch (error) {
      request.log.error({ err: error }, 'Datenbank antwortet nicht');
      return reply.code(503).send({ status: 'error' });
    }
  });

  app.get(
    '/api/tracks',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { ...filters, ...paging, albumId: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const query = request.query as Parameters<typeof searchTracks>[1] & CategoryQuery & { limit: number; offset: number };
      const filter = withCategory(db, query);
      if (!filter) return { items: [], total: 0, limit: query.limit, offset: query.offset };
      return searchTracks(db, filter as Parameters<typeof searchTracks>[1]);
    },
  );

  app.get(
    '/api/albums',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...filters,
            ...paging,
            sort: { type: 'string', enum: ALBUM_SORTS, default: 'artist' },
            dated: { type: 'boolean' },
            recording: { type: 'string', maxLength: 60 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const query = request.query as Omit<AlbumFilter, 'category'> & CategoryQuery;
      const filter = withCategory(db, query);
      if (!filter) return { items: [], total: 0, limit: query.limit, offset: query.offset };
      return searchAlbums(db, filter as AlbumFilter);
    },
  );

  app.get('/api/albums/:id', { schema: { params: idParam } }, async (request: IdRequest, reply) => {
    const album = getAlbum(db, request.params.id);
    return album ?? reply.code(404).send({ error: 'Album nicht gefunden' });
  });

  app.get('/api/albums/:id/cover', { schema: { params: idParam } }, async (request: IdRequest, reply) => {
    return sendCover(deps, request, reply, getAlbumCover(db, request.params.id));
  });

  app.get('/api/tracks/:id/cover', { schema: { params: idParam } }, async (request: IdRequest, reply) => {
    return sendCover(deps, request, reply, getTrackCover(db, request.params.id));
  });

  app.get('/api/tracks/:id/stream', { schema: { params: idParam } }, async (request: IdRequest, reply) => {
    const track = getTrackFile(db, request.params.id);
    if (!track) return reply.code(404).send({ error: 'Titel nicht gefunden' });
    return proxyFile(deps, request, reply, track.path, track.mime);
  });

  app.get(
    '/api/artists',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { q: filters.q, ...paging },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { q, limit, offset } = request.query as { q?: string; limit: number; offset: number };
      return listArtists(db, q, limit, offset);
    },
  );

  app.get('/api/facets', async () => getFacets(db));

  // Für die leere Suchseite: Begriffe, die mehrere gesucht haben, und oft gehörte Alben.
  app.get('/api/search/suggestions', async () => ({ searches: popularSearches(db), albums: popularAlbums(db) }));

  // Frei definierbare Kategorien (in der Verwaltung angelegt)
  app.get('/api/categories', async () => ({
    items: listCategories(db).map(({ id, name, slug, inNav }) => ({ id, name, slug, inNav })),
  }));

  app.get(
    '/api/categories/:slug/values',
    {
      schema: {
        params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string', maxLength: 60 } } },
        querystring: { type: 'object', properties: { q: filters.q }, additionalProperties: false },
      },
    },
    async (request: SlugRequest, reply) => {
      const category = getListenerCategory(db, request.params.slug);
      if (!category) return reply.code(404).send({ error: 'Kategorie nicht gefunden' });
      const { id, name, slug, inNav } = category;
      return { category: { id, name, slug, inNav }, items: categoryValues(db, category, request.query.q) };
    },
  );

  // Alben mit Datum (Gottesdienste, Aufnahmen), neueste zuerst
  app.get(
    '/api/dates',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { ...paging, limit: { ...paging.limit, maximum: 1000 }, recording: { type: 'string', maxLength: 60 } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { limit, offset, recording } = request.query as { limit: number; offset: number; recording?: string };
      return listDatedAlbums(db, limit, offset, recording);
    },
  );

  app.get(
    '/api/dates/folder',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', maxLength: 2000 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { path } = request.query as { path: string };
      const album = datedAlbumForFolder(db, path);
      if (!album) return reply.code(404).send({ error: 'Ordner nicht gefunden' });
      return album;
    },
  );

  app.get('/api/scan', async () => ({
    ...scanner.getStatus(),
    lastSuccessAt: getMeta(db, 'lastScanAt') ?? null,
    // Die gescannten Ordner, wie in NEXTCLOUD_MUSIC_PATH angegeben
    folders: deps.client.musicPaths.map((path) => path || '/'),
  }));

  // Nur Manager und Admins (siehe requiredRole)
  app.post(
    '/api/scan',
    {
      schema: {
        body: {
          type: ['object', 'null'],
          // Auch ungewöhnlich viele fehlende Titel entfernen (nach Rückfrage in der Verwaltung)
          properties: { removeMissing: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const alreadyRunning = scanner.isRunning();
      void scanner.scan({ removeMissing: (request.body as { removeMissing?: boolean } | null)?.removeMissing === true });
      return reply.code(202).send({ started: !alreadyRunning, status: scanner.getStatus() });
    },
  );

  await registerAdminRoutes(app, { db });
  await registerMeRoutes(app, { db });
}
