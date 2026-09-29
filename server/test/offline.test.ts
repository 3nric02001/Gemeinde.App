import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { setUserDisabled } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { PAGE_CSP } from '../src/http/security.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

let cloud: FakeNextcloud;
let ctx: AppContext;
let admin = '';
let listener = '';
let listenerId = 0;
const inject = (options: InjectOptions, as: string) => ctx.app.inject({ ...options, headers: { cookie: as, ...options.headers } });

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  ctx = await buildApp(
    loadConfig({
      NEXTCLOUD_URL: cloud.url,
      NEXTCLOUD_USER: USER,
      NEXTCLOUD_PASSWORD: PASSWORD,
      NEXTCLOUD_MUSIC_PATH: '/Musik',
      DATABASE_PATH: ':memory:',
    }),
    { logger: false },
  );
  admin = sessionCookie(ctx.db);
  listenerId = (
    ctx.db
      .prepare("INSERT INTO users (kind, issuer, subject, name, role, created_at) VALUES ('oidc', 'idp', 'anna', 'Anna', 'listener', 0) RETURNING id")
      .get() as { id: number }
  ).id;
  listener = sessionCookie(ctx.db, listenerId);
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('Offline-Schlüssel', () => {
  it('gibt jedem Benutzer einen eigenen, gleichbleibenden Schlüssel', async () => {
    const first = await inject({ method: 'GET', url: '/api/me/offline' }, listener);
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const body = first.json();
    expect(body).toMatchObject({ enabled: true, days: 30 });
    expect(Buffer.from(body.key, 'base64url')).toHaveLength(32);

    const again = (await inject({ method: 'GET', url: '/api/me/offline' }, listener)).json();
    expect(again.key).toBe(body.key);
    expect(again.keyId).toBe(body.keyId);
    const other = (await inject({ method: 'GET', url: '/api/me/offline' }, admin)).json();
    expect(other.key).not.toBe(body.key);
  });

  it('verlangt eine Anmeldung', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me/offline' });
    expect(res.statusCode).toBe(401);
  });

  it('verwirft alle Schlüssel, wenn der Admin Offline abschaltet', async () => {
    const before = (await inject({ method: 'GET', url: '/api/me/offline' }, listener)).json();
    const off = await inject({ method: 'PUT', url: '/api/admin/offline', payload: { enabled: false, days: 14 } }, admin);
    expect(off.json()).toEqual({ enabled: false, days: 14 });
    expect((await inject({ method: 'GET', url: '/api/me/offline' }, listener)).json()).toEqual({ enabled: false, days: 14 });

    await inject({ method: 'PUT', url: '/api/admin/offline', payload: { enabled: true } }, admin);
    const after = (await inject({ method: 'GET', url: '/api/me/offline' }, listener)).json();
    expect(after).toMatchObject({ enabled: true, days: 14 });
    expect(after.keyId).not.toBe(before.keyId);
  });

  it('verwirft den Schlüssel eines gesperrten Benutzers', async () => {
    const before = (await inject({ method: 'GET', url: '/api/me/offline' }, listener)).json();
    setUserDisabled(ctx.db, listenerId, true);
    setUserDisabled(ctx.db, listenerId, false);
    const after = (await inject({ method: 'GET', url: '/api/me/offline' }, sessionCookie(ctx.db, listenerId))).json();
    expect(after.keyId).not.toBe(before.keyId);
  });

  it('lässt nur Admins die Einstellung ändern und prüft die Frist', async () => {
    expect((await inject({ method: 'GET', url: '/api/admin/offline' }, listener)).statusCode).toBe(403);
    expect((await inject({ method: 'PUT', url: '/api/admin/offline', payload: { enabled: false } }, listener)).statusCode).toBe(403);
    expect((await inject({ method: 'PUT', url: '/api/admin/offline', payload: { days: 0 } }, admin)).statusCode).toBe(400);
    expect((await inject({ method: 'GET', url: '/api/admin/offline' }, admin)).json()).toEqual({ enabled: true, days: 30 });
  });

  it('erlaubt den Service Worker nur von der eigenen Adresse', () => {
    expect(PAGE_CSP).toContain("worker-src 'self'");
  });
});
