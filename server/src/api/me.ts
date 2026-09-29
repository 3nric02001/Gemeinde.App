import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { listenerHome, listFavorites, listProgress, saveProgress, setFavorite, type FavoriteKind } from '../library/listener.js';

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

  app.get('/api/me/home', async (request) => listenerHome(db, userId(request)));
}
