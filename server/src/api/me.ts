import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { markOnboarded } from '../auth/users.js';
import { recordPlay } from '../library/popularity.js';
import { recordSearch } from '../library/searches.js';
import { getOfflineSettings, offlineKey } from '../offline.js';
import {
  datedStates,
  listenerHome,
  listFavorites,
  listProgress,
  markAlbumHeard,
  markDatesSeen,
  saveProgress,
  setFavorite,
  type FavoriteKind,
} from '../library/listener.js';

const favoriteParams = {
  type: 'object',
  required: ['kind', 'id'],
  properties: { kind: { type: 'string', enum: ['track', 'album'] }, id: { type: 'integer', minimum: 1 } },
} as const;

type FavoriteRequest = FastifyRequest<{ Params: { kind: FavoriteKind; id: number } }>;

/** Das Persönliche des angemeldeten Hörers; die Sitzung prüft der Hook in registerAuth. */
export async function registerMeRoutes(app: FastifyInstance, { db }: { db: DB }): Promise<void> {
  const userId = (request: FastifyRequest) => request.user!.id;

  app.get('/api/me/favorites', async (request) => listFavorites(db, userId(request)));

  const toggle = (on: boolean) => async (request: FavoriteRequest, reply: FastifyReply) => {
    const { kind, id } = request.params;
    if (!setFavorite(db, userId(request), kind, id, on)) {
      return reply.code(404).send({ error: kind === 'track' ? 'Titel nicht gefunden' : 'Album nicht gefunden' });
    }
    return reply.code(204).send();
  };
  app.put('/api/me/favorites/:kind/:id', { schema: { params: favoriteParams } }, toggle(true));
  app.delete('/api/me/favorites/:kind/:id', { schema: { params: favoriteParams } }, toggle(false));

  // Die kurze Einführung beim ersten Öffnen ist gesehen (oder übersprungen); gilt auf allen Geräten.
  app.post('/api/me/onboarding', async (request, reply) => {
    markOnboarded(db, userId(request));
    return reply.code(204).send();
  });

  app.get('/api/me/progress', async (request) => ({ items: listProgress(db, userId(request)) }));

  app.put(
    '/api/me/progress/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
        body: {
          type: 'object',
          required: ['position'],
          properties: {
            position: { type: 'number', minimum: 0, maximum: 1e6 },
            duration: { type: 'number', minimum: 0, maximum: 1e6 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: number }; Body: { position: number; duration?: number } }>, reply) => {
      const { position, duration } = request.body;
      if (!saveProgress(db, userId(request), request.params.id, position, duration)) {
        return reply.code(404).send({ error: 'Titel nicht gefunden' });
      }
      return reply.code(204).send();
    },
  );

  // Zählt eine Wiedergabe fürs verdeckte Scoring; der Player meldet sie, sobald genug gehört wurde.
  app.post(
    '/api/me/plays/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply) => {
      if (!recordPlay(db, userId(request), request.params.id)) return reply.code(404).send({ error: 'Titel nicht gefunden' });
      return reply.code(204).send();
    },
  );

  // Suchbegriff, aus dem ein Treffer geöffnet wurde, für "Häufig gesucht" (nur gezählt, nie einzeln gezeigt).
  app.post(
    '/api/me/searches',
    {
      schema: {
        body: { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 200 } }, additionalProperties: false },
      },
    },
    async (request: FastifyRequest<{ Body: { q: string } }>, reply) => {
      recordSearch(db, userId(request), request.body.q);
      return reply.code(204).send();
    },
  );

  // Schlüssel für offline gespeicherte Titel. Jeder erfolgreiche Abruf verlängert die Offline-Frist in der App.
  app.get('/api/me/offline', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const settings = getOfflineSettings(db);
    if (!settings.enabled) return { enabled: false, days: settings.days };
    return { enabled: true, days: settings.days, ...offlineKey(db, userId(request)) };
  });

  app.get('/api/me/home', async (request) => listenerHome(db, userId(request)));

  // Neu, angefangen, gehört je Gottesdienst (Liste unter "Datum", Punkt am Tab)
  app.get('/api/me/dates', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return datedStates(db, userId(request));
  });
  app.post('/api/me/dates/seen', async (request, reply) => {
    markDatesSeen(db, userId(request));
    return reply.code(204).send();
  });
  app.put(
    '/api/me/albums/:id/heard',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
        body: { type: 'object', required: ['heard'], properties: { heard: { type: 'boolean' } }, additionalProperties: false },
      },
    },
    async (request: FastifyRequest<{ Params: { id: number }; Body: { heard: boolean } }>, reply) => {
      if (!markAlbumHeard(db, userId(request), request.params.id, request.body.heard)) {
        return reply.code(404).send({ error: 'Album nicht gefunden' });
      }
      return reply.code(204).send();
    },
  );
}
