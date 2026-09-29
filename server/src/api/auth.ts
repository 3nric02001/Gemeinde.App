import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { OidcService } from '../auth/oidc.js';
import { createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_MS, sessionUser, type SessionUser } from '../auth/sessions.js';
import { AuthError, changePassword, checkLocalLogin, hasRole, upsertOidcUser, type Role } from '../auth/users.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const OIDC_STATE_COOKIE = 'gemeinde_oidc';

/** Pfade, die nur der Admin nutzen darf; alles andere unter /api/admin reicht für Manager. */
const ADMIN_ONLY = ['/api/admin/users', '/api/admin/groups', '/api/admin/oidc'];

/** Welche Rolle eine Anfrage braucht; undefined heißt öffentlich. */
export function requiredRole(method: string, path: string): Role | undefined {
  if (!path.startsWith('/api/') || path === '/api/health' || path.startsWith('/api/auth/')) return undefined;
  if (ADMIN_ONLY.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return 'admin';
  if (path.startsWith('/api/admin/') || (path === '/api/scan' && method !== 'GET')) return 'manager';
  return 'listener';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Nur Rücksprünge innerhalb der App, nie auf fremde Seiten. */
function safeReturnTo(value: unknown): string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/\\') &&
    !value.startsWith('/api/')
    ? value.slice(0, 2000)
    : '/';
}

/** Einfache Bremse gegen Passwort-Raten: nach 10 Fehlversuchen je IP 15 Minuten Pause. */
class LoginThrottle {
  private readonly failures = new Map<string, { count: number; until: number }>();
  blocked(ip: string): boolean {
    const entry = this.failures.get(ip);
    return Boolean(entry && entry.count >= 10 && entry.until > Date.now());
  }
  fail(ip: string): void {
    const now = Date.now();
    const entry = this.failures.get(ip);
    const count = entry && entry.until > now ? entry.count + 1 : 1;
    this.failures.set(ip, { count, until: now + 15 * 60 * 1000 });
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
  }
  succeed(ip: string): void {
    this.failures.delete(ip);
  }
}

export function authErrorHandler(error: Error, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AuthError) return reply.code(error.status).send({ error: error.message });
  if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: error.message });
  const status = (error as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.code(status).send({ error: error.message });
  request.log.error({ err: error }, 'Unerwarteter Fehler');
  return reply.code(500).send({ error: 'Interner Fehler' });
}

export interface AuthDeps {
  db: DB;
  oidc: OidcService;
  publicUrl: string | undefined;
}

export function appOrigin(request: FastifyRequest, publicUrl: string | undefined): string {
  if (publicUrl) return publicUrl;
  // Über URL normalisiert, damit z. B. ":80" bei http wegfällt wie im Origin-Header des Browsers.
  try {
    return new URL(`${request.protocol}://${request.host}`).origin;
  } catch {
    return `${request.protocol}://${request.host}`;
  }
}

export const redirectUri = (request: FastifyRequest, publicUrl: string | undefined) =>
  `${appOrigin(request, publicUrl)}/api/auth/oidc/callback`;

/**
 * Anmeldung und Zugriffsschutz: Jede Anfrage unter /api (außer /api/health und /api/auth)
 * braucht eine Sitzung, die Verwaltung zusätzlich die passende Rolle.
 */
