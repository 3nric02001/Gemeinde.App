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
const inject = (options: InjectOptions) => ctx.app.inject({ ...options, headers: { cookie, ...options.headers } });

async function call<T = any>(method: InjectOptions['method'], url: string, payload?: unknown, status = 200): Promise<T> {
  const res = await inject({ method, url, payload: payload as InjectOptions['payload'] });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
  return (res.body ? res.json() : undefined) as T;
}
const get = <T = any>(url: string) => call<T>('GET', url);

async function albums(query = ''): Promise<any[]> {
  return (await get(`/api/albums?limit=500${query}`)).items;
}

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  const config = loadConfig({
    NEXTCLOUD_URL: cloud.url,
    NEXTCLOUD_USER: USER,
    NEXTCLOUD_PASSWORD: PASSWORD,
    NEXTCLOUD_MUSIC_PATH: '/Musik',
    DATABASE_PATH: ':memory:',
  });
  ctx = await buildApp(config, { logger: false });
  cookie = sessionCookie(ctx.db);
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('Albumbildung im Ordner', () => {
  it('macht aus einem Ordner ein Album, egal was die Tags sagen', async () => {
    for (let i = 1; i <= 4; i++) {
      cloud.put(`Chor/Live 2020/0${i} Lied ${i}.mp3`, mp3({ title: `Anders ${i}`, artist: 'Chor', album: 'Live 2020', track: 9 - i }));
    }
    cloud.put('Chor/Live 2020/05 Lied 5.mp3', mp3({ album: 'Live 2020 (Remastered)' }));
    cloud.put('Chor/Live 2020/06 Zugabe.mp3', mp3({ album: 'Zugaben' }));
    cloud.put('Downloads/Oceans.mp3', mp3({ album: 'Zion' }));
    cloud.put('Downloads/Königlich.mp3', mp3({ album: 'Unser Gott' }));
    await ctx.scanner.scan();
    const list = await albums('&sort=title');
    expect(list.map((a) => [a.title, a.trackCount])).toEqual([
      ['Downloads', 2],
      ['Live 2020', 6],
    ]);
    const live = await get(`/api/albums/${list[1].id}`);
    expect(live.tracks.map((t: any) => t.title)).toEqual(['Lied 1', 'Lied 2', 'Lied 3', 'Lied 4', 'Lied 5', 'Zugabe']);
  });
});

describe('Wiedererkennen nach Änderungen', () => {
  beforeEach(async () => {
    cloud.put('Hillsong/Zion/01 Oceans.mp3', mp3({ title: 'Oceans', album: 'Zion', track: 1 }));
    cloud.put('Hillsong/Zion/02 Relentless.mp3', mp3({ title: 'Relentless', album: 'Zion', track: 2 }));
    await ctx.scanner.scan();
  });

  it('behält Album-ID, Favorit und Korrektur, wenn sich die Dateien ändern', async () => {
    const [album] = await albums();
    await call('PUT', `/api/me/favorites/album/${album.id}`, undefined, 204);
    await call('PATCH', `/api/admin/albums/${album.id}`, { description: 'Lobpreis' });
    cloud.put('Hillsong/Zion/01 Oceans.mp3', mp3({ title: 'Oceans', album: 'Zion (Deluxe)', track: 1 }, 30));
    cloud.put('Hillsong/Zion/02 Relentless.mp3', mp3({ title: 'Relentless', album: 'Zion Deluxe', track: 2 }, 30));
    await ctx.scanner.scan();
    const [after] = await albums();
    expect(after).toMatchObject({ id: album.id, title: 'Zion', description: 'Lobpreis' });
    expect((await get('/api/me/favorites')).albums.map((a: any) => a.id)).toEqual([album.id]);
  });

  it('behält Album-ID, Titel-ID, Favorit und Platz im eigenen Album, wenn Dateien verschoben werden', async () => {
    const [album] = await albums();
    const { tracks } = await get(`/api/albums/${album.id}`);
    await call('PUT', `/api/me/favorites/track/${tracks[0].id}`, undefined, 204);
    const own = await call('POST', '/api/admin/albums', { title: 'Lieblingslieder', trackIds: [tracks[1].id] }, 201);
    await call('PATCH', `/api/admin/albums/${album.id}`, { description: 'Lobpreis' });

    cloud.move('Hillsong/Zion/01 Oceans.mp3', 'Hillsong United/Zion (2013)/01 Oceans.mp3');
    cloud.move('Hillsong/Zion/02 Relentless.mp3', 'Hillsong United/Zion (2013)/02 Relentless.mp3');
    const status = await ctx.scanner.scan();
    expect(status).toMatchObject({ moved: 2, updated: 0, removed: 0, added: 0 });

    const after = (await albums()).find((a) => a.title === 'Zion');
    expect(after).toMatchObject({ id: album.id, year: 2013, description: 'Lobpreis' });
    expect((await get(`/api/albums/${album.id}`)).tracks.map((t: any) => t.id)).toEqual(tracks.map((t: any) => t.id));
    expect((await get('/api/me/favorites')).tracks.map((t: any) => t.id)).toEqual([tracks[0].id]);
    expect((await get(`/api/albums/${own.id}`)).tracks.map((t: any) => t.id)).toEqual([tracks[1].id]);
  });

  it('funktioniert ohne Datei-IDs weiter wie bisher (neuer Titel)', async () => {
    cloud.withoutFileIds = true;
    cloud.move('Hillsong/Zion/01 Oceans.mp3', 'Hillsong/Zion/01 Ocean.mp3');
    const status = await ctx.scanner.scan();
    expect(status).toMatchObject({ moved: 0, removed: 1, added: 1 });
  });
});

