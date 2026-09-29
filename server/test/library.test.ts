import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HEAD_BYTES } from '../src/library/scanner.js';
import { VARIOUS_ARTISTS } from '../src/library/albums.js';
import { flac, mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';

const ADMIN_TOKEN = 'geheim-admin';

let cloud: FakeNextcloud;
let ctx: AppContext;

interface AlbumJson {
  id: number;
  title: string;
  artist: string;
  year: number | null;
  genre: string | null;
  trackCount: number;
  hasCover: boolean;
  tracks?: Array<{ id: number; title: string; artist: string; trackNo: number | null; discNo: number | null }>;
}

async function get<T = any>(url: string): Promise<T> {
  const res = await ctx.app.inject({ method: 'GET', url });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

async function albums(query = ''): Promise<AlbumJson[]> {
  return (await get<{ items: AlbumJson[] }>(`/api/albums?limit=500${query}`)).items;
}

async function albumByTitle(title: string): Promise<AlbumJson> {
  const album = (await albums()).find((a) => a.title === title);
  expect(album, `Album ${title}`).toBeDefined();
  return get<AlbumJson>(`/api/albums/${album!.id}`);
}

function seedLibrary(): void {
  // Klassisch getaggtes Album mit Cover
  cloud.put('Hillsong/Let There Be Light/01 Behold.mp3', mp3({ title: 'Behold', artist: 'Hillsong', album: 'Let There Be Light', track: 1, year: 2016, genre: 'worship' }));
  cloud.put('Hillsong/Let There Be Light/02 What a Beautiful Name.mp3', mp3({ title: 'What a Beautiful Name', artist: 'Hillsong', album: 'Let There Be Light', track: 2, year: 2016, genre: 'Worship' }));
  cloud.put('Hillsong/Let There Be Light/cover.jpg', Buffer.from('JPEGDATA'));
  cloud.put('Hillsong/Let There Be Light/scan.jpg', Buffer.from('OTHER'));
  // Sampler ohne Album-Interpret: ein Album, nicht eines pro Interpret
  cloud.put('Sampler/Feiert Jesus 20/01.mp3', mp3({ title: 'Lied Eins', artist: 'Anna', album: 'Feiert Jesus 20', track: 1, year: 2014 }));
  cloud.put('Sampler/Feiert Jesus 20/02.mp3', mp3({ title: 'Lied Zwei', artist: 'Bert', album: 'Feiert Jesus 20', track: 2, year: 2014 }));
  cloud.put('Sampler/Feiert Jesus 20/03.mp3', mp3({ title: 'Lied Drei', artist: 'Clara', album: 'Feiert Jesus 20', track: 3, year: 2014 }));
  // Doppel-CD in Disc-Ordnern
  cloud.put('Bach/Weihnachtsoratorium/CD 1/01 Jauchzet.flac', flac({ title: 'Jauchzet, frohlocket', artist: 'J. S. Bach', album: 'Weihnachtsoratorium', track: 1, disc: 1, genre: 'Klassik', year: 1998 }));
  cloud.put('Bach/Weihnachtsoratorium/CD 2/01 Und es waren Hirten.flac', flac({ title: 'Und es waren Hirten', artist: 'J. S. Bach', album: 'Weihnachtsoratorium', track: 1, disc: 2, genre: 'Klassik', year: 1998 }));
  cloud.put('Bach/Weihnachtsoratorium/CD 2/folder.jpg', Buffer.from('BACHCOVER'));
  // Ungetaggt: alles aus dem Pfad
  cloud.put('Gemeindechor/Adventskonzert (2021)/01 - Macht hoch die Tür.mp3', mp3({}));
  cloud.put('Gemeindechor/Adventskonzert (2021)/02 - Tochter Zion.mp3', mp3({}));
  // Sammelordner mit Titeln aus zwei Alben
  cloud.put('Downloads/a.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion', year: 2013 }));
  cloud.put('Downloads/b.mp3', mp3({ title: 'Königlich', artist: 'Outbreakband', album: 'Unser Gott', year: 2018 }));
  // Wird ignoriert
  cloud.put('.trash/alt.mp3', mp3({ title: 'Alt' }));
  cloud.put('Hillsong/liesmich.txt', Buffer.from('nichts'));
}

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik Bibliothek');
  await cloud.start();
  seedLibrary();
  const config = loadConfig({
    NEXTCLOUD_URL: cloud.url,
    NEXTCLOUD_USER: USER,
    NEXTCLOUD_PASSWORD: PASSWORD,
    NEXTCLOUD_MUSIC_PATH: '/Musik Bibliothek/',
    DATABASE_PATH: ':memory:',
    ADMIN_TOKEN,
  });
  ctx = await buildApp(config, { logger: false });
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('Scan und automatische Alben', () => {
  beforeEach(async () => {
    const status = await ctx.scanner.scan();
    expect(status).toMatchObject({ state: 'idle', filesSeen: 11, added: 11, failed: 0 });
  });

  it('bildet sinnvolle Alben', async () => {
    const titles = (await albums('&sort=title')).map((a) => `${a.artist} – ${a.title} (${a.trackCount})`);
    expect(titles).toEqual([
      'Gemeindechor – Adventskonzert (2)',
      `${VARIOUS_ARTISTS} – Feiert Jesus 20 (3)`,
      'Hillsong – Let There Be Light (2)',
      'Outbreakband – Unser Gott (1)',
      'J. S. Bach – Weihnachtsoratorium (2)',
      'Hillsong United – Zion (1)',
    ]);
  });

  it('fasst Disc-Ordner zusammen und sortiert nach Disc und Track', async () => {
    const album = await albumByTitle('Weihnachtsoratorium');
    expect(album.tracks!.map((t) => [t.discNo, t.trackNo, t.title])).toEqual([
      [1, 1, 'Jauchzet, frohlocket'],
      [2, 1, 'Und es waren Hirten'],
    ]);
    expect(album).toMatchObject({ genre: 'Klassik', year: 1998, hasCover: true });
  });

  it('übernimmt Jahr und Titel aus dem Ordner, wenn Tags fehlen', async () => {
    const album = await albumByTitle('Adventskonzert');
    expect(album.year).toBe(2021);
    expect(album.tracks!.map((t) => t.title)).toEqual(['Macht hoch die Tür', 'Tochter Zion']);
  });

  it('liefert das beste Cover und streamt es über den Server', async () => {
    const album = await albumByTitle('Let There Be Light');
    expect(album.hasCover).toBe(true);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/albums/${album.id}/cover` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('JPEGDATA');
    expect((await albumByTitle('Zion')).hasCover).toBe(false);
  });

  it('findet per Volltext mit Präfix und ohne Umlaute', async () => {
    const titles = async (q: string) =>
      (await get<{ items: Array<{ title: string }> }>(`/api/tracks?q=${encodeURIComponent(q)}`)).items.map((t) => t.title);
    expect(await titles('beautiful nam')).toEqual(['What a Beautiful Name']);
    expect(await titles('konig')).toEqual(['Königlich']);
    expect(await titles('tur')).toEqual(['Macht hoch die Tür']);
    expect(await titles('"; DROP TABLE tracks; --')).toEqual([]);
    expect(await titles('***')).toEqual([]);
  });

  it('filtert Titel und Alben nach Interpret, Genre und Jahrzehnt', async () => {
    const byArtist = await get<{ total: number }>('/api/tracks?artist=hillsong');
    expect(byArtist.total).toBe(2);
    expect((await albums('&genre=worship')).map((a) => a.title)).toEqual(['Let There Be Light']);
    expect((await albums('&decade=2010&sort=year')).map((a) => a.title)).toEqual([
      'Unser Gott',
      'Let There Be Light',
      'Feiert Jesus 20',
      'Zion',
    ]);
    // Interpret eines Sampler-Titels findet auch das Sampler-Album
    expect((await albums('&artist=Bert')).map((a) => a.title)).toEqual(['Feiert Jesus 20']);
    expect((await albums('&q=clara')).map((a) => a.title)).toEqual(['Feiert Jesus 20']);
  });

  it('liefert Filterwerte und Interpreten', async () => {
    const facets = await get('/api/facets');
    expect(facets.genres).toEqual([
      { value: 'Klassik', count: 2 },
      { value: 'Worship', count: 2 },
    ]);
    expect(facets.decades.map((d: { value: number }) => d.value)).toEqual([2020, 2010, 1990]);
    expect(facets.totals).toMatchObject({ tracks: 11, albums: 6 });

    const artists = await get('/api/artists?q=hill');
    expect(artists.items).toEqual([
      { name: 'Hillsong', albumCount: 1, trackCount: 2 },
      { name: 'Hillsong United', albumCount: 1, trackCount: 1 },
    ]);
  });

  it('prüft Eingaben', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/albums?sort=evil' })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/tracks?limit=100000' })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/albums/999' })).statusCode).toBe(404);
  });
});

describe('Inkrementeller Scan', () => {
  it('liest nur neue und geänderte Dateien und behält Album-IDs', async () => {
    await ctx.scanner.scan();
    const before = await albumByTitle('Let There Be Light');
    const firstGets = cloud.gets().length;
    expect(firstGets).toBe(11);
    expect(cloud.requests.find((r) => r.method === 'GET')?.range).toBe(`bytes=0-${HEAD_BYTES - 1}`);

    expect(await ctx.scanner.scan()).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(cloud.gets().length).toBe(firstGets);

    cloud.put('Hillsong/Let There Be Light/02 What a Beautiful Name.mp3', mp3({ title: 'What A Beautiful Name (Live)', artist: 'Hillsong', album: 'Let There Be Light', track: 2 }));
    cloud.put('Hillsong/Let There Be Light/03 Neu.mp3', mp3({ title: 'Neu', artist: 'Hillsong', album: 'Let There Be Light', track: 3 }));
    cloud.delete('Downloads/a.mp3');
    expect(await ctx.scanner.scan()).toMatchObject({ added: 1, updated: 1, removed: 1 });
    expect(cloud.gets().length).toBe(firstGets + 2);

    const after = await albumByTitle('Let There Be Light');
    expect(after.id).toBe(before.id);
    expect(after.tracks!.map((t) => t.title)).toEqual(['Behold', 'What A Beautiful Name (Live)', 'Neu']);
    expect((await albums()).some((a) => a.title === 'Zion')).toBe(false);
  });

  it('löscht keine Titel aus Ordnern, die gerade nicht lesbar sind', async () => {
    await ctx.scanner.scan();
    cloud.brokenDirs.add('Bach');
    const status = await ctx.scanner.scan();
    expect(status).toMatchObject({ state: 'idle', removed: 0 });
    expect((await albumByTitle('Weihnachtsoratorium')).trackCount).toBe(2);
  });

  it('meldet einen Fehler, wenn der Musikordner fehlt, und lässt die Bibliothek stehen', async () => {
    await ctx.scanner.scan();
    cloud.brokenDirs.add('');
    const status = await ctx.scanner.scan();
    expect(status.state).toBe('failed');
    expect(status.lastError).toContain('HTTP 500');
    expect((await albums()).length).toBe(6);
  });

  it('meldet einen falsch eingestellten Musikordner verständlich', async () => {
    const other = await buildApp(
      loadConfig({
        NEXTCLOUD_URL: cloud.url,
        NEXTCLOUD_USER: USER,
        NEXTCLOUD_PASSWORD: PASSWORD,
        NEXTCLOUD_MUSIC_PATH: '/Gibt es nicht',
        DATABASE_PATH: ':memory:',
      }),
      { logger: false },
    );
    const status = await other.scanner.scan();
    await other.app.close();
    expect(status.state).toBe('failed');
    expect(status.lastError).toBe('Musikordner nicht gefunden: /Gibt es nicht (NEXTCLOUD_MUSIC_PATH prüfen)');
  });

  it('funktioniert auch mit Servern, die Range ignorieren', async () => {
    cloud.ignoreRange = true;
    expect(await ctx.scanner.scan()).toMatchObject({ added: 11, failed: 0 });
  });
});

describe('Streaming und Admin', () => {
  beforeEach(async () => {
    await ctx.scanner.scan();
  });

  it('streamt Titel mit Range-Unterstützung, ohne Zugangsdaten preiszugeben', async () => {
    const { items } = await get<{ items: Array<{ id: number }> }>('/api/tracks?q=behold');
    const url = `/api/tracks/${items[0]!.id}/stream`;
    const full = await ctx.app.inject({ method: 'GET', url });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('audio/mpeg');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers.authorization).toBeUndefined();

    const part = await ctx.app.inject({ method: 'GET', url, headers: { range: 'bytes=0-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(10);
    expect(part.rawPayload.subarray(0, 3).toString()).toBe('ID3');
    expect(part.headers['content-range']).toMatch(/^bytes 0-9\/\d+$/);
  });

  it('streamt große Dateien über eine echte HTTP-Verbindung vollständig', async () => {
    cloud.put('Gross/Album/01 Lang.mp3', mp3({ title: 'Lang', artist: 'Gross', album: 'Album' }, 12_000));
    await ctx.scanner.scan();
    const { items } = await get<{ items: Array<{ id: number }> }>('/api/tracks?q=lang');
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/tracks/${items[0]!.id}/stream`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(body.length).toBe(cloud.files.get('Gross/Album/01 Lang.mp3')!.data.length);
    expect(body.length).toBeGreaterThan(4_000_000);
  });

  it('meldet 404, wenn die Datei inzwischen gelöscht wurde', async () => {
    const { items } = await get<{ items: Array<{ id: number }> }>('/api/tracks?q=behold');
    cloud.delete('Hillsong/Let There Be Light/01 Behold.mp3');
    const res = await ctx.app.inject({ method: 'GET', url: `/api/tracks/${items[0]!.id}/stream` });
    expect(res.statusCode).toBe(404);
  });

  it('startet manuelle Scans nur mit Admin-Token', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/api/scan' })).statusCode).toBe(401);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/scan', headers: { authorization: 'Bearer falsch' } })).statusCode,
    ).toBe(401);
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/scan', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ started: true, status: { state: 'running' } });
    await ctx.scanner.scan();
    expect(await get('/api/scan')).toMatchObject({ state: 'idle', lastSuccessAt: expect.any(String) });
  });
});
