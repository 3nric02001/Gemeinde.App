import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { OidcService, OidcSettings } from '../auth/oidc.js';
import { AuthError, deleteGroup, deleteUser, lastDeniedLogin, listGroups, listUsers, ROLES, saveGroup, setUserDisabled, type Role } from '../auth/users.js';
import { authErrorHandler, redirectUri } from './auth.js';
import { getBranding, saveBranding, type Branding } from '../branding.js';
import { getLivestream, saveLivestream, type Livestream } from '../livestream.js';
import { getOfflineSettings, MAX_OFFLINE_DAYS, saveOfflineSettings, type OfflineSettings } from '../offline.js';

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

    admin.get('/api/admin/branding', async () => getBranding(db));
    admin.put(
      '/api/admin/branding',
      {
        schema: {
          body: {
            type: 'object',
            properties: { name: { type: 'string', maxLength: 60 }, welcome: { type: 'string', maxLength: 300 } },
            additionalProperties: false,
          },
        },
      },
      async (request) => saveBranding(db, request.body as Partial<Branding>),
    );

    admin.get('/api/admin/livestream', async () => getLivestream(db));
    admin.put(
      '/api/admin/livestream',
      {
        schema: {
          body: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              url: { type: 'string', maxLength: 500 },
              title: { type: 'string', maxLength: 60 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => saveLivestream(db, request.body as Partial<Livestream>),
    );

    admin.get('/api/admin/offline', async () => getOfflineSettings(db));
    admin.put(
      '/api/admin/offline',
      {
        schema: {
          body: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              days: { type: 'integer', minimum: 1, maximum: MAX_OFFLINE_DAYS },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => saveOfflineSettings(db, request.body as Partial<OfflineSettings>),
    );

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

    // Mit der letzten abgewiesenen Anmeldung, damit der Admin sieht, welche Gruppen ankamen
    const groupsView = () => ({ items: listGroups(db), lastDenied: lastDeniedLogin(db) });
    admin.get('/api/admin/groups', async () => groupsView());

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
        return groupsView();
      },
    );

    admin.delete('/api/admin/groups/:name', { schema: { params: nameParam } }, async (request: NameRequest) => {
      deleteGroup(db, request.params.name);
      return groupsView();
    });

    const view = (request: FastifyRequest, settings: OidcSettings) => {
      const { clientSecret, ...rest } = settings;
      return {
        ...rest,
        hasSecret: Boolean(clientSecret),
        redirectUri: redirectUri(request, deps.publicUrl),
        // Ohne PUBLIC_URL käme die Weiterleitungs-URL aus Headern der Anfrage; deshalb Pflicht für OIDC.
        publicUrlMissing: !deps.publicUrl,
      };
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
      async (request) => {
        const body = request.body as Partial<OidcSettings>;
        if (body.enabled && !deps.publicUrl) {
          throw new AuthError(400, 'Für die Anmeldung über OIDC muss PUBLIC_URL in der .env gesetzt sein (z. B. https://musik.gemeinde.de)');
        }
        return view(request, oidc.save(body));
      },
    );

    admin.post('/api/admin/oidc/test', async () => oidc.test());
  });
}
