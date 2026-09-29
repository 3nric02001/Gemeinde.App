import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

let cloud: FakeNextcloud;
let ctx: AppContext;
let cookie = '';
const inject = (options: InjectOptions, as = cookie) => ctx.app.inject({ ...options, headers: { cookie: as, ...options.headers } });

async function get<T = any>(url: string, as = cookie): Promise<T> {
  const res = await inject({ method: 'GET', url }, as);
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

function addListener(name: string): number {
  const { id } = ctx.db
    .prepare(
      "INSERT INTO users (kind, issuer, subject, name, role, created_at) VALUES ('oidc', 'idp', ?, ?, 'listener', 0) RETURNING id",
    )
    .get(name, name) as { id: number };
  return id;
}

const trackId = (title: string) => (ctx.db.prepare('SELECT id FROM tracks WHERE title = ?').get(title) as { id: number }).id;
const albumId = (title: string) => (ctx.db.prepare('SELECT id FROM albums WHERE title = ?').get(title) as { id: number }).id;

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  const service = (folder: string, title: string, custom: Record<string, string> = {}) =>
    cloud.put(`Gottesdienste/2026/${folder}/01 ${title}.mp3`, mp3({ title, artist: 'MBG', genre: 'Gottesdienst', custom }));
  service('2026-08-30 Jugendgottesdienst', 'Input');
  service('2026-09-20', 'Predigt Psalm 23', { Sprecher: 'Pastor Meier', Bibelstelle: 'Psalm 23' });
  // Datum im deutschen Format und ohne Jahr in den Tags: sortiert trotzdem richtig
  service('13.09.2026 Taufgottesdienst', 'Taufe');
  service('2026-09-27 Erntedank', 'Predigt Dankbarkeit', { Sprecher: 'Anna Schulz' });
  cloud.put('Hillsong/Let There Be Light/01 Behold.mp3', mp3({ title: 'Behold', artist: 'Hillsong', album: 'Let There Be Light', year: 2016, genre: 'Worship' }));
  const config = loadConfig({
    NEXTCLOUD_URL: cloud.url,
    NEXTCLOUD_USER: USER,
    NEXTCLOUD_PASSWORD: PASSWORD,
    NEXTCLOUD_MUSIC_PATH: '/Musik',
    DATABASE_PATH: ':memory:',
  });
  ctx = await buildApp(config, { logger: false });
  cookie = sessionCookie(ctx.db);
  await ctx.scanner.scan();
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('Alben mit Datum', () => {
  it('liefern Datum, Jahr und Sprecher und stehen nach Datum sortiert', async () => {
    const page = await get('/api/albums?genre=Gottesdienst&sort=year');
    expect(page.items.map((a: any) => [a.date, a.year])).toEqual([
      ['2026-09-27', 2026],
      ['2026-09-20', 2026],
      ['2026-09-13', 2026],
      ['2026-08-30', 2026],
    ]);
    expect(page.items[1]).toMatchObject({ speaker: 'Pastor Meier', passage: 'Psalm 23' });

    const byDate = await get('/api/albums?sort=date');
    expect(byDate.items.at(-1).title).toBe('Let There Be Light');
    expect(byDate.items.at(-1).date).toBeNull();
  });

  it('Titel kennen Datum und Sprecher ihres Albums', async () => {
    const page = await get('/api/tracks?q=predigt');
    expect(page.items.map((t: any) => [t.title, t.albumDate, t.speaker])).toEqual([
      ['Predigt Dankbarkeit', '2026-09-27', 'Anna Schulz'],
      ['Predigt Psalm 23', '2026-09-20', 'Pastor Meier'],
    ]);
  });

  it('Sprecher, Bibelstelle und Beschreibung lassen sich in der Verwaltung setzen', async () => {
    const id = albumId('13.09.2026 Taufgottesdienst');
    const res = await inject({
      method: 'PATCH',
      url: `/api/admin/albums/${id}`,
      payload: { speaker: 'Pastorin Kurz', description: 'Taufe von drei Kindern' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().overrides).toMatchObject({ speaker: 'Pastorin Kurz', description: 'Taufe von drei Kindern' });
    const folder = await get(`/api/dates/folder?path=${encodeURIComponent('Gottesdienste/2026/13.09.2026 Taufgottesdienst')}`);
    expect(folder).toMatchObject({ speaker: 'Pastorin Kurz', description: 'Taufe von drei Kindern', passage: null });
    // Übersteht einen Scan
    await ctx.scanner.scan();
    expect((await get(`/api/albums/${id}`)).speaker).toBe('Pastorin Kurz');
  });
});

describe('Suche', () => {
  it('findet eigene Felder wie den Sprecher, auch zusammen mit dem Titel', async () => {
    expect((await get('/api/tracks?q=meier')).items.map((t: any) => t.title)).toEqual(['Predigt Psalm 23']);
    expect((await get('/api/tracks?q=psalm%20meier')).total).toBe(1);
    expect((await get('/api/albums?q=schulz')).items.map((a: any) => a.title)).toEqual(['2026-09-27 Erntedank']);
  });

  it('vergisst alte Werte, wenn sich die Tags ändern', async () => {
    cloud.put(
      'Gottesdienste/2026/2026-09-20/01 Predigt Psalm 23.mp3',
      mp3({ title: 'Predigt Psalm 23', artist: 'MBG', custom: { Sprecher: 'Gastprediger Weber' } }),
    );
    await ctx.scanner.scan();
    expect((await get('/api/tracks?q=meier')).total).toBe(0);
    expect((await get('/api/tracks?q=weber')).total).toBe(1);
  });
});

describe('Favoriten', () => {
  it('gehören jedem Hörer allein', async () => {
    const anna = sessionCookie(ctx.db, addListener('Anna'));
    const behold = trackId('Behold');
    const album = albumId('Let There Be Light');
    expect((await inject({ method: 'PUT', url: `/api/me/favorites/track/${behold}` }, anna)).statusCode).toBe(204);
    expect((await inject({ method: 'PUT', url: `/api/me/favorites/album/${album}` }, anna)).statusCode).toBe(204);
    // Doppelt setzen schadet nicht
    expect((await inject({ method: 'PUT', url: `/api/me/favorites/album/${album}` }, anna)).statusCode).toBe(204);
    expect((await inject({ method: 'PUT', url: '/api/me/favorites/track/99999' }, anna)).statusCode).toBe(404);

    const mine = await get('/api/me/favorites', anna);
    expect(mine.tracks.map((t: any) => t.title)).toEqual(['Behold']);
    expect(mine.albums.map((a: any) => a.title)).toEqual(['Let There Be Light']);
    expect(await get('/api/me/favorites')).toEqual({ tracks: [], albums: [] });

    expect((await inject({ method: 'DELETE', url: `/api/me/favorites/track/${behold}` }, anna)).statusCode).toBe(204);
    expect((await get('/api/me/favorites', anna)).tracks).toEqual([]);
  });

  it('ausgeblendete Alben verschwinden aus den Favoriten', async () => {
    const album = albumId('Let There Be Light');
    await inject({ method: 'PUT', url: `/api/me/favorites/album/${album}` });
    await inject({ method: 'PATCH', url: `/api/admin/albums/${album}`, payload: { hidden: true } });
    expect((await get('/api/me/favorites')).albums).toEqual([]);
  });
});

describe('Weiterhören', () => {
  it('merkt sich die Stelle langer Titel und zeigt zuletzt gehörte Alben', async () => {
    const sermon = trackId('Predigt Psalm 23');
    const song = trackId('Behold');
    ctx.db.prepare('UPDATE tracks SET duration = 2400 WHERE id = ?').run(sermon);
    const save = (id: number, position: number) =>
      inject({ method: 'PUT', url: `/api/me/progress/${id}`, payload: { position } });

    expect((await save(song, 20)).statusCode).toBe(204);
    expect((await save(sermon, 754.5)).statusCode).toBe(204);
    expect((await save(99999, 1)).statusCode).toBe(404);

    expect((await get('/api/me/progress')).items).toEqual([{ trackId: sermon, position: 754.5 }]);
    const home = await get('/api/me/home');
    expect(home.resume.map((t: any) => [t.id, t.position])).toEqual([[sermon, 754.5]]);
    expect(home.recent.map((a: any) => a.title)).toEqual(['2026-09-20', 'Let There Be Light']);

    // Zu Ende gehört: nicht mehr unter "Weiterhören", aber weiter unter "Zuletzt gehört"
    await save(sermon, 2400);
    expect((await get('/api/me/progress')).items).toEqual([]);
    expect((await get('/api/me/home')).resume).toEqual([]);
    expect((await get('/api/me/home')).recent).toHaveLength(2);
  });
});

describe('Name der Gemeinde', () => {
  it('stellt der Admin ein, die Anmeldeseite zeigt ihn ohne Sitzung', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/admin/branding',
      payload: { name: 'MBG Brake', welcome: 'Predigten und Musik der Gemeinde' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(status.json().branding).toEqual({ name: 'MBG Brake', welcome: 'Predigten und Musik der Gemeinde' });

    const anna = sessionCookie(ctx.db, addListener('Anna'));
    expect((await inject({ method: 'PUT', url: '/api/admin/branding', payload: { name: 'X' } }, anna)).statusCode).toBe(403);
  });
});
