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
  it('fasst Zusätze wie "(Remastered)", Abweichler und Titel ohne Album-Tag zum Hauptalbum', async () => {
    for (let i = 1; i <= 4; i++) {
      cloud.put(`Chor/Live 2020/0${i}.mp3`, mp3({ title: `Lied ${i}`, artist: 'Chor', album: 'Live 2020', track: i }));
    }
    cloud.put('Chor/Live 2020/05.mp3', mp3({ title: 'Lied 5', artist: 'Chor', album: 'Live 2020 (Remastered)', track: 5 }));
    cloud.put('Chor/Live 2020/06.mp3', mp3({ title: 'Zugabe', artist: 'Chor', album: 'Zugaben', track: 6 }));
    cloud.put('Chor/Live 2020/07 - Ausklang.mp3', mp3({ artist: 'Chor' }));
    await ctx.scanner.scan();
    const list = await albums();
    expect(list.map((a) => [a.title, a.trackCount])).toEqual([['Live 2020', 7]]);
  });

  it('teilt echte Sammelordner weiterhin nach Album auf', async () => {
    cloud.put('Downloads/a.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion' }));
    cloud.put('Downloads/b.mp3', mp3({ title: 'Königlich', artist: 'Outbreakband', album: 'Unser Gott' }));
    cloud.put('Downloads/c.mp3', mp3({ title: 'Wo ich auch stehe', artist: 'Outbreakband', album: 'Unser Gott' }));
    await ctx.scanner.scan();
    expect((await albums('&sort=title')).map((a) => [a.title, a.trackCount])).toEqual([
      ['Unser Gott', 2],
      ['Zion', 1],
    ]);
  });
});

describe('Wiedererkennen nach Änderungen', () => {
  beforeEach(async () => {
    cloud.put('Hillsong/Zion/01.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion', track: 1 }));
    cloud.put('Hillsong/Zion/02.mp3', mp3({ title: 'Relentless', artist: 'Hillsong United', album: 'Zion', track: 2 }));
    await ctx.scanner.scan();
  });

  it('behält Album-ID, Favorit und Korrektur, wenn der Album-Tag korrigiert wird', async () => {
    const [album] = await albums();
    await call('PUT', `/api/me/favorites/album/${album.id}`, undefined, 204);
    await call('PATCH', `/api/admin/albums/${album.id}`, { genre: 'Lobpreis' });
    cloud.put('Hillsong/Zion/01.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion (Deluxe)', track: 1 }));
    cloud.put('Hillsong/Zion/02.mp3', mp3({ title: 'Relentless', artist: 'Hillsong United', album: 'Zion Deluxe', track: 2 }));
    await ctx.scanner.scan();
    const [after] = await albums();
    expect(after).toMatchObject({ id: album.id, title: 'Zion (Deluxe)', genre: 'Lobpreis' });
    expect((await get('/api/me/favorites')).albums.map((a: any) => a.id)).toEqual([album.id]);
  });

  it('behält Titel-ID, Favorit und Platz im eigenen Album, wenn Dateien verschoben werden', async () => {
    const [album] = await albums();
    const { tracks } = await get(`/api/albums/${album.id}`);
    await call('PUT', `/api/me/favorites/track/${tracks[0].id}`, undefined, 204);
    const own = await call('POST', '/api/admin/albums', { title: 'Lieblingslieder', trackIds: [tracks[1].id] }, 201);
    await call('PATCH', `/api/admin/albums/${album.id}`, { genre: 'Lobpreis' });

    cloud.move('Hillsong/Zion/01.mp3', 'Hillsong United/Zion (2013)/01 Oceans.mp3');
    cloud.move('Hillsong/Zion/02.mp3', 'Hillsong United/Zion (2013)/02 Relentless.mp3');
    const status = await ctx.scanner.scan();
    expect(status).toMatchObject({ moved: 2, updated: 0, removed: 0, added: 0 });

    const after = (await albums()).find((a) => a.title === 'Zion');
    expect(after).toMatchObject({ id: album.id, genre: 'Lobpreis' });
    expect((await get(`/api/albums/${album.id}`)).tracks.map((t: any) => t.id)).toEqual(tracks.map((t: any) => t.id));
    expect((await get('/api/me/favorites')).tracks.map((t: any) => t.id)).toEqual([tracks[0].id]);
    expect((await get(`/api/albums/${own.id}`)).tracks.map((t: any) => t.id)).toEqual([tracks[1].id]);
  });

  it('funktioniert ohne Datei-IDs weiter wie bisher (neuer Titel)', async () => {
    cloud.withoutFileIds = true;
    cloud.move('Hillsong/Zion/01.mp3', 'Hillsong/Zion/01 Oceans.mp3');
    const status = await ctx.scanner.scan();
    expect(status).toMatchObject({ moved: 0, removed: 1, added: 1 });
  });
});

describe('Neu hinzugefügt', () => {
  it('richtet sich nach dem Upload in die Nextcloud, nicht nach dem ersten Scan', async () => {
    cloud.put('A/Alt/01.mp3', mp3({ title: 'Alt', artist: 'A', album: 'Alt' }), { uploaded: 1_600_000_000 });
    cloud.put('B/Neu/01.mp3', mp3({ title: 'Neu', artist: 'B', album: 'Neu' }), { uploaded: 1_790_000_000 });
    cloud.put('C/Mittel/01.mp3', mp3({ title: 'Mittel', artist: 'C', album: 'Mittel' }), { uploaded: 1_700_000_000 });
    await ctx.scanner.scan();
    expect((await albums('&sort=recent')).map((a) => a.title)).toEqual(['Neu', 'Mittel', 'Alt']);
  });
});

