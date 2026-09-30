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
  // Tags zählen nicht; die Felder kommen aus Ordnern und Dateinamen
  cloud.put('Musik/Zion/01 Oceans.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', genre: 'Lied', custom: { Sprecher: 'Tag' } }));
  cloud.put('Audio Aufnahmen/2024/2024_03_03/Lied - Großer Gott - Kirchenchor.mp3', mp3({}));
  cloud.put('Audio Aufnahmen/2024/2024_03_03/Predigt - Psalm 23 - Pastor Meier.mp3', mp3({}, 80));
  cloud.put('Audio Aufnahmen/2024/2024_03_10_Erntedank/Predigt - Danke - Pastorin Weber.mp3', mp3({}, 80));
  cloud.put('Audio Aufnahmen/2024/Bibelstunden/2024_03_06_Johannes 3/2024_03_06_001.mp3', mp3({}));
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
  it('bringt Sprecher und Inhalt als Vorgabe mit, aus den Dateinamen', async () => {
    const { items } = await call('GET', '/api/categories');
    expect(items).toEqual([
      { id: 3, name: 'Sprecher', slug: 'sprecher', inNav: false },
      { id: 4, name: 'Inhalt', slug: 'inhalt', inNav: false },
    ]);
    // Sprecher ist, wer predigt; der Chor beim Lied und ein Tag in der Datei zählen nicht
    expect((await values('sprecher')).map((v) => v.value)).toEqual(['Pastor Meier', 'Pastorin Weber']);
    expect(await trackTitles('category=sprecher&value=pastor%20meier')).toEqual(['Predigt: Psalm 23']);
    expect(await values('inhalt')).toEqual([
      { value: 'Lied', trackCount: 1, grouped: false },
      { value: 'Predigt', trackCount: 2, grouped: false },
    ]);
  });

  it('bietet die Felder aus Ordnern und Dateinamen an', async () => {
    const { items } = await call<{ items: Array<{ tag: string; label: string; trackCount: number; samples: string[] }> }>(
      'GET',
      '/api/admin/tag-fields',
    );
    expect(items.map((f) => [f.tag, f.label, f.trackCount])).toEqual([
      ['art', 'Art', 4],
      ['inhalt', 'Inhalt', 3],
      ['sprecher', 'Sprecher', 2],
      ['anlass', 'Anlass', 1],
      ['jahr', 'Jahr', 4],
    ]);
    expect(items.find((f) => f.tag === 'art')!.samples).toEqual(['Gottesdienst', 'Bibelstunde']);
    expect(items.find((f) => f.tag === 'anlass')!.samples).toEqual(['Erntedank']);
  });

  it('zeigt den aktuellen Inhalt eines Felds', async () => {
    expect(await call('GET', '/api/admin/tag-fields/art/values')).toEqual({
      total: 2,
      items: [
        { value: 'Gottesdienst', trackCount: 3 },
        { value: 'Bibelstunde', trackCount: 1 },
      ],
    });
    expect(await call('GET', '/api/admin/tag-fields/Sprecher/values?q=weber')).toEqual({ total: 1, items: [{ value: 'Pastorin Weber', trackCount: 1 }] });
    expect(await call('GET', '/api/admin/tag-fields/genre/values')).toEqual({ total: 0, items: [] });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/tag-fields/art/values' });
    expect(res.statusCode).toBe(401);
  });

  it('fasst Werte zusammen: Aufnahmen <- Gottesdienst, Bibelstunde', async () => {
    const created = await call(
      'POST',
      '/api/admin/categories',
      { name: 'Anlässe', fields: ['anlass', 'art'], groups: [{ label: 'Aufnahmen', values: ['Gottesdienst', 'Bibelstunde'] }] },
      201,
    );
    expect(created).toMatchObject({ slug: 'anlasse', inNav: true, fields: ['anlass', 'art'] });

    expect(await values('anlasse')).toEqual([
      { value: 'Aufnahmen', trackCount: 4, grouped: true, sources: ['Bibelstunde', 'Gottesdienst'] },
      { value: 'Erntedank', trackCount: 1, grouped: false },
    ]);
    expect(await trackTitles('category=anlasse&value=Erntedank')).toEqual(['Predigt: Danke']);
    // Ein zusammengefasster Wert ist nur noch über seine Gruppe erreichbar.
    expect(await trackTitles('category=anlasse&value=Bibelstunde')).toEqual([]);
    const albums = await call<{ items: Array<{ title: string }> }>('GET', '/api/albums?category=anlasse&value=aufnahmen');
    expect(albums.items).toHaveLength(3);

    // Nur zusammengefasste Werte zeigen
    await call('PATCH', `/api/admin/categories/${created.id}`, { groupedOnly: true });
    expect((await values('anlasse')).map((v) => v.value)).toEqual(['Aufnahmen']);
    expect(await trackTitles('category=anlasse&value=Erntedank')).toEqual([]);
  });

  it('benennt um, ordnet, blendet aus und löscht', async () => {
    const renamed = await call('PATCH', '/api/admin/categories/3', { name: 'Prediger & Sprecher', inNav: true });
    expect(renamed).toMatchObject({ name: 'Prediger & Sprecher', slug: 'prediger-sprecher', inNav: true });
    expect(await values('prediger-sprecher')).toHaveLength(2);
    await call('GET', '/api/categories/sprecher/values', undefined, 404);

    const { items } = await call('PUT', '/api/admin/categories/order', { ids: [4, 3] });
    expect(items.map((c: { id: number }) => c.id)).toEqual([4, 3]);
    await call('PUT', '/api/admin/categories/order', { ids: [4] }, 400);

    await call('DELETE', '/api/admin/categories/4', undefined, 204);
    expect((await call('GET', '/api/categories')).items).toHaveLength(1);
    await call('DELETE', '/api/admin/categories/4', undefined, 404);
  });

  it('prüft Eingaben', async () => {
    await call('POST', '/api/admin/categories', { name: 'X', fields: [] }, 400);
    await call('POST', '/api/admin/categories', { name: '  ', fields: ['inhalt'] }, 400);
    // Nur Felder aus Ordnern und Dateinamen, keine Tags
    await call('POST', '/api/admin/categories', { name: 'X', fields: ['genre'] }, 400);
    await call('POST', '/api/admin/categories', { name: 'X', fields: ['inhalt'], groups: [{ label: 'A', values: ['Lied'] }, { label: 'B', values: ['lied'] }] }, 400);
    await call('POST', '/api/admin/categories', { name: 'X', fields: ['inhalt'], groups: [{ label: 'A', values: [] }] }, 400);
    // Pfade der Oberfläche bleiben frei
    const suche = await call('POST', '/api/admin/categories', { name: 'Suche', fields: ['jahr'] }, 201);
    expect(suche.slug).toBe('suche-2');
    const again = await call('POST', '/api/admin/categories', { name: 'Inhalt', fields: ['inhalt'] }, 201);
    expect(again.slug).toBe('inhalt-2');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/categories' });
    expect(res.statusCode).toBe(401);
  });

  it('zeigt eine Vorschau, bevor gespeichert wird', async () => {
    const preview = await call('POST', '/api/admin/categories/preview', {
      fields: ['Inhalt'],
      groups: [{ label: 'Wort', values: ['Predigt', 'Lesung'] }, { label: '', values: [] }],
    });
    expect(preview).toEqual({
      total: 2,
      items: [
        { value: 'Lied', trackCount: 1, grouped: false },
        { value: 'Wort', trackCount: 2, grouped: true, sources: ['Predigt'] },
      ],
    });
  });

  it('folgt umbenannten Dateien beim nächsten Scan und behält die Kategorien', async () => {
    cloud.move(
      'Audio Aufnahmen/2024/2024_03_03/Predigt - Psalm 23 - Pastor Meier.mp3',
      'Audio Aufnahmen/2024/2024_03_03/Predigt - Psalm 23 - Pastorin Weber.mp3',
    );
    await ctx.scanner.scan();
    expect(await values('sprecher')).toEqual([{ value: 'Pastorin Weber', trackCount: 2, grouped: false }]);
    cloud.delete('Audio Aufnahmen/2024/2024_03_03/Predigt - Psalm 23 - Pastorin Weber.mp3');
    cloud.delete('Audio Aufnahmen/2024/2024_03_10_Erntedank/Predigt - Danke - Pastorin Weber.mp3');
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

describe('Migration ohne Tags', () => {
  it('nimmt Titel und Album aus dem Pfad und behält nur Kategorien aus Feldern der Dateinamen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemeinde-cat-'));
    try {
      const file = join(dir, 'db.sqlite');
      const old = new Database(file);
      // Stand vor der Migration ohne Tags (spätere Migrationen laufen danach mit)
      const before = migrations.findIndex((sql) => sql.includes('DROP TABLE artist_aliases'));
      old.function('fold', (v) => (typeof v === 'string' ? v.toLowerCase() : v));
      old.function('sort_key', (v) => (typeof v === 'string' ? v.toLowerCase() : ''));
      old.function('file_stem', (v) => v);
      for (const sql of migrations.slice(0, before)) old.exec(sql);
      old.pragma(`user_version = ${before}`);
      old.prepare(
        `INSERT INTO tracks (path, etag, size, title, artist, album_artist, album, genre, year, track_no, scanned_at, display_artist)
         VALUES ('Chor/Advent (2020)/03 Macht hoch.mp3', 'e1', 1, 'Tag-Titel', 'Chör', 'Gemeinde', 'Tag-Album', 'Lied', 1999, 9, 0, 'Chör')`,
      ).run();
      old.prepare("INSERT INTO track_tags (track_id, tag, value, vkey) VALUES (1, 'genre', 'Lied', 'lied')").run();
      old.prepare("INSERT INTO track_tags (track_id, tag, value, vkey, derived) VALUES (1, 'inhalt', 'Lied', 'lied', 1)").run();
      old.prepare("INSERT INTO track_overrides (path, title, speaker) VALUES ('Chor/Advent (2020)/03 Macht hoch.mp3', NULL, 'Anna')").run();
      old.close();

      const db = openDatabase(file);
      expect(db.prepare('SELECT title, album, year, track_no AS trackNo, speaker, search_extra AS extra FROM tracks').get()).toEqual({
        title: 'Macht hoch',
        album: 'Advent',
        year: 2020,
        trackNo: 3,
        speaker: null,
        extra: 'Anna',
      });
      expect(db.prepare('SELECT tag, value FROM track_tags').all()).toEqual([{ tag: 'inhalt', value: 'Lied' }]);
      expect(db.prepare('SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?').all('macht')).toEqual([{ rowid: 1 }]);
      expect(db.prepare('SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?').all('chor')).toEqual([]);
      // "Interpreten" und "Genre" lasen nur Tags und entfallen; "Sprecher" liest nur noch das Feld aus dem Dateinamen
      expect(db.prepare('SELECT slug FROM categories ORDER BY position').all()).toEqual([{ slug: 'sprecher' }, { slug: 'inhalt' }]);
      expect(db.prepare("SELECT tag FROM category_fields WHERE category_id = (SELECT id FROM categories WHERE slug = 'sprecher')").all()).toEqual([
        { tag: 'sprecher' },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
