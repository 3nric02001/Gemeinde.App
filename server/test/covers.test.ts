import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HEAD_BYTES } from '../src/library/scanner.js';
import { tagSpan } from '../src/library/metadata.js';
import { flac, mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

let cloud: FakeNextcloud;
let ctx: AppContext;
let cookie = '';
/** Anfrage mit angemeldeter Sitzung */
const inject = (options: InjectOptions) => ctx.app.inject({ ...options, headers: { cookie, ...options.headers } });

const jpeg = (fill: string, size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill)]);
const RED = jpeg('r');
const BLUE = jpeg('b');
const GREEN = jpeg('g');
// Größer als der erste Lesevorgang: muss nachgeladen werden
const BIG = jpeg('x', HEAD_BYTES + 100_000);

async function get<T = any>(url: string): Promise<T> {
  const res = await inject({ method: 'GET', url });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

async function album(title: string) {
  const { items } = await get<{ items: Array<{ id: number; title: string; hasCover: boolean }> }>('/api/albums?limit=500');
  const found = items.find((a) => a.title === title)!;
  return get<{ id: number; hasCover: boolean; tracks: Array<{ id: number; title: string; hasCover: boolean }> }>(
    `/api/albums/${found.id}`,
  );
}

async function image(url: string) {
  const res = await inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.rawPayload, type: res.headers['content-type'], etag: res.headers.etag };
}

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  // Album nur mit eingebettetem Cover (kein Bild im Ordner)
  cloud.put('Chor/Advent/01.mp3', mp3({ title: 'Eins', artist: 'Chor', album: 'Advent', track: 1, picture: { data: RED, mime: 'image/jpeg' } }));
  cloud.put('Chor/Advent/02.mp3', mp3({ title: 'Zwei', artist: 'Chor', album: 'Advent', track: 2, picture: { data: RED, mime: 'image/jpeg' } }));
  // Sampler: jeder Titel mit eigenem Bild, einer ohne
  cloud.put('Sampler/Mix/01.flac', flac({ title: 'Anna', artist: 'Anna', album: 'Mix', track: 1, picture: { data: BLUE, mime: 'image/jpeg' } }));
  cloud.put('Sampler/Mix/02.mp3', mp3({ title: 'Bert', artist: 'Bert', album: 'Mix', track: 2, picture: { data: GREEN, mime: 'image/png' } }));
  cloud.put('Sampler/Mix/03.mp3', mp3({ title: 'Clara', artist: 'Clara', album: 'Mix', track: 3 }));
  // Ordnerbild hat beim Album Vorrang, der Titel behält sein eigenes Bild
  cloud.put('Band/Live/01.mp3', mp3({ title: 'Live', artist: 'Band', album: 'Live', track: 1, picture: { data: BIG, mime: 'image/jpeg' } }));
  cloud.put('Band/Live/cover.jpg', Buffer.from('ORDNERBILD'));
  // Ganz ohne Bild
  cloud.put('Ohne/Nichts/01.mp3', mp3({ title: 'Nichts', artist: 'Ohne', album: 'Nichts' }));
  const config = loadConfig({
    NEXTCLOUD_URL: cloud.url,
    NEXTCLOUD_USER: USER,
    NEXTCLOUD_PASSWORD: PASSWORD,
    NEXTCLOUD_MUSIC_PATH: '/Musik',
    DATABASE_PATH: ':memory:',
  });
  ctx = await buildApp(config, { logger: false });
  cookie = sessionCookie(ctx.db);
  expect(await ctx.scanner.scan()).toMatchObject({ state: 'idle', failed: 0 });
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('Eingebettete Cover', () => {
  it('nutzt das eingebettete Bild als Albumcover, wenn im Ordner keins liegt', async () => {
    const advent = await album('Advent');
    expect(advent.hasCover).toBe(true);
    const cover = await image(`/api/albums/${advent.id}/cover`);
    expect(cover.status).toBe(200);
    expect(cover.type).toBe('image/jpeg');
    expect(cover.body.equals(RED)).toBe(true);
    // Gleiche Bilder werden nur einmal gespeichert
    expect(ctx.db.prepare('SELECT count(*) AS n FROM covers').get()).toEqual({ n: 4 });
  });

  it('liefert pro Titel das eigene Bild und sonst das Albumcover', async () => {
    const mix = await album('Mix');
    const [anna, bert, clara] = mix.tracks;
    expect(mix.tracks.every((t) => t.hasCover)).toBe(true);
    expect((await image(`/api/tracks/${anna!.id}/cover`)).body.equals(BLUE)).toBe(true);
    const green = await image(`/api/tracks/${bert!.id}/cover`);
    expect(green.body.equals(GREEN)).toBe(true);
    expect(green.type).toBe('image/png');
    // Clara hat kein eigenes Bild: Albumcover (das des ersten Titels bei Gleichstand)
    expect((await image(`/api/tracks/${clara!.id}/cover`)).body.equals(BLUE)).toBe(true);
  });

  it('lädt große Tag-Blöcke nach und bevorzugt beim Album das Ordnerbild', async () => {
    const live = await album('Live');
    expect((await image(`/api/albums/${live.id}/cover`)).body.toString()).toBe('ORDNERBILD');
    const track = await image(`/api/tracks/${live.tracks[0]!.id}/cover`);
    expect(track.status).toBe(200);
    expect(track.body.equals(BIG)).toBe(true);
  });

  it('meldet 404 ohne Bild und unterstützt ETag', async () => {
    const nichts = await album('Nichts');
    expect(nichts.hasCover).toBe(false);
    expect(nichts.tracks[0]!.hasCover).toBe(false);
    expect((await image(`/api/tracks/${nichts.tracks[0]!.id}/cover`)).status).toBe(404);
    expect((await image('/api/tracks/99999/cover')).status).toBe(404);

    const advent = await album('Advent');
    const first = await image(`/api/tracks/${advent.tracks[0]!.id}/cover`);
    const again = await inject({
      method: 'GET',
      url: `/api/tracks/${advent.tracks[0]!.id}/cover`,
      headers: { 'if-none-match': first.etag as string },
    });
    expect(again.statusCode).toBe(304);
  });

  it('nimmt nur Rasterbilder als Cover, nie SVG oder HTML', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    cloud.put('Boese/Svg/01.mp3', mp3({ title: 'Svg', artist: 'Boese', album: 'Svg', picture: { data: svg, mime: 'image/svg+xml' } }));
    cloud.put('Boese/Html/01.mp3', mp3({ title: 'Html', artist: 'Boese', album: 'Html', picture: { data: svg, mime: 'text/html' } }));
    await ctx.scanner.scan();
    for (const title of ['Svg', 'Html']) {
      const found = await album(title);
      expect(found.hasCover, title).toBe(false);
      expect((await image(`/api/tracks/${found.tracks[0]!.id}/cover`)).status, title).toBe(404);
    }
  });

  it('schützt Cover-Antworten vor Ausführung im Browser', async () => {
    const advent = await album('Advent');
    const res = await inject({ method: 'GET', url: `/api/albums/${advent.id}/cover` });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('räumt Bilder auf, die keinem Titel mehr gehören', async () => {
    cloud.delete('Sampler/Mix/02.mp3');
    await ctx.scanner.scan();
    expect(ctx.db.prepare('SELECT count(*) AS n FROM covers').get()).toEqual({ n: 3 });
  });
});

describe('Vorschaubilder', () => {
  const photo = (width: number, height: number, format: 'png' | 'jpeg' = 'png') =>
    sharp({ create: { width, height, channels: 3, background: '#3366aa' } })[format]().toBuffer();

  it('verkleinert Ordnerbilder einmal und liefert sie danach aus dem Cache', async () => {
    cloud.put('Foto/Gross/01.mp3', mp3({ title: 'Gross', artist: 'Foto', album: 'Gross' }));
    cloud.put('Foto/Gross/cover.jpg', await photo(3000, 2000, 'jpeg'));
    await ctx.scanner.scan();
    const gross = await album('Gross');
    const url = `/api/albums/${gross.id}/cover`;

    const before = cloud.gets().length;
    const first = await image(url);
    expect(first.status).toBe(200);
    expect(first.type).toBe('image/webp');
    expect(await sharp(first.body).metadata()).toMatchObject({ format: 'webp', width: 640, height: 427 });
    expect(cloud.gets().length).toBe(before + 1);

    const again = await image(url);
    expect(again.body.equals(first.body)).toBe(true);
    expect(again.etag).toBe(first.etag);
    expect(cloud.gets().length).toBe(before + 1);

    // Neues Bild in der Nextcloud: neuer ETag nach dem Scan, neue Vorschau
    cloud.put('Foto/Gross/cover.jpg', await photo(800, 800, 'jpeg'));
    await ctx.scanner.scan();
    const changed = await image(url);
    expect(changed.etag).not.toBe(first.etag);
    expect(await sharp(changed.body).metadata()).toMatchObject({ width: 640, height: 640 });
  });

  it('öffnet Ordnerbilder nur als Rasterbild, auch wenn ein SVG .jpg heißt', async () => {
    cloud.put('Foto/Falsch/01.mp3', mp3({ title: 'Falsch', artist: 'Foto', album: 'Falsch' }));
    cloud.put('Foto/Falsch/cover.jpg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><rect width="900" height="900"/></svg>'));
    await ctx.scanner.scan();
    const res = await inject({ method: 'GET', url: `/api/albums/${(await album('Falsch')).id}/cover` });
    expect(res.headers['content-type']).not.toBe('image/webp');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(ctx.db.prepare('SELECT count(*) AS n FROM cover_thumbs').get()).toEqual({ n: 0 });
  });

  it('verkleinert eingebettete Bilder und räumt Vorschauen verschwundener Bilder auf', async () => {
    cloud.put('Foto/Tag/01.mp3', mp3({ title: 'Tag', artist: 'Foto', album: 'Tag', picture: { data: await photo(1200, 1200), mime: 'image/png' } }));
    await ctx.scanner.scan();
    const tag = await album('Tag');
    const cover = await image(`/api/tracks/${tag.tracks[0]!.id}/cover`);
    expect(cover.type).toBe('image/webp');
    expect(await sharp(cover.body).metadata()).toMatchObject({ width: 640, height: 640 });
    expect(ctx.db.prepare('SELECT count(*) AS n FROM cover_thumbs').get()).toEqual({ n: 1 });

    cloud.delete('Foto/Tag/01.mp3');
    await ctx.scanner.scan();
    expect(ctx.db.prepare('SELECT count(*) AS n FROM cover_thumbs').get()).toEqual({ n: 0 });
  });
});

describe('tagSpan', () => {
  it('kennt die Länge von ID3v2- und FLAC-Tags', () => {
    const file = mp3({ title: 'x', picture: { data: BIG, mime: 'image/jpeg' } });
    const span = tagSpan(file.subarray(0, 1024))!;
    expect(span).toBeGreaterThan(BIG.length);
    expect(file.subarray(span, span + 2)).toEqual(Buffer.from([0xff, 0xfb]));

    const f = flac({ title: 'x', picture: { data: BLUE, mime: 'image/jpeg' } });
    expect(tagSpan(f)).toBe(f.length);
    expect(tagSpan(Buffer.from('RIFF....'))).toBeUndefined();
  });
});