describe('Sortierung', () => {
  beforeEach(async () => {
    const names = ['Über uns', 'Zion', 'abend', 'Ärger', 'Der Herr', '10 Gebote', '2 Lieder', 'The Blessing'];
    names.forEach((name, i) => cloud.put(`X/${i}/01.mp3`, mp3({ title: name, artist: name, album: name })));
    await ctx.scanner.scan();
  });

  it('sortiert Alben nach Titel mit Umlauten, Zahlen und ohne "The"', async () => {
    expect((await albums('&sort=title')).map((a) => a.title)).toEqual([
      '2 Lieder', '10 Gebote', 'abend', 'Ärger', 'The Blessing', 'Der Herr', 'Über uns', 'Zion',
    ]);
  });

  it('sortiert Interpreten genauso', async () => {
    expect((await get('/api/artists?limit=50')).items.map((a: any) => a.name)).toEqual([
      '2 Lieder', '10 Gebote', 'abend', 'Ärger', 'The Blessing', 'Der Herr', 'Über uns', 'Zion',
    ]);
  });
});

describe('Interpreten zusammenführen', () => {
  beforeEach(async () => {
    cloud.put('H/A/01.mp3', mp3({ title: 'Eins', artist: 'Hillsong United', album: 'A' }));
    cloud.put('H/B/01.mp3', mp3({ title: 'Zwei', artist: 'Hillsong UNITED', album: 'B' }));
    cloud.put('H/C/01.mp3', mp3({ title: 'Drei', artist: 'Hillsong United feat. Anna & Ben', album: 'C' }));
    await ctx.scanner.scan();
  });

  it('fasst Schreibweisen zusammen und führt Gäste als eigene Interpreten', async () => {
    expect((await get('/api/artists')).items).toEqual([
      { name: 'Anna', albumCount: 1, trackCount: 1 },
      { name: 'Ben', albumCount: 1, trackCount: 1 },
      { name: 'Hillsong United', albumCount: 3, trackCount: 3 },
    ]);
  });

  it('findet über den Interpreten alle Titel und Alben, auch mit Gastauftritt', async () => {
    expect((await get('/api/tracks?artist=hillsong%20united')).items.map((t: any) => t.title).sort()).toEqual(['Drei', 'Eins', 'Zwei']);
    expect((await get('/api/tracks?artist=Ben')).items.map((t: any) => t.title)).toEqual(['Drei']);
    expect((await albums('&artist=Ben')).map((a) => a.title)).toEqual(['C']);
  });
});

describe('Suche', () => {
  beforeEach(async () => {
    cloud.put('A/Lieder über Gnade/01.mp3', mp3({ title: 'Wunderbar', artist: 'Chor', album: 'Lieder über Gnade' }));
    cloud.put('B/Gnade/01.mp3', mp3({ title: 'Eins', artist: 'Band', album: 'Gnade' }));
    cloud.put('C/Sammlung/01.mp3', mp3({ title: 'Gnade genügt', artist: 'Zoe', album: 'Sammlung' }));
    cloud.put('C/Sammlung/02.mp3', mp3({ title: 'Seine Gnade', artist: 'Anna', album: 'Sammlung' }));
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
    cloud.put('GD/2026-09-20/10 Schluss.mp3', mp3({ title: 'Predigt B2', artist: 'P', track: 2 }));
    cloud.put('GD/2026-09-20/9 Anfang.mp3', mp3({ title: 'Predigt B1', artist: 'P', track: 1 }));
    cloud.put('GD/2026-09-27/Predigt.mp3', mp3({ title: 'Predigt C', artist: 'P' }));
    cloud.put('Archiv/Predigt ohne Datum.mp3', mp3({ title: 'Predigt A', artist: 'P' }));
    await ctx.scanner.scan();
    const own = await call('POST', '/api/admin/albums', { title: 'Alle Predigten' }, 201);
    await call('POST', `/api/admin/albums/${own.id}/rules`, { field: 'title', op: 'contains', value: 'Predigt' });
    expect((await get(`/api/albums/${own.id}`)).tracks.map((t: any) => t.title)).toEqual([
      'Predigt C', 'Predigt B1', 'Predigt B2', 'Predigt A',
    ]);
  });
});

describe('Hinweise zur Datenqualität', () => {
  it('zeigt aufgeteilte Ordner, fehlende Cover, Gottesdienste ohne Sprecher und auffällige Interpreten', async () => {
    cloud.put('Downloads/a.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion' }));
    cloud.put('Downloads/b.mp3', mp3({ title: 'Königlich', artist: 'Hillsong UNITED', album: 'Unser Gott' }));
    cloud.put('GD/2026-09-27/Predigt.mp3', mp3({ title: 'Predigt' }));
    cloud.put('Chor/2019/01.mp3', mp3({ title: 'Lied', artist: '2019', album: 'Chor' }));
    await ctx.scanner.scan();
    const report = await get('/api/admin/quality');
    expect(report.splitFolders).toEqual([
      { folder: 'Downloads', albums: [expect.objectContaining({ title: 'Unser Gott' }), expect.objectContaining({ title: 'Zion' })] },
    ]);
    expect(report.withoutCover.total).toBe(3);
    expect(report.servicesWithoutSpeaker.items.map((a: any) => a.date)).toEqual(['2026-09-27']);
    // Die Predigt ohne Interpret steht unter der Art ("Gottesdienst"), nicht als unbekannt
    expect(report.suspiciousArtists.map((a: any) => a.name).sort()).toEqual(['2019']);
    expect(report.artistVariants).toEqual([{ names: ['Hillsong UNITED', 'Hillsong United'], trackCount: 2 }]);
  });
});
