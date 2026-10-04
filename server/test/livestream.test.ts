import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { requiredRole } from '../src/api/auth.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_LIVESTREAM } from '../src/livestream.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

let cloud: FakeNextcloud;
let ctx: AppContext;
let admin = '';
let listener = '';
const inject = (options: InjectOptions, as: string) => ctx.app.inject({ ...options, headers: { cookie: as, ...options.headers } });
const status = async (as: string) => (await inject({ method: 'GET', url: '/api/auth/status' }, as)).json().livestream;
/** CSP einer Seite außerhalb von /api */
const pageCsp = async () => (await ctx.app.inject({ method: 'GET', url: '/manifest.webmanifest' })).headers['content-security-policy'] as string;
const save = (payload: object, as = admin) => inject({ method: 'PUT', url: '/api/admin/livestream', payload }, as);

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
  const id = (
    ctx.db
      .prepare("INSERT INTO users (kind, issuer, subject, name, role, created_at) VALUES ('oidc', 'idp', 'anna', 'Anna', 'listener', 0) RETURNING id")
      .get() as { id: number }
  ).id;
  listener = sessionCookie(ctx.db, id);
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('Livestream', () => {
  it('ist ab Werk mit dem Stream der Gemeinde eingeschaltet, aber nur für Angemeldete', async () => {
    expect(await status(listener)).toEqual({
      url: DEFAULT_LIVESTREAM.url,
      title: 'Livestream',
      audio: 'https://vortrag.mbg-bielefeld-brake.de/hls/stream.m3u8',
    });
    expect(await status('')).toBeNull();
    expect(await pageCsp()).toContain("frame-src 'self' https://vortrag.mbg-bielefeld-brake.de");
    expect(await pageCsp()).toContain("media-src 'self' blob: https://vortrag.mbg-bielefeld-brake.de");
  });

  it('lässt sich umstellen und abschalten; die CSP folgt', async () => {
    const changed = await save({ url: 'https://live.example.org/embed/video/', title: 'Gottesdienst live' });
    expect(changed.statusCode).toBe(200);
    expect(await status(listener)).toEqual({
      url: 'https://live.example.org/embed/video/',
      title: 'Gottesdienst live',
      audio: 'https://live.example.org/hls/stream.m3u8',
    });
    const csp = await pageCsp();
    expect(csp).toMatch(/frame-src 'self' https:\/\/live\.example\.org(;|$)/);
    expect(csp).not.toContain('mbg-bielefeld-brake');

    expect((await save({ enabled: false })).json()).toMatchObject({ enabled: false, url: 'https://live.example.org/embed/video/' });
    expect(await status(listener)).toBeNull();
    expect(await pageCsp()).not.toContain('frame-src');
    expect(await pageCsp()).toContain("media-src 'self' blob:;");
    // Die API bleibt in jedem Fall ohne Einbettung
    expect((await inject({ method: 'GET', url: '/api/auth/status' }, listener)).headers['content-security-policy']).toContain(
      "default-src 'none'",
    );

    const log = (await inject({ method: 'GET', url: '/api/admin/changes' }, admin)).json();
    expect(JSON.stringify(log)).toContain('Livestream ausgeschaltet');
  });

  it('spielt im Player den eingetragenen Stream, bei fremden Seiten ohne Eintrag keinen', async () => {
    await save({ url: 'https://www.youtube.com/embed/abc' });
    expect(await status(listener)).toEqual({ url: 'https://www.youtube.com/embed/abc', title: 'Livestream' });
    expect(await pageCsp()).toContain("media-src 'self' blob:;");

    expect((await save({ audioUrl: 'https://cdn.example.org/live/index.m3u8' })).statusCode).toBe(200);
    expect((await status(listener)).audio).toBe('https://cdn.example.org/live/index.m3u8');
    const csp = await pageCsp();
    expect(csp).toContain("media-src 'self' blob: https://cdn.example.org;");
    expect(csp).toMatch(/frame-src 'self' https:\/\/www\.youtube\.com(;|$)/);

    expect((await save({ audioUrl: 'http://cdn.example.org/live.m3u8' })).statusCode).toBe(400);
  });

  it('nimmt nur https-Adressen', async () => {
    for (const url of ['http://live.example.org/', 'javascript:alert(1)', 'https://user:pw@live.example.org/', 'kein link']) {
      const res = await save({ url });
      expect(res.statusCode, url).toBe(400);
    }
    expect((await save({ enabled: true, url: '' })).statusCode).toBe(400);
    expect((await save({ enabled: false, url: '' })).statusCode).toBe(200);
    expect(await status(listener)).toBeNull();
  });

  it('dürfen nur Admins einstellen', async () => {
    expect(requiredRole('PUT', '/api/admin/livestream')).toBe('admin');
    expect((await save({ enabled: false }, listener)).statusCode).toBe(403);
    expect((await inject({ method: 'GET', url: '/api/admin/livestream' }, listener)).statusCode).toBe(403);
  });
});
