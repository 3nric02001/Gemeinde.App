import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import {
  addRule,
  addTracks,
  albumDetail,
  albumsOfTracks,
  createManualAlbum,
  CurationError,
  deleteManualAlbum,
  deleteRule,
  previewRule,
  toCondition,
  updateRule,
  type RuleInput,
  removeTrack,
  restoreTrack,
  setTracks,
  updateAlbum,
  type AlbumFields,
} from '../library/curation.js';
import {
  categoryValues,
  createCategory,
  deleteCategory,
  listCategories,
  listTagFields,
  MAX_FIELDS,
  MAX_GROUP_VALUES,
  MAX_GROUPS,
  orderCategories,
  updateCategory,
  type CategoryInput,
} from '../library/categories.js';
import { searchAlbums, type AlbumFilter } from '../library/queries.js';
import { RULE_FIELDS, RULE_OPS } from '../library/rules.js';

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;
const trackParam = {
  type: 'object',
  required: ['id', 'trackId'],
  properties: { id: { type: 'integer', minimum: 1 }, trackId: { type: 'integer', minimum: 1 } },
} as const;
const trackIds = { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 5000 } as const;
const nullableText = (max: number) => ({ type: ['string', 'null'], maxLength: max }) as const;
const albumFields = {
  title: nullableText(200),
  artist: nullableText(200),
  year: { type: ['integer', 'null'], minimum: 1000, maximum: 2999 },
  genre: nullableText(100),
  hidden: { type: 'boolean' },
} as const;

// Die Struktur verschachtelter Bedingungen prüft parseCondition, hier nur die äußere Form.
const ruleBody = {
  type: 'object',
  properties: {
    condition: { type: 'object' },
    field: { type: 'string', enum: RULE_FIELDS },
    op: { type: 'string', enum: RULE_OPS },
    value: { type: 'string', maxLength: 200 },
    move: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;
const ruleParam = {
  type: 'object',
  required: ['id', 'ruleId'],
  properties: { id: { type: 'integer', minimum: 1 }, ruleId: { type: 'integer', minimum: 1 } },
} as const;
type RuleRequest = FastifyRequest<{ Params: { id: number; ruleId: number } }>;

const categoryFields = {
  name: { type: 'string', minLength: 1, maxLength: 60 },
  fields: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, minItems: 1, maxItems: MAX_FIELDS },
  groups: {
    type: 'array',
    maxItems: MAX_GROUPS,
    items: {
      type: 'object',
      required: ['label', 'values'],
      properties: {
        label: { type: 'string', maxLength: 100 },
        values: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: MAX_GROUP_VALUES },
      },
      additionalProperties: false,
    },
  },
  inNav: { type: 'boolean' },
  groupedOnly: { type: 'boolean' },
} as const;

type IdRequest = FastifyRequest<{ Params: { id: number } }>;
type TrackRequest = FastifyRequest<{ Params: { id: number; trackId: number } }>;

