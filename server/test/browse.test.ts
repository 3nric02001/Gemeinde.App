import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { passageBook } from '../src/library/bible.js';
import { LiveStatus, saveLivestream } from '../src/livestream.js';
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

const albumId = (date: string) => (ctx.db.prepare('SELECT id FROM albums WHERE date = ?').get(date) as { id: number }).id;
const trackId = (like: string) => (ctx.db.prepare('SELECT id FROM tracks WHERE path LIKE ?').get(`%${like}%`) as { id: number }).id;

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  const put = (path: string) => cloud.put(`Gottesdienste/${path}.mp3`, mp3({ title: 'Tag', artist: 'MBG' }));
  put('2026-09-20/01 Predigt - Psalm 23 - Pastor Meier');
  put('2026-09-13/01 Predigt - Joh 3,16 - Pastor Meier');
  put('2026-09-06/01 Predigt - 1. Joh 4,8 - Anna Schulz');
  put('2026-08-30/01 Predigt - Psalmen 139 - Anna Schulz');
  put('2026-08-30/02 Lied');
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
  cookie = sessionCookie(ctx.db);
  await ctx.scanner.scan();
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('Bibelbücher', () => {
  it('erkennt Buch und Reihenfolge, auch Abkürzungen und Briefe mit Nummer', () => {
    expect(passageBook('Joh 3,16')).toMatchObject({ name: 'Johannes', testament: 'nt' });
    expect(passageBook('1. Joh 4,8')).toMatchObject({ name: '1. Johannes' });
    expect(passageBook('Psalm 23')?.name).toBe('Psalmen');
    expect(passageBook('2. Mose 20')?.name).toBe('2. Mose');
    expect(passageBook('Genesis 1')?.name).toBe('1. Mose');
    expect(passageBook('1. Kor 13,1-13')?.name).toBe('1. Korinther');
    expect(passageBook('Römer 8')!.order).toBeLessThan(passageBook('Offb 21')!.order);
    expect(passageBook('Erntedank')).toBeUndefined();
  });

  it('listet Bücher mit Predigten in Bibel-Reihenfolge und die Predigten dazu, neueste zuerst', async () => {
    const books = await get('/api/browse/books');
    expect(books.items.map((b: any) => [b.name, b.count])).toEqual([
      ['Psalmen', 2],
      ['Johannes', 1],
      ['1. Johannes', 1],
    ]);
    const psalms = await get(`/api/browse/books/${encodeURIComponent('Psalmen')}`);
    expect(psalms.items.map((t: any) => t.albumDate)).toEqual(['2026-09-20', '2026-08-30']);
    expect(psalms.items[0].passage).toBe('Psalm 23');
    expect((await inject({ method: 'GET', url: '/api/browse/books/Tobit' })).statusCode).toBe(404);
  });

  it('lässt ausgeblendete Alben weg', async () => {
    ctx.db.prepare('UPDATE albums SET hidden = 1 WHERE date = ?').run('2026-08-30');
    const books = await get('/api/browse/books');
    expect(books.items.find((b: any) => b.name === 'Psalmen').count).toBe(1);
  });
});

describe('Sprecher', () => {
  it('zählt Titel je Sprecher und liefert sie neueste zuerst', async () => {
    const speakers = await get('/api/browse/speakers');
    expect(speakers.items.map((s: any) => [s.name, s.count])).toEqual([
      ['Anna Schulz', 2],
      ['Pastor Meier', 2],
    ]);
    const meier = await get(`/api/browse/speakers/${encodeURIComponent('pastor meier')}`);
    expect(meier.items.map((t: any) => t.albumDate)).toEqual(['2026-09-20', '2026-09-13']);
  });
});

describe('Hörstand unter Datum', () => {
  it('meldet angefangen und gehört; "Als gehört markieren" und zurück', async () => {
    const psalm = trackId('Psalm 23');
    await inject({ method: 'PUT', url: `/api/me/progress/${psalm}`, payload: { position: 120, duration: 600 } });
    let states = await get('/api/me/dates');
    expect(states.items).toEqual([{ albumId: albumId('2026-09-20'), state: 'started', progress: 0.2 }]);

    const res = await inject({ method: 'PUT', url: `/api/me/albums/${albumId('2026-09-13')}/heard`, payload: { heard: true } });
    expect(res.statusCode).toBe(204);
    states = await get('/api/me/dates');
    expect(states.items).toContainEqual({ albumId: albumId('2026-09-13'), state: 'heard' });
    // Markieren taucht nicht unter "Zuletzt gehört" auf
    const home = await get('/api/me/home');
    expect(home.recent.map((a: any) => a.id)).toEqual([albumId('2026-09-20')]);

    await inject({ method: 'PUT', url: `/api/me/albums/${albumId('2026-09-13')}/heard`, payload: { heard: false } });
    states = await get('/api/me/dates');
    expect(states.items.map((s: any) => s.albumId)).toEqual([albumId('2026-09-20')]);
  });

  it('zeigt Neues seit dem letzten Besuch, beim ersten Mal nichts', async () => {
    expect((await get('/api/me/dates')).fresh).toBe(0);
    // Ein Gottesdienst kommt nach dem Besuch dazu
    ctx.db.prepare('UPDATE albums SET created_at = ? WHERE date = ?').run(Date.now() + 60_000, '2026-09-20');
    const states = await get('/api/me/dates');
    expect(states.fresh).toBe(1);
    expect(states.items).toContainEqual({ albumId: albumId('2026-09-20'), state: 'new' });
    ctx.db.prepare('UPDATE albums SET created_at = ? WHERE date = ?').run(Date.now() - 1, '2026-09-20');
    await inject({ method: 'POST', url: '/api/me/dates/seen' });
    expect((await get('/api/me/dates')).fresh).toBe(0);
  });
});

describe('Startseite und Anzeige', () => {
  it('Arten tragen ihr jüngstes Datum, Titel ihre Bibelstelle, Status die Übersetzung', async () => {
    const facets = await get('/api/facets');
    expect(facets.recordings[0]).toMatchObject({ latest: '2026-09-20' });
    const status = await get('/api/auth/status');
    expect(status.bibleTranslation).toBe('LUT');
  });
});

describe('Livestream-Status', () => {
  it('fragt Owncast höchstens einmal je Minute und meldet online', async () => {
    const calls: string[] = [];
    let online = true;
    const fake = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ online }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const status = new LiveStatus(ctx.db, fake);
    expect(await status.get()).toBe(true);
    online = false;
    expect(await status.get()).toBe(true);
    expect(calls).toEqual(['https://vortrag.mbg-bielefeld-brake.de/api/status']);
  });

  it('meldet null, wenn ausgeschaltet oder der Server keinen Status kennt', async () => {
    const broken = (async () => new Response('<html>', { status: 404 })) as unknown as typeof fetch;
    expect(await new LiveStatus(ctx.db, broken).get()).toBeNull();
    saveLivestream(ctx.db, { enabled: false });
    const never = (async () => {
      throw new Error('darf nicht fragen');
    }) as unknown as typeof fetch;
    expect(await new LiveStatus(ctx.db, never).get()).toBeNull();
    expect((await get('/api/live')).live).toBeNull();
  });
});
