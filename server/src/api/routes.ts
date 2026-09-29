import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getMeta, type DB } from '../db.js';
import { datedFolderTrackIds, listDatedFolders } from '../library/dates.js';
import type { LibraryScanner } from '../library/scanner.js';
import type { NextcloudClient } from '../nextcloud/webdav.js';
import { registerAdminRoutes } from './admin.js';
import {
  getAlbum,
  getAlbumCover,
  getCoverImage,
  getFacets,
  getTrackCover,
  getTrackFile,
  getTracksByIds,
  listArtists,
  searchAlbums,
  searchTracks,
  type AlbumFilter,
  type CoverSource,
} from '../library/queries.js';

export interface RouteDeps {
  db: DB;
  client: NextcloudClient;
  scanner: LibraryScanner;
  adminToken: string | undefined;
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
} as const;
const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

/** Header, die beim Streaming von der Nextcloud an den Browser durchgereicht werden. */
const PASS_THROUGH = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

type IdRequest = FastifyRequest<{ Params: { id: number } }>;

function isAdmin(request: FastifyRequest, adminToken: string | undefined): boolean {
  if (!adminToken) return false;
  const header = request.headers.authorization ?? '';
  const provided = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(adminToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
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

  const upstream = await deps.client.get(path, headers, controller.signal);
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

  app.get('/api/health', async () => ({ status: 'ok' }));

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
    async (request) => searchTracks(db, request.query as Parameters<typeof searchTracks>[1]),
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
            sort: { type: 'string', enum: ['title', 'artist', 'year', 'recent'], default: 'artist' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => searchAlbums(db, request.query as AlbumFilter),
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

  // Unterste Ordner mit Datum im Namen, z. B. Gottesdienst-Aufnahmen
  app.get(
    '/api/dates',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { ...paging, limit: { ...paging.limit, maximum: 1000 } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { limit, offset } = request.query as { limit: number; offset: number };
      const folders = listDatedFolders(db);
      return { items: folders.slice(offset, offset + limit), total: folders.length, limit, offset };
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
      const folder = listDatedFolders(db).find((f) => f.folder === path);
      if (!folder) return reply.code(404).send({ error: 'Ordner nicht gefunden' });
      return { ...folder, tracks: getTracksByIds(db, datedFolderTrackIds(db, folder.folder)) };
    },
  );

  app.get('/api/scan', async () => ({ ...scanner.getStatus(), lastSuccessAt: getMeta(db, 'lastScanAt') ?? null }));

  app.post('/api/scan', async (request, reply) => {
    if (!isAdmin(request, deps.adminToken)) return reply.code(401).send({ error: 'Admin-Token fehlt oder ist falsch' });
    const alreadyRunning = scanner.isRunning();
    void scanner.scan();
    return reply.code(202).send({ started: !alreadyRunning, status: scanner.getStatus() });
  });

  await registerAdminRoutes(app, { db, authorize: (request) => isAdmin(request, deps.adminToken) });
}
