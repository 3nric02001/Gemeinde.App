import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrations, openDatabase } from '../src/db.js';
import { slugify } from '../src/library/categories.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

let cookie = '';

let cloud: FakeNextcloud;
let ctx: AppContext;

async function call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, status = 200): Promise<T> {
  const res = await ctx.app.inject({ method, url, payload, headers: { cookie } });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
  return (res.body ? res.json() : undefined) as T;
}

const values = async (slug: string, q = '') =>
  (await call<{ items: Array<{ value: string; trackCount: number; grouped: boolean }> }>(
    'GET',
    `/api/categories/${slug}/values${q}`,
  )).items;
const trackTitles = async (query: string) =>
  (await call<{ items: Array<{ title: string }> }>('GET', `/api/tracks?limit=500&${query}`)).items.map((t) => t.title).sort();

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  cloud.put('Lobpreis/Zion/01 Oceans.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion', genre: 'Lied', custom: { Kategorie: 'Lied' } }));
  cloud.put('Lobpreis/Zion/02 Zion.mp3', mp3({ title: 'Zion', artist: 'Hillsong United', album: 'Zion', genre: 'Musik', custom: { Kategorie: 'Musik' } }));
  cloud.put('Chor/Advent/01 Macht hoch.mp3', mp3({ title: 'Macht hoch die Tür', artist: 'Kirchenchor; Gemeinde', album: 'Advent', genre: 'lied', composer: 'Bach' }));
  cloud.put('Predigten/2024-03-03/01 Psalm 23.mp3', mp3({ title: 'Psalm 23', artist: 'Pastor Meier', album: 'GD', genre: 'Predigt', custom: { Kategorie: 'Predigt', Sprecher: 'Pastor Meier' } }));
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