export async function registerAuth(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { db, oidc, publicUrl } = deps;
  const throttle = new LoginThrottle();
  await app.register(fastifyCookie);

  const cookieOptions = (request: FastifyRequest) => ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: appOrigin(request, publicUrl).startsWith('https:'),
  });

  const startSession = (request: FastifyRequest, reply: FastifyReply, userId: number) => {
    reply.setCookie(SESSION_COOKIE, createSession(db, userId), { ...cookieOptions(request), maxAge: SESSION_TTL_MS / 1000 });
  };

  app.addHook('onRequest', async (request, reply) => {
    // Das Muster der gefundenen Route statt der rohen URL: Der Router dekodiert z. B. %61 zu "a",
    // sonst käme /api/%61dmin/users an der Rollenprüfung vorbei.
    const path = request.routeOptions.url ?? request.url.split('?', 1)[0]!;
    const needed = requiredRole(request.method, path);
    if (!needed) return;
    // Änderungen nur von der eigenen Seite aus (zusätzlich zu SameSite=Lax).
    const origin = request.headers.origin;
    if (!SAFE_METHODS.has(request.method) && origin && origin !== appOrigin(request, publicUrl)) {
      // Häufigste Ursache ohne Angriff: Reverse Proxy ohne X-Forwarded-Host/-Proto und ohne PUBLIC_URL.
      request.log.warn(
        { origin, expected: appOrigin(request, publicUrl) },
        'Anfrage mit fremdem Origin abgelehnt (PUBLIC_URL gesetzt?)',
      );
      return reply.code(403).send({ error: 'Anfrage von fremder Seite abgelehnt' });
    }
    const user = sessionUser(db, request.cookies[SESSION_COOKIE]);
    if (!user) return reply.code(401).send({ error: 'Bitte anmelden' });
    request.user = user;
    if (!hasRole(user.role, needed)) return reply.code(403).send({ error: 'Dafür fehlt die Berechtigung' });
  });

  // Eigener Bereich, damit die Fehlerbehandlung nur für die Anmelde-Routen gilt.
  await app.register(async (app) => {
    app.setErrorHandler(authErrorHandler);

    app.get('/api/auth/status', async (request) => {
      const user = sessionUser(db, request.cookies[SESSION_COOKIE]);
      const settings = oidc.settings();
      return {
        user: user ? { id: user.id, name: user.name, role: user.role, kind: user.kind } : null,
        oidc: oidc.isReady(settings) ? { label: settings.label } : null,
      };
    });

    app.post(
      '/api/auth/login',
      {
        schema: {
          body: {
            type: 'object',
            required: ['username', 'password'],
            properties: { username: { type: 'string', maxLength: 100 }, password: { type: 'string', maxLength: 500 } },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        if (throttle.blocked(request.ip)) {
          return reply.code(429).send({ error: 'Zu viele Fehlversuche, bitte in 15 Minuten erneut versuchen' });
        }
        const { username, password } = request.body as { username: string; password: string };
        const user = await checkLocalLogin(db, username, password);
        if (!user) {
          throttle.fail(request.ip);
          request.log.warn({ username }, 'Fehlgeschlagene Anmeldung');
          return reply.code(401).send({ error: 'Benutzername oder Passwort stimmt nicht' });
        }
        throttle.succeed(request.ip);
        startSession(request, reply, user.id);
        return { user: { id: user.id, name: user.name, role: user.role, kind: user.kind } };
      },
    );

    app.post('/api/auth/logout', async (request, reply) => {
      deleteSession(db, request.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, cookieOptions(request));
      return reply.code(204).send();
    });

    app.post(
      '/api/auth/password',
      {
        schema: {
          body: {
            type: 'object',
            required: ['current', 'next'],
            properties: { current: { type: 'string', maxLength: 500 }, next: { type: 'string', maxLength: 500 } },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const user = sessionUser(db, request.cookies[SESSION_COOKIE]);
        if (!user) return reply.code(401).send({ error: 'Bitte anmelden' });
        const { current, next } = request.body as { current: string; next: string };
        await changePassword(db, user.id, current, next, user.sessionHash);
        return reply.code(204).send();
      },
    );

    app.get('/api/auth/oidc/start', async (request, reply) => {
      const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
      try {
        const { url, state } = await oidc.start(redirectUri(request, publicUrl), returnTo);
        reply.setCookie(OIDC_STATE_COOKIE, state, { ...cookieOptions(request), path: '/api/auth/oidc', maxAge: 600 });
        return reply.redirect(url);
      } catch (error) {
        request.log.error({ err: error }, 'OIDC-Anmeldung konnte nicht beginnen');
        return reply.redirect('/?anmeldung=fehler');
      }
    });

    app.get('/api/auth/oidc/callback', async (request, reply) => {
      const cookieState = request.cookies[OIDC_STATE_COOKIE];
      reply.clearCookie(OIDC_STATE_COOKIE, { ...cookieOptions(request), path: '/api/auth/oidc' });
      const callback = new URL(request.url, 'http://localhost');
      // Abbruch beim Identity Provider (z. B. "Zugriff verweigert")
      if (callback.searchParams.has('error')) {
        request.log.warn({ error: callback.searchParams.get('error') }, 'OIDC-Anmeldung abgebrochen');
        return reply.redirect('/?anmeldung=abgebrochen');
      }
      try {
        const { identity, returnTo } = await oidc.finish(redirectUri(request, publicUrl), callback, cookieState);
        const result = upsertOidcUser(db, identity);
        if ('denied' in result) {
          request.log.info(
            { subject: identity.subject, groups: identity.groups, reason: result.denied },
            'OIDC-Anmeldung ohne Zugang',
          );
          return reply.redirect(`/?anmeldung=${result.denied === 'disabled' ? 'gesperrt' : 'keine-gruppe'}`);
        }
        startSession(request, reply, result.user.id);
        return reply.redirect(returnTo);
      } catch (error) {
        request.log.error({ err: error }, 'OIDC-Anmeldung fehlgeschlagen');
        return reply.redirect('/?anmeldung=fehler');
      }
    });
  });
}
