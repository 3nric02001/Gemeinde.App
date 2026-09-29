import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { OidcService, OidcSettings } from '../auth/oidc.js';
import { deleteGroup, deleteUser, listGroups, listUsers, ROLES, saveGroup, setUserDisabled, type Role } from '../auth/users.js';
import { authErrorHandler, redirectUri } from './auth.js';

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;
const nameParam = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

type IdRequest = FastifyRequest<{ Params: { id: number } }>;
type NameRequest = FastifyRequest<{ Params: { name: string } }>;

/** Benutzer, Gruppen und OIDC-Schnittstelle; nur für Admins (siehe requiredRole). */
export async function registerUserAdminRoutes(
  app: FastifyInstance,
  deps: { db: DB; oidc: OidcService; publicUrl: string | undefined },
): Promise<void> {
  const { db, oidc } = deps;

  await app.register(async (admin) => {
    admin.setErrorHandler(authErrorHandler);

    admin.get('/api/admin/users', async () => ({ items: listUsers(db) }));

    admin.patch(
      '/api/admin/users/:id',
      {
        schema: {
          params: idParam,
          body: {
            type: 'object',
            required: ['disabled'],
            properties: { disabled: { type: 'boolean' } },
            additionalProperties: false,
          },
        },
      },
      async (request: IdRequest) => {
        setUserDisabled(db, request.params.id, (request.body as { disabled: boolean }).disabled);
        return { items: listUsers(db) };
      },
    );

    admin.delete('/api/admin/users/:id', { schema: { params: idParam } }, async (request: IdRequest, reply) => {
      deleteUser(db, request.params.id);
      return reply.code(204).send();
    });

    admin.get('/api/admin/groups', async () => ({ items: listGroups(db) }));

    admin.put(
      '/api/admin/groups/:name',
      {
        schema: {
          params: nameParam,
          body: {
            type: 'object',
            properties: { enabled: { type: 'boolean' }, role: { type: 'string', enum: ROLES } },
            additionalProperties: false,
          },
        },
      },
      async (request: NameRequest) => {
        saveGroup(db, request.params.name, request.body as { enabled?: boolean; role?: Role });
        return { items: listGroups(db) };
      },
    );

    admin.delete('/api/admin/groups/:name', { schema: { params: nameParam } }, async (request: NameRequest) => {
      deleteGroup(db, request.params.name);
      return { items: listGroups(db) };
    });

    const view = (request: FastifyRequest, settings: OidcSettings) => {
      const { clientSecret, ...rest } = settings;
      return { ...rest, hasSecret: Boolean(clientSecret), redirectUri: redirectUri(request, deps.publicUrl) };
    };

    admin.get('/api/admin/oidc', async (request) => view(request, oidc.settings()));

    admin.put(
      '/api/admin/oidc',
      {
        schema: {
          body: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              issuer: { type: 'string', maxLength: 500 },
              clientId: { type: 'string', maxLength: 500 },
              // Fehlt es, bleibt das gespeicherte Secret; ein leerer Text löscht es.
              clientSecret: { type: 'string', maxLength: 2000 },
              scopes: { type: 'string', maxLength: 500 },
              groupsClaim: { type: 'string', maxLength: 200 },
              label: { type: 'string', maxLength: 100 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => view(request, oidc.save(request.body as Partial<OidcSettings>)),
    );

    admin.post('/api/admin/oidc/test', async () => oidc.test());
  });
}