/**
 * Admin-API unter /api/admin. `authorize` prüft vorerst das ADMIN_TOKEN;
 * mit OIDC wird daraus eine Rollenprüfung, die Routen bleiben gleich.
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: { db: DB; authorize: (request: FastifyRequest) => boolean },
): Promise<void> {
  const { db } = deps;

  await app.register(async (admin) => {
    admin.addHook('onRequest', async (request, reply) => {
      if (!deps.authorize(request)) return reply.code(401).send({ error: 'Admin-Token fehlt oder ist falsch' });
    });
    admin.setErrorHandler((error, request, reply: FastifyReply) => {
      if (error instanceof CurationError) return reply.code(error.status).send({ error: error.message });
      if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: (error as Error).message });
      request.log.error({ err: error }, 'Fehler im Admin-Bereich');
      return reply.code(500).send({ error: 'Interner Fehler' });
    });

    admin.get('/api/admin/session', async () => ({ ok: true }));

    admin.get(
      '/api/admin/albums',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              q: { type: 'string', maxLength: 200 },
              kind: { type: 'string', enum: ['auto', 'manual'] },
              sort: { type: 'string', enum: ['title', 'artist', 'year', 'recent'], default: 'title' },
              limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => searchAlbums(db, { ...(request.query as AlbumFilter), includeHidden: true }),
    );

    admin.post(
      '/api/admin/albums',
      {
        schema: {
          body: {
            type: 'object',
            required: ['title'],
            properties: {
              ...albumFields,
              title: { type: 'string', maxLength: 200 },
              trackIds,
              move: { type: 'boolean' },
              rules: { type: 'array', items: ruleBody, maxItems: 20 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const id = createManualAlbum(db, request.body as AlbumFields & { title: string; trackIds?: number[]; move?: boolean });
        return reply.code(201).send(albumDetail(db, id));
      },
    );

    admin.get('/api/admin/albums/:id', { schema: { params: idParam } }, async (request: IdRequest) =>
      albumDetail(db, request.params.id),
    );

    admin.patch(
      '/api/admin/albums/:id',
      { schema: { params: idParam, body: { type: 'object', properties: albumFields, additionalProperties: false } } },
      async (request: IdRequest) => {
        updateAlbum(db, request.params.id, request.body as AlbumFields);
        return albumDetail(db, request.params.id);
      },
    );

    admin.delete('/api/admin/albums/:id', { schema: { params: idParam } }, async (request: IdRequest, reply) => {
      deleteManualAlbum(db, request.params.id);
      return reply.code(204).send();
    });

    admin.post(
      '/api/admin/albums/:id/tracks',
      {
        schema: {
          params: idParam,
          body: {
            type: 'object',
            required: ['trackIds'],
            properties: { trackIds, move: { type: 'boolean' } },
            additionalProperties: false,
          },
        },
      },
      async (request: IdRequest) => {
        const { trackIds: ids, move } = request.body as { trackIds: number[]; move?: boolean };
        addTracks(db, request.params.id, ids, { move });
        return albumDetail(db, request.params.id);
      },
    );

    admin.put(
      '/api/admin/albums/:id/tracks',
      {
        schema: {
          params: idParam,
          body: { type: 'object', required: ['trackIds'], properties: { trackIds }, additionalProperties: false },
        },
      },
      async (request: IdRequest) => {
        setTracks(db, request.params.id, (request.body as { trackIds: number[] }).trackIds);
        return albumDetail(db, request.params.id);
      },
    );

    admin.delete('/api/admin/albums/:id/tracks/:trackId', { schema: { params: trackParam } }, async (request: TrackRequest) => {
      removeTrack(db, request.params.id, request.params.trackId);
      return albumDetail(db, request.params.id);
    });

    admin.post(
      '/api/admin/albums/:id/tracks/:trackId/restore',
      { schema: { params: trackParam } },
      async (request: TrackRequest) => {
        restoreTrack(db, request.params.id, request.params.trackId);
        return albumDetail(db, request.params.id);
      },
    );

    admin.post(
      '/api/admin/albums/:id/rules',
      { schema: { params: idParam, body: ruleBody } },
      async (request: IdRequest) => {
        addRule(db, request.params.id, request.body as RuleInput);
        return albumDetail(db, request.params.id);
      },
    );

    admin.put(
      '/api/admin/albums/:id/rules/:ruleId',
      { schema: { params: ruleParam, body: ruleBody } },
      async (request: RuleRequest) => {
        updateRule(db, request.params.id, request.params.ruleId, request.body as RuleInput);
        return albumDetail(db, request.params.id);
      },
    );

    admin.delete('/api/admin/albums/:id/rules/:ruleId', { schema: { params: ruleParam } }, async (request: RuleRequest) => {
      deleteRule(db, request.params.id, request.params.ruleId);
      return albumDetail(db, request.params.id);
    });

    // POST, weil verschachtelte Bedingungen nicht gut in eine URL passen
    admin.post('/api/admin/rules/preview', { schema: { body: ruleBody } }, async (request) =>
      previewRule(db, toCondition(request.body)),
    );

    admin.get('/api/admin/categories', async () => ({ items: listCategories(db) }));

    admin.post(
      '/api/admin/categories',
      {
        schema: {
          body: { type: 'object', required: ['name', 'fields'], properties: categoryFields, additionalProperties: false },
        },
      },
      async (request, reply) =>
        reply.code(201).send(createCategory(db, request.body as CategoryInput & { name: string; fields: string[] })),
    );

    admin.patch(
      '/api/admin/categories/:id',
      { schema: { params: idParam, body: { type: 'object', properties: categoryFields, additionalProperties: false } } },
      async (request: IdRequest) => updateCategory(db, request.params.id, request.body as CategoryInput),
    );

    admin.delete('/api/admin/categories/:id', { schema: { params: idParam } }, async (request: IdRequest, reply) => {
      deleteCategory(db, request.params.id);
      return reply.code(204).send();
    });

    admin.put(
      '/api/admin/categories/order',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            properties: { ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 100 } },
            additionalProperties: false,
          },
        },
      },
      async (request) => ({ items: orderCategories(db, (request.body as { ids: number[] }).ids) }),
    );

    // Werte einer (noch nicht gespeicherten) Kategorie, während man sie einrichtet
    admin.post(
      '/api/admin/categories/preview',
      {
        schema: {
          body: {
            type: 'object',
            required: ['fields'],
            properties: { fields: categoryFields.fields, groups: categoryFields.groups, groupedOnly: categoryFields.groupedOnly },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const body = request.body as { fields: string[]; groups?: CategoryInput['groups']; groupedOnly?: boolean };
        const values = categoryValues(db, {
          fields: body.fields.map((f) => f.toLowerCase()),
          groups: (body.groups ?? []).filter((g) => g.label.trim()),
          groupedOnly: body.groupedOnly ?? false,
        });
        return { total: values.length, items: values.slice(0, 200) };
      },
    );

    admin.get('/api/admin/tag-fields', async () => ({ items: listTagFields(db) }));

    admin.get(
      '/api/admin/track-albums',
      {
        schema: {
          querystring: {
            type: 'object',
            required: ['ids'],
            properties: { ids: { type: 'string', pattern: '^\\d+(,\\d+){0,499}$' } },
            additionalProperties: false,
          },
        },
      },
      async (request) => albumsOfTracks(db, (request.query as { ids: string }).ids.split(',').map(Number)),
    );
  });
}
