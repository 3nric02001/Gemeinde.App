import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import {
  addTracks,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  leavePlaylist,
  listPlaylists,
  MAX_PLAYLIST_TRACKS,
  MAX_TITLE,
  PlaylistError,
  renamePlaylist,
  setShares,
  setTracks,
  shareablePeople,
} from '../library/playlists.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;
const ids = (max: number) => ({ type: 'array', maxItems: max, items: { type: 'integer', minimum: 1 } }) as const;
const title = { type: 'string', maxLength: MAX_TITLE * 2 } as const;

type IdRequest<Body = unknown> = FastifyRequest<{ Params: { id: number }; Body: Body }>;

/** Fehler wie "nicht gefunden" oder "nur der Besitzer" als Antwort mit passendem Status */
function guard<R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) {
  return async (request: R, reply: FastifyReply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error instanceof PlaylistError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  };
}

/** Eigene Playlists des angemeldeten Hörers und die, die andere mit ihm teilen */
export async function registerPlaylistRoutes(app: FastifyInstance, { db }: { db: DB }): Promise<void> {
  const userId = (request: FastifyRequest) => request.user!.id;

  app.get('/api/me/playlists', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return listPlaylists(db, userId(request));
  });

  // Mit wem man teilen kann (nur Namen)
  app.get('/api/me/people', async (request) => ({ items: shareablePeople(db, userId(request)) }));

  app.post(
    '/api/me/playlists',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title'],
          properties: { title, trackIds: ids(MAX_PLAYLIST_TRACKS) },
          additionalProperties: false,
        },
      },
    },
    guard(async (request: FastifyRequest<{ Body: { title: string; trackIds?: number[] } }>, reply) => {
      const id = createPlaylist(db, userId(request), request.body.title, request.body.trackIds);
      return reply.code(201).send(getPlaylist(db, userId(request), id));
    }),
  );

  app.get('/api/me/playlists/:id', { schema: { params: idParams } }, async (request: IdRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const playlist = getPlaylist(db, userId(request), request.params.id);
    return playlist ?? reply.code(404).send({ error: 'Playlist nicht gefunden' });
  });

  app.patch(
    '/api/me/playlists/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', required: ['title'], properties: { title }, additionalProperties: false },
      },
    },
    guard(async (request: IdRequest<{ title: string }>, reply) => {
      renamePlaylist(db, userId(request), request.params.id, request.body.title);
      return reply.code(204).send();
    }),
  );

  // Eigene Playlist löschen; eine geteilte nur für sich entfernen
  app.delete('/api/me/playlists/:id', { schema: { params: idParams } }, async (request: IdRequest, reply) => {
    const playlist = getPlaylist(db, userId(request), request.params.id);
    if (!playlist) return reply.code(404).send({ error: 'Playlist nicht gefunden' });
    if (playlist.mine) deletePlaylist(db, userId(request), request.params.id);
    else leavePlaylist(db, userId(request), request.params.id);
    return reply.code(204).send();
  });

  app.post(
    '/api/me/playlists/:id/tracks',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['trackIds'],
          properties: { trackIds: { ...ids(MAX_PLAYLIST_TRACKS), minItems: 1 } },
          additionalProperties: false,
        },
      },
    },
    guard(async (request: IdRequest<{ trackIds: number[] }>) => ({
      added: addTracks(db, userId(request), request.params.id, request.body.trackIds),
    })),
  );

  app.put(
    '/api/me/playlists/:id/tracks',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['trackIds'],
          properties: { trackIds: ids(MAX_PLAYLIST_TRACKS) },
          additionalProperties: false,
        },
      },
    },
    guard(async (request: IdRequest<{ trackIds: number[] }>, reply) => {
      setTracks(db, userId(request), request.params.id, request.body.trackIds);
      return reply.code(204).send();
    }),
  );

  app.put(
    '/api/me/playlists/:id/shares',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['userIds'],
          properties: { userIds: ids(1000) },
          additionalProperties: false,
        },
      },
    },
    guard(async (request: IdRequest<{ userIds: number[] }>) => ({
      sharedWith: setShares(db, userId(request), request.params.id, request.body.userIds),
    })),
  );
}
