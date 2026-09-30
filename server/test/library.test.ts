import { createServer, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HEAD_BYTES } from '../src/library/scanner.js';
import { flac, mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

let cloud: FakeNextcloud;
let ctx: AppContext;
let cookie = '';
/** Anfrage mit angemeldeter Sitzung */
const inject = (options: InjectOptions) => ctx.app.inject({ ...options, headers: { cookie, ...options.headers } });

interface AlbumJson {
  id: number;
  title: string;
  year: number | null;
  trackCount: number;
  hasCover: boolean;
  tracks?: Array<{ id: number; title: string; trackNo: number | null; discNo: number | null }>;
}

async function get<T = any>(url: string): Promise<T> {
  const res = await inject({ method: 'GET', url });
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
  // Tags in den Dateien zählen nicht: Album ist der Ordner, Titel der Dateiname
  cloud.put('Hillsong/Let There Be Light/01 Behold.mp3', mp3({ title: 'Anders', artist: 'Hillsong', album: 'Tag-Album', track: 9, year: 2016, genre: 'worship' }));
  cloud.put('Hillsong/Let There Be Light/02 What a Beautiful Name.mp3', mp3({ title: 'What a Beautiful Name', artist: 'Hillsong', album: 'Let There Be Light' }));
  cloud.put('Hillsong/Let There Be Light/cover.jpg', Buffer.from('JPEGDATA'));
  cloud.put('Hillsong/Let There Be Light/scan.jpg', Buffer.from('OTHER'));
  // Titel mit verschiedenen Album-Tags in einem Ordner bleiben ein Album
  cloud.put('Sampler/Feiert Jesus 20/01 Lied Eins.mp3', mp3({ title: 'Lied Eins', artist: 'Anna', album: 'Feiert Jesus 20' }));
  cloud.put('Sampler/Feiert Jesus 20/02 Lied Zwei.mp3', mp3({ title: 'Lied Zwei', artist: 'Bert', album: 'Anderes Album' }));
  cloud.put('Sampler/Feiert Jesus 20/03 Lied Drei.mp3', mp3({ title: 'Lied Drei', artist: 'Clara' }));
  // Doppel-CD in Disc-Ordnern
  cloud.put('Bach/Weihnachtsoratorium (1998)/CD 1/01 Jauchzet, frohlocket.flac', flac({ title: 'Jauchzet', album: 'Weihnachtsoratorium', track: 1, disc: 1 }));
  cloud.put('Bach/Weihnachtsoratorium (1998)/CD 2/01 Und es waren Hirten.flac', flac({ title: 'Hirten', album: 'Weihnachtsoratorium', track: 1, disc: 2 }));
  cloud.put('Bach/Weihnachtsoratorium (1998)/CD 2/folder.jpg', Buffer.from('BACHCOVER'));
  // Ohne Tags
  cloud.put('Gemeindechor/Adventskonzert (2021)/01 - Macht hoch die Tür.mp3', mp3({}));
  cloud.put('Gemeindechor/Adventskonzert (2021)/02 - Tochter Zion.mp3', mp3({}));
  // Sammelordner: ein Album, auch wenn die Tags zwei Alben nennen
  cloud.put('Downloads/Oceans.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion', year: 2013 }));
  cloud.put('Downloads/Königlich.mp3', mp3({ title: 'Königlich', artist: 'Outbreakband', album: 'Unser Gott', year: 2018 }));
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
  });
  ctx = await buildApp(config, { logger: false });
  cookie = sessionCookie(ctx.db);
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

  it('bildet ein Album je Ordner, mit Titeln aus den Dateinamen', async () => {
    const titles = (await albums('&sort=title')).map((a) => `${a.title} (${a.trackCount})`);
    expect(titles).toEqual(['Adventskonzert (2)', 'Downloads (2)', 'Feiert Jesus 20 (3)', 'Let There Be Light (2)', 'Weihnachtsoratorium (2)']);
    const light = await albumByTitle('Let There Be Light');
    expect(light.tracks!.map((t) => [t.trackNo, t.title])).toEqual([
      [1, 'Behold'],
      [2, 'What a Beautiful Name'],
    ]);
    expect(light.year).toBeNull();
    expect(light).not.toHaveProperty('artist');
    expect((await albumByTitle('Feiert Jesus 20')).tracks!.map((t) => t.title)).toEqual(['Lied Eins', 'Lied Zwei', 'Lied Drei']);
  });

  it('fasst Disc-Ordner zusammen und sortiert nach Disc und Track', async () => {
    const album = await albumByTitle('Weihnachtsoratorium');
    expect(album.tracks!.map((t) => [t.discNo, t.trackNo, t.title])).toEqual([
      [1, 1, 'Jauchzet, frohlocket'],
      [2, 1, 'Und es waren Hirten'],
    ]);
    expect(album).toMatchObject({ year: 1998, hasCover: true });
  });

  it('übernimmt Jahr und Titel aus dem Ordner', async () => {
    const album = await albumByTitle('Adventskonzert');
    expect(album.year).toBe(2021);
    expect(album.tracks!.map((t) => t.title)).toEqual(['Macht hoch die Tür', 'Tochter Zion']);
  });

  it('liefert das beste Cover und streamt es über den Server', async () => {
    const album = await albumByTitle('Let There Be Light');
    expect(album.hasCover).toBe(true);
    const res = await inject({ method: 'GET', url: `/api/albums/${album.id}/cover` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('JPEGDATA');
    expect((await albumByTitle('Downloads')).hasCover).toBe(false);
  });

  it('findet per Volltext mit Präfix und ohne Umlaute, aber nicht über Tags', async () => {
    const titles = async (q: string) =>
      (await get<{ items: Array<{ title: string }> }>(`/api/tracks?q=${encodeURIComponent(q)}`)).items.map((t) => t.title);
    expect(await titles('beautiful nam')).toEqual(['What a Beautiful Name']);
    expect(await titles('konig')).toEqual(['Königlich']);
    expect(await titles('tur')).toEqual(['Macht hoch die Tür']);
    expect(await titles('outbreakband')).toEqual([]);
    expect(await titles('"; DROP TABLE tracks; --')).toEqual([]);
    expect(await titles('***')).toEqual([]);
  });

  it('filtert nach Jahrzehnt und kennt keine Filter nach Interpret oder Genre', async () => {
    expect((await albums('&decade=2020&sort=year')).map((a) => a.title)).toEqual(['Adventskonzert']);
    expect((await inject({ method: 'GET', url: '/api/artists' })).statusCode).toBe(404);
  });

  it('liefert Filterwerte', async () => {
    const facets = await get('/api/facets');
    expect(facets).not.toHaveProperty('genres');
    expect(facets.decades.map((d: { value: number }) => d.value)).toEqual([2020, 1990]);
    expect(facets.totals).toMatchObject({ tracks: 11, albums: 5 });
  });

  it('prüft Eingaben', async () => {
    expect((await inject({ method: 'GET', url: '/api/albums?sort=evil' })).statusCode).toBe(400);
    expect((await inject({ method: 'GET', url: '/api/tracks?limit=100000' })).statusCode).toBe(400);
    expect((await inject({ method: 'GET', url: '/api/albums/999' })).statusCode).toBe(404);
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

    cloud.put('Hillsong/Let There Be Light/02 What a Beautiful Name.mp3', mp3({ title: 'Geändert' }, 40));
    cloud.put('Hillsong/Let There Be Light/03 Neu.mp3', mp3({}));
    cloud.delete('Downloads/Oceans.mp3');
    expect(await ctx.scanner.scan()).toMatchObject({ added: 1, updated: 1, removed: 1 });
    expect(cloud.gets().length).toBe(firstGets + 2);

    const after = await albumByTitle('Let There Be Light');
    expect(after.id).toBe(before.id);
    expect(after.tracks!.map((t) => t.title)).toEqual(['Behold', 'What a Beautiful Name', 'Neu']);
    expect((await albumByTitle('Downloads')).trackCount).toBe(1);
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
    expect((await albums()).length).toBe(5);
  });

  it('entfernt bei leerem Musikordner nichts, bis es bestätigt wird', async () => {
    await ctx.scanner.scan();
    for (const path of [...cloud.files.keys()]) cloud.delete(path);
    const held = await ctx.scanner.scan();
    expect(held).toMatchObject({ state: 'failed', removed: 0, heldBack: 11 });
    expect(held.lastError).toContain('Musikordner ist leer');
    expect((await albums()).length).toBe(5);
    expect((await get('/api/scan')).lastSuccessAt).not.toBeNull();

    const res = await inject({ method: 'POST', url: '/api/scan', payload: { removeMissing: true } });
    expect(res.statusCode, res.body).toBe(202);
    expect(await ctx.scanner.scan()).toMatchObject({ state: 'idle', removed: 11, heldBack: 0 });
    expect((await albums()).length).toBe(0);
  });

  it('hält auch ungewöhnlich viele fehlende Titel zurück', async () => {
    for (let i = 0; i < 25; i++) cloud.put(`Predigten/${i}.mp3`, mp3({ title: `Predigt ${i}` }));
    await ctx.scanner.scan();
    for (let i = 0; i < 25; i++) cloud.delete(`Predigten/${i}.mp3`);
    expect(await ctx.scanner.scan()).toMatchObject({ state: 'failed', removed: 0, heldBack: 25 });
    // Wenige fehlende Titel gehen wie bisher ohne Rückfrage
    cloud.delete('Downloads/Oceans.mp3');
    expect(await ctx.scanner.scan({ removeMissing: true })).toMatchObject({ state: 'idle', removed: 26 });
    cloud.delete('Downloads/Königlich.mp3');
    expect(await ctx.scanner.scan()).toMatchObject({ state: 'idle', removed: 1 });
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

  it('zeigt den Fortschritt und die erste Ursache, wenn einzelne Dateien nicht lesbar sind', async () => {
    cloud.brokenFiles.add('Downloads/Oceans.mp3');
    const status = await ctx.scanner.scan();
    expect(status).toMatchObject({ state: 'idle', filesSeen: 11, toRead: 11, read: 11, added: 10, failed: 1 });
    expect(status.lastError).toBe('Downloads/Oceans.mp3: GET Downloads/Oceans.mp3 fehlgeschlagen: HTTP 500');
    // Beim nächsten Scan wird nur die fehlende Datei erneut versucht.
    cloud.brokenFiles.clear();
    expect(await ctx.scanner.scan()).toMatchObject({ toRead: 1, read: 1, added: 1, failed: 0, lastError: null });
  });

  it('bleibt nicht an einem hängenden Download stehen', async () => {
    const quick = await buildApp(
      loadConfig({
        NEXTCLOUD_URL: cloud.url,
        NEXTCLOUD_USER: USER,
        NEXTCLOUD_PASSWORD: PASSWORD,
        NEXTCLOUD_MUSIC_PATH: '/Musik Bibliothek',
        DATABASE_PATH: ':memory:',
      }),
      { logger: false, requestTimeoutMs: 200 },
    );
    cloud.stalledFiles.add('Downloads/Königlich.mp3');
    const status = await quick.scanner.scan();
    await quick.app.close();
    expect(status).toMatchObject({ state: 'idle', added: 10, failed: 1 });
    expect(status.lastError).toBe('Downloads/Königlich.mp3: GET Downloads/Königlich.mp3: Nextcloud hat nicht innerhalb von 1 s geantwortet');
  });

  it('bricht einen Stream ab, wenn die Nextcloud gar nicht antwortet', async () => {
    const quick = await buildApp(
      loadConfig({
        NEXTCLOUD_URL: cloud.url,
        NEXTCLOUD_USER: USER,
        NEXTCLOUD_PASSWORD: PASSWORD,
        NEXTCLOUD_MUSIC_PATH: '/Musik Bibliothek',
        DATABASE_PATH: ':memory:',
      }),
      { logger: false, streamTimeoutMs: 200 },
    );
    await quick.scanner.scan();
    const { id } = quick.db.prepare("SELECT id FROM tracks WHERE path = 'Downloads/Königlich.mp3'").get() as { id: number };
    cloud.hangingFiles.add('Downloads/Königlich.mp3');
    const res = await quick.app.inject({ method: 'GET', url: `/api/tracks/${id}/stream`, headers: { cookie: sessionCookie(quick.db) } });
    await quick.app.close();
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: 'Nextcloud antwortet nicht' });
  });

  it('meldet falsche Zugangsdaten und eine nicht erreichbare Nextcloud verständlich', async () => {
    const scanWith = async (env: Record<string, string>) => {
      const other = await buildApp(
        loadConfig({
          NEXTCLOUD_URL: cloud.url,
          NEXTCLOUD_USER: USER,
          NEXTCLOUD_PASSWORD: PASSWORD,
          NEXTCLOUD_MUSIC_PATH: '/Musik Bibliothek',
          DATABASE_PATH: ':memory:',
          ...env,
        }),
        { logger: false },
      );
      const status = await other.scanner.scan();
      await other.app.close();
      return status;
    };
    expect(await scanWith({ NEXTCLOUD_PASSWORD: 'falsch' })).toMatchObject({
      state: 'failed',
      lastError: 'PROPFIND /: Nextcloud lehnt die Anmeldung ab (NEXTCLOUD_USER/NEXTCLOUD_PASSWORD prüfen)',
    });
    // Ein Port, auf dem sicher niemand mehr lauscht
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const offline = await scanWith({ NEXTCLOUD_URL: `http://127.0.0.1:${port}` });
    expect(offline.state).toBe('failed');
    expect(offline.lastError).toBe('PROPFIND /: Nextcloud nicht erreichbar (ECONNREFUSED, NEXTCLOUD_URL prüfen)');
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
    const full = await inject({ method: 'GET', url });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('audio/mpeg');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers.authorization).toBeUndefined();

    const part = await inject({ method: 'GET', url, headers: { range: 'bytes=0-9' } });
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
    const res = await fetch(`${address}/api/tracks/${items[0]!.id}/stream`, { headers: { cookie } });
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(body.length).toBe(cloud.files.get('Gross/Album/01 Lang.mp3')!.data.length);
    expect(body.length).toBeGreaterThan(4_000_000);
  });

  it('meldet 404, wenn die Datei inzwischen gelöscht wurde', async () => {
    const { items } = await get<{ items: Array<{ id: number }> }>('/api/tracks?q=behold');
    cloud.delete('Hillsong/Let There Be Light/01 Behold.mp3');
    const res = await inject({ method: 'GET', url: `/api/tracks/${items[0]!.id}/stream` });
    expect(res.statusCode).toBe(404);
  });

  it('startet manuelle Scans nur für angemeldete Manager und Admins', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/api/scan' })).statusCode).toBe(401);
    const ok = await inject({ method: 'POST', url: '/api/scan' });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ started: true, status: { state: 'running' } });
    await ctx.scanner.scan();
    expect(await get('/api/scan')).toMatchObject({ state: 'idle', lastSuccessAt: expect.any(String), folders: ['/Musik Bibliothek'] });
  });
});
