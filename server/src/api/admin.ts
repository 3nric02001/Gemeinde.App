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
  setAlbumCover,
  setTracks,
  updateAlbum,
  updateTrack,
  MAX_COVER_UPLOAD,
  type AlbumFields,
  type TrackFields,
} from '../library/curation.js';
import { listChanges } from '../library/changes.js';
import {
  categoryValues,
  createCategory,
  deleteCategory,
  listCategories,
  listTagFields,
  tagFieldValues,
  MAX_FIELDS,
  MAX_GROUP_VALUES,
  MAX_GROUPS,
  orderCategories,
  updateCategory,
  type CategoryInput,
} from '../library/categories.js';
import { rebuildAlbums } from '../library/albums.js';
import { libraryQuality } from '../library/quality.js';
import {
  DEFAULT_STRUCTURE,
  getStructure,
  parseStructure,
  PLACEHOLDERS,
  previewStructure,
  saveStructure,
  StructureError,
} from '../library/structure.js';
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
  speaker: nullableText(200),
  passage: nullableText(200),
  description: nullableText(2000),
  hidden: { type: 'boolean' },
  recording: nullableText(60),
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

/** Verwaltung der Inhalte unter /api/admin; Zugriff für Manager und Admins (siehe requiredRole in auth.ts). */
export async function registerAdminRoutes(app: FastifyInstance, deps: { db: DB }): Promise<void> {
  const { db } = deps;

  await app.register(async (admin) => {
    admin.setErrorHandler((error, request, reply: FastifyReply) => {
      if (error instanceof CurationError) return reply.code(error.status).send({ error: error.message });
      if (error instanceof StructureError) return reply.code(400).send({ error: error.message });
      if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: (error as Error).message });
      // Von Fastify selbst, z. B. falscher Dateityp oder zu großes Bild beim Hochladen
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 415) return reply.code(415).send({ error: 'Bitte ein JPEG-, PNG- oder WebP-Bild hochladen' });
      if (status === 413) return reply.code(413).send({ error: 'Das Bild ist zu groß (höchstens 15 MB)' });
      if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (error as Error).message });
      request.log.error({ err: error }, 'Fehler im Admin-Bereich');
      return reply.code(500).send({ error: 'Interner Fehler' });
    });

    admin.get(
      '/api/admin/albums',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              q: { type: 'string', maxLength: 200 },
              kind: { type: 'string', enum: ['auto', 'manual'] },
              dated: { type: 'boolean' },
              hidden: { type: 'boolean' },
              noSpeaker: { type: 'boolean' },
              sort: { type: 'string', enum: ['title', 'artist', 'year', 'recent', 'date'], default: 'date' },
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

    admin.patch(
      '/api/admin/albums/:id/tracks/:trackId',
      {
        schema: {
          params: trackParam,
          body: {
            type: 'object',
            properties: {
              title: nullableText(300),
              speaker: nullableText(200),
              sermon: { type: ['boolean', 'null'] },
              player: { type: ['string', 'null'], enum: ['sermon', 'music', null] },
            },
            additionalProperties: false,
          },
        },
      },
      async (request: TrackRequest) => {
        updateTrack(db, request.params.id, request.params.trackId, request.body as TrackFields);
        return albumDetail(db, request.params.id);
      },
    );

    // Eigenes Titelbild: der Body ist das Bild selbst (Content-Type image/jpeg, image/png oder image/webp).
    admin.addContentTypeParser(
      ['image/jpeg', 'image/png', 'image/webp'],
      { parseAs: 'buffer', bodyLimit: MAX_COVER_UPLOAD },
      (_request, body, done) => done(null, body),
    );
    admin.put('/api/admin/albums/:id/cover', { schema: { params: idParam } }, async (request: IdRequest, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({ error: 'Bitte ein JPEG-, PNG- oder WebP-Bild hochladen' });
      }
      await setAlbumCover(db, request.params.id, request.body);
      return albumDetail(db, request.params.id);
    });
    admin.delete('/api/admin/albums/:id/cover', { schema: { params: idParam } }, async (request: IdRequest) => {
      await setAlbumCover(db, request.params.id, null);
      return albumDetail(db, request.params.id);
    });

    // Änderungsprotokoll; nur für Admins (siehe ADMIN_ONLY in auth.ts)
    admin.get(
      '/api/admin/changes',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { limit, offset } = request.query as { limit: number; offset: number };
        return { ...listChanges(db, limit, offset), limit, offset };
      },
    );

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

    // Hinweise, wo die automatische Zuordnung vermutlich nicht passt (Verwaltung → Prüfen)
    admin.get('/api/admin/quality', async () => libraryQuality(db));

    // Regelwerk für Aufnahmen (Verwaltung → Zuordnung), für Manager und Admins
    admin.get('/api/admin/structure', async () => ({
      structure: getStructure(db),
      defaults: DEFAULT_STRUCTURE,
      placeholders: PLACEHOLDERS,
    }));
    admin.post('/api/admin/structure/preview', async (request) => previewStructure(db, parseStructure(request.body)));
    admin.put('/api/admin/structure', async (request) => {
      const structure = parseStructure(request.body);
      saveStructure(db, structure);
      rebuildAlbums(db);
      return { structure };
    });

    // Aktueller Inhalt eines Tag-Felds, damit man beim Zuordnen sieht, was in den Dateien steht
    admin.get(
      '/api/admin/tag-fields/:tag/values',
      {
        schema: {
          params: { type: 'object', required: ['tag'], properties: { tag: { type: 'string', minLength: 1, maxLength: 60 } } },
          querystring: {
            type: 'object',
            properties: {
              q: { type: 'string', maxLength: 200 },
              limit: { type: 'integer', minimum: 1, maximum: 1000, default: 300 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { tag } = request.params as { tag: string };
        const { q, limit } = request.query as { q?: string; limit: number };
        return tagFieldValues(db, tag, q, limit);
      },
    );

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