describe('Neu hinzugefügt', () => {
  it('richtet sich nach dem Upload in die Nextcloud, nicht nach dem ersten Scan', async () => {
    cloud.put('A/Alt/01 Alt.mp3', mp3({}), { uploaded: 1_600_000_000 });
    cloud.put('B/Neu/01 Neu.mp3', mp3({}), { uploaded: 1_790_000_000 });
    cloud.put('C/Mittel/01 Mittel.mp3', mp3({}), { uploaded: 1_700_000_000 });
    await ctx.scanner.scan();
    expect((await albums('&sort=recent')).map((a) => a.title)).toEqual(['Neu', 'Mittel', 'Alt']);
  });
});

describe('Sortierung', () => {
  it('sortiert Alben nach Titel mit Umlauten, Zahlen und ohne "The"', async () => {
    const names = ['Über uns', 'Zion', 'abend', 'Ärger', 'Der Herr', '10 Gebote', '2 Lieder', 'The Blessing'];
    names.forEach((name) => cloud.put(`X/${name}/01 Lied.mp3`, mp3({})));
    await ctx.scanner.scan();
    expect((await albums('&sort=title')).map((a) => a.title)).toEqual([
      '2 Lieder', '10 Gebote', 'abend', 'Ärger', 'The Blessing', 'Der Herr', 'Über uns', 'Zion',
    ]);
  });
});

describe('Suche', () => {
  beforeEach(async () => {
    cloud.put('A/Lieder über Gnade/01 Wunderbar.mp3', mp3({}));
    cloud.put('B/Gnade/01 Eins.mp3', mp3({}));
    cloud.put('C/Sammlung/01 Gnade genügt.mp3', mp3({}));
    cloud.put('C/Sammlung/02 Seine Gnade.mp3', mp3({}));
    await ctx.scanner.scan();
  });

  it('stellt Alben, deren Titel passt, vor Alben, in denen nur ein Titel passt', async () => {
    expect((await albums('&q=gnade')).map((a) => a.title)).toEqual(['Gnade', 'Lieder über Gnade', 'Sammlung']);
  });

  it('stellt Titel, die mit dem Suchbegriff beginnen, vor andere Treffer', async () => {
    expect((await get('/api/tracks?q=gnade')).items.map((t: any) => t.title)).toEqual(['Gnade genügt', 'Seine Gnade', 'Eins', 'Wunderbar']);
  });
});

describe('Regeln', () => {
  it('ordnet nach Datum, innerhalb eines Gottesdienstes nach Tracknummer', async () => {
    cloud.put('GD/2026-09-20/10 Predigt - B2.mp3', mp3({}));
    cloud.put('GD/2026-09-20/9 Predigt - B1.mp3', mp3({}));
    cloud.put('GD/2026-09-27/Predigt - C.mp3', mp3({}));
    cloud.put('Archiv/Predigt ohne Datum.mp3', mp3({}));
    await ctx.scanner.scan();
    const own = await call('POST', '/api/admin/albums', { title: 'Alle Predigten' }, 201);
    await call('POST', `/api/admin/albums/${own.id}/rules`, { field: 'content', op: 'equals', value: 'Predigt' });
    expect((await get(`/api/albums/${own.id}`)).tracks.map((t: any) => t.title)).toEqual(['Predigt: C', 'Predigt: B1', 'Predigt: B2']);
    await call('POST', `/api/admin/albums/${own.id}/rules`, { field: 'path', op: 'contains', value: 'Archiv' });
    expect((await get(`/api/albums/${own.id}`)).tracks.map((t: any) => t.title)).toEqual([
      'Predigt: C', 'Predigt: B1', 'Predigt: B2', 'Predigt ohne Datum',
    ]);
  });

  it('lehnt Bedingungen auf Interpret und Genre ab und übergeht gespeicherte', async () => {
    cloud.put('Archiv/Predigt.mp3', mp3({}));
    await ctx.scanner.scan();
    const own = await call('POST', '/api/admin/albums', { title: 'Alt' }, 201);
    await call('POST', `/api/admin/albums/${own.id}/rules`, { field: 'artist', op: 'contains', value: 'X' }, 400);
    // Regel aus der Zeit mit Tags: die Bedingung auf den Interpreten entfällt, der Rest gilt
    ctx.db
      .prepare('INSERT INTO album_rules (album_id, condition, move, created_at) VALUES (?, ?, 0, 0)')
      .run(own.id, JSON.stringify({ match: 'all', conditions: [{ field: 'artist', op: 'contains', value: 'Meier' }, { field: 'title', op: 'contains', value: 'Predigt' }] }));
    ctx.db
      .prepare('INSERT INTO album_rules (album_id, condition, move, created_at) VALUES (?, ?, 0, 0)')
      .run(own.id, JSON.stringify({ field: 'genre', op: 'equals', value: 'Rock' }));
    await ctx.scanner.scan();
    expect((await get(`/api/albums/${own.id}`)).tracks.map((t: any) => t.title)).toEqual(['Predigt']);
  });
});

describe('Hinweise zur Datenqualität', () => {
  it('zeigt fehlende Cover, aber keine Gottesdienste ohne Sprecher mehr', async () => {
    cloud.put('Downloads/Oceans.mp3', mp3({}));
    cloud.put('GD/2026-09-27/Predigt - Psalm 23.mp3', mp3({}));
    cloud.put('GD/2026-10-04/Predigt - Psalm 24 - Anna Schulz.mp3', mp3({}));
    await ctx.scanner.scan();
    const report = await get('/api/admin/quality');
    expect(Object.keys(report).sort()).toEqual(['withoutCover']);
    expect(report.withoutCover.items.map((a: any) => a.title)).toEqual(['Downloads']);
  });
});