describe('Kategorien', () => {
  it('bringt Interpreten und Genre als Vorgabe mit', async () => {
    const { items } = await call('GET', '/api/categories');
    expect(items).toEqual([
      { id: 1, name: 'Interpreten', slug: 'interpreten', inNav: true },
      { id: 2, name: 'Genre', slug: 'genre', inNav: false },
    ]);
    // Mehrere Interpreten in einem Tag ("Kirchenchor; Gemeinde") werden einzeln geführt.
    expect((await values('interpreten')).map((v) => v.value)).toEqual(['Gemeinde', 'Hillsong United', 'Kirchenchor', 'Pastor Meier']);
    expect(await trackTitles('category=interpreten&value=kirchenchor')).toEqual(['Macht hoch die Tür']);
    // Groß-/Kleinschreibung zählt nicht: "Lied" und "lied" sind ein Wert.
    expect(await values('genre')).toContainEqual({ value: 'Lied', trackCount: 2, grouped: false });
  });

  it('listet alle Tag-Felder, auch eigene TXXX-Felder', async () => {
    const { items } = await call<{ items: Array<{ tag: string; trackCount: number; samples: string[] }> }>('GET', '/api/admin/tag-fields');
    const byTag = Object.fromEntries(items.map((f) => [f.tag, f]));
    expect(byTag.kategorie).toMatchObject({ trackCount: 3 });
    expect(byTag.kategorie!.samples.sort()).toEqual(['Lied', 'Musik', 'Predigt']);
    expect(byTag.sprecher).toMatchObject({ trackCount: 1, samples: ['Pastor Meier'] });
    expect(byTag.composer).toMatchObject({ trackCount: 1, samples: ['Bach'] });
    expect(byTag.title).toBeUndefined();
  });

  it('fasst Werte zusammen: Musik <- Musik, Lied', async () => {
    const created = await call(
      'POST',
      '/api/admin/categories',
      { name: 'Art', fields: ['genre', 'kategorie'], groups: [{ label: 'Musik', values: ['Musik', 'Lied'] }] },
      201,
    );
    expect(created).toMatchObject({ slug: 'art', inNav: true, fields: ['genre', 'kategorie'], position: 2 });

    const list = await values('art');
    expect(list).toEqual([
      { value: 'Musik', trackCount: 3, grouped: true, sources: ['Lied', 'Musik'] },
      { value: 'Predigt', trackCount: 1, grouped: false },
    ]);
    expect(await trackTitles('category=art&value=Musik')).toEqual(['Macht hoch die Tür', 'Oceans', 'Zion']);
    // Ein zusammengefasster Tag-Wert ist nur noch über seine Gruppe erreichbar.
    expect(await trackTitles('category=art&value=Lied')).toEqual([]);
    const albums = await call<{ items: Array<{ title: string }> }>('GET', '/api/albums?category=art&value=musik');
    expect(albums.items.map((a) => a.title).sort()).toEqual(['Advent', 'Zion']);

    // Nur zusammengefasste Werte zeigen
    await call('PATCH', `/api/admin/categories/${created.id}`, { groupedOnly: true });
    expect((await values('art')).map((v) => v.value)).toEqual(['Musik']);
    expect(await trackTitles('category=art&value=Predigt')).toEqual([]);
  });

  it('benennt um, ordnet, blendet aus und löscht', async () => {
    const renamed = await call('PATCH', '/api/admin/categories/1', { name: 'Künstler & Sprecher', inNav: false });
    expect(renamed).toMatchObject({ name: 'Künstler & Sprecher', slug: 'kunstler-sprecher', inNav: false });
    expect(await values('kunstler-sprecher')).toHaveLength(4);
    await call('GET', '/api/categories/interpreten/values', undefined, 404);

    const { items } = await call('PUT', '/api/admin/categories/order', { ids: [2, 1] });
    expect(items.map((c: { id: number }) => c.id)).toEqual([2, 1]);
    await call('PUT', '/api/admin/categories/order', { ids: [2] }, 400);

    await call('DELETE', '/api/admin/categories/2', undefined, 204);
    expect((await call('GET', '/api/categories')).items).toHaveLength(1);
    await call('DELETE', '/api/admin/categories/2', undefined, 404);
  });

  it('prüft Eingaben', async () => {
    await call('POST', '/api/admin/categories', { name: 'X', fields: [] }, 400);
    await call('POST', '/api/admin/categories', { name: '  ', fields: ['genre'] }, 400);
    await call('POST', '/api/admin/categories', { name: 'X', fields: ['genre'], groups: [{ label: 'A', values: ['Lied'] }, { label: 'B', values: ['lied'] }] }, 400);
    await call('POST', '/api/admin/categories', { name: 'X', fields: ['genre'], groups: [{ label: 'A', values: [] }] }, 400);
    // Pfade der Oberfläche bleiben frei
    const suche = await call('POST', '/api/admin/categories', { name: 'Suche', fields: ['genre'] }, 201);
    expect(suche.slug).toBe('suche-2');
    const again = await call('POST', '/api/admin/categories', { name: 'Genre', fields: ['genre'] }, 201);
    expect(again.slug).toBe('genre-2');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/categories' });
    expect(res.statusCode).toBe(401);
  });

  it('zeigt eine Vorschau, bevor gespeichert wird', async () => {
    const preview = await call('POST', '/api/admin/categories/preview', {
      fields: ['Kategorie'],
      groups: [{ label: 'Musik', values: ['Musik', 'Lied'] }, { label: '', values: [] }],
    });
    expect(preview).toEqual({
      total: 2,
      items: [
        { value: 'Musik', trackCount: 2, grouped: true, sources: ['Musik', 'Lied'] },
        { value: 'Predigt', trackCount: 1, grouped: false },
      ],
    });
  });

  it('liest geänderte Tags beim nächsten Scan neu und behält die Kategorien', async () => {
    await call('POST', '/api/admin/categories', { name: 'Sprecher', fields: ['sprecher'] }, 201);
    cloud.put('Predigten/2024-03-03/01 Psalm 23.mp3', mp3({ title: 'Psalm 23', artist: 'Pastor Meier', custom: { Sprecher: 'Pastorin Weber' } }));
    await ctx.scanner.scan();
    expect((await values('sprecher')).map((v) => v.value)).toEqual(['Pastorin Weber']);
    cloud.delete('Predigten/2024-03-03/01 Psalm 23.mp3');
    await ctx.scanner.scan();
    expect(await values('sprecher')).toEqual([]);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM track_tags WHERE track_id NOT IN (SELECT id FROM tracks)').get()).toEqual({ n: 0 });
  });
});

describe('slugify', () => {
  it.each([
    ['Interpreten', 'interpreten'],
    ['Straße & Glaube', 'strasse-glaube'],
    ['  ', 'kategorie'],
  ])('%s -> %s', (name, slug) => expect(slugify(name)).toBe(slug));
});

describe('Migration auf Kategorien', () => {
  it('übernimmt vorhandene Titel und erzwingt einen neuen Scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemeinde-cat-'));
    try {
      const file = join(dir, 'db.sqlite');
      const old = new Database(file);
      for (const sql of migrations.slice(0, 5)) old.exec(sql);
      old.pragma('user_version = 5');
      old.prepare(
        `INSERT INTO tracks (path, etag, size, title, artist, album_artist, album, genre, year, scanned_at)
         VALUES ('a.mp3', 'e1', 1, 'A', 'Chör', 'Gemeinde', 'Alb', 'Lied', 2020, 0)`,
      ).run();
      old.close();

      const db = openDatabase(file);
      expect(db.prepare('SELECT etag FROM tracks').get()).toEqual({ etag: '' });
      expect(db.prepare('SELECT tag, value, vkey FROM track_tags ORDER BY tag').all()).toEqual([
        { tag: 'album', value: 'Alb', vkey: 'alb' },
        { tag: 'albumartist', value: 'Gemeinde', vkey: 'gemeinde' },
        { tag: 'artist', value: 'Chör', vkey: 'chor' },
        { tag: 'genre', value: 'Lied', vkey: 'lied' },
        { tag: 'year', value: '2020', vkey: '2020' },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
