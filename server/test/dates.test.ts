import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { parseFolderDate } from '../src/library/dates.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

describe('parseFolderDate', () => {
  it('erkennt übliche Schreibweisen', () => {
    expect(parseFolderDate('2026-09-27 Gottesdienst')).toBe('2026-09-27');
    expect(parseFolderDate('2026_09_27')).toBe('2026-09-27');
    expect(parseFolderDate('20260927_Predigt')).toBe('2026-09-27');
    expect(parseFolderDate('Gottesdienst 27.09.2026')).toBe('2026-09-27');
    expect(parseFolderDate('GD 7.9.26')).toBe('2026-09-07');
    expect(parseFolderDate('27. September 2026 Erntedank')).toBe('2026-09-27');
    expect(parseFolderDate('3 März 2025')).toBe('2025-03-03');
  });

  it('nimmt ein fehlendes Jahr nur, wenn es vorgegeben ist', () => {
    expect(parseFolderDate('Gottesdienst 27.09.')).toBeUndefined();
    expect(parseFolderDate('Gottesdienst 27.09.', 2025)).toBe('2025-09-27');
    expect(parseFolderDate('3. Mai Konfirmation', 2025)).toBe('2025-05-03');
    // Ohne Punkt nach dem Tag kein Datum: "Teil 3 Mai…"
    expect(parseFolderDate('Teil 3 Maienlied', 2025)).toBeUndefined();
  });

  it('ignoriert Namen ohne gültiges Datum', () => {
    // Uneinheitliche Trenner sind kein Datum, sondern zwei Zahlen
    expect(parseFolderDate('100 Jahre 1925 1025')).toBeUndefined();
    expect(parseFolderDate('1. Advent 2025')).toBeUndefined();
    expect(parseFolderDate('Adventskonzert (2021)')).toBeUndefined();
    expect(parseFolderDate('Feiert Jesus 20')).toBeUndefined();
    expect(parseFolderDate('2026-02-31')).toBeUndefined();
    expect(parseFolderDate('CD 1')).toBeUndefined();
  });
});

let cloud: FakeNextcloud;
let ctx: AppContext;
let cookie = '';
/** Anfrage mit angemeldeter Sitzung */
const inject = (options: InjectOptions) => ctx.app.inject({ ...options, headers: { cookie, ...options.headers } });

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  cloud.put('Gottesdienste/2026/2026-09-27 Erntedank/01 Predigt.mp3', mp3({ title: 'Predigt', artist: 'Pastor', track: 1 }));
  cloud.put('Gottesdienste/2026/2026-09-27 Erntedank/02 Lied.mp3', mp3({ title: 'Lied', artist: 'Chor', track: 2 }));
  cloud.put('Gottesdienste/2026/2026-09-27 Erntedank/cover.jpg', Buffer.from('BILD'));
  cloud.put('Gottesdienste/2026/20.09.2026/Predigt.mp3', mp3({ title: 'Predigt 20.9.', artist: 'Pastor' }));
  // Doppelte Aufnahme in Disc-Ordnern zählt als ein Datum
  cloud.put('Konzerte/2025-12-14 Advent/CD 1/01.mp3', mp3({ title: 'Teil 1', artist: 'Chor', track: 1, disc: 1 }));
  cloud.put('Konzerte/2025-12-14 Advent/CD 2/01.mp3', mp3({ title: 'Teil 2', artist: 'Chor', track: 1, disc: 2 }));
  // Ohne Datum: taucht nicht auf
  cloud.put('Hillsong/Let There Be Light/01.mp3', mp3({ title: 'Behold', artist: 'Hillsong' }));
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

async function get<T = any>(url: string): Promise<T> {
  const res = await inject({ method: 'GET', url });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

describe('Datum-Ansicht', () => {
  it('listet Alben mit Datum, neueste zuerst', async () => {
    const page = await get('/api/dates');
    expect(page.total).toBe(3);
    expect(page.items.map((f: any) => [f.date, f.title, f.trackCount])).toEqual([
      // Name nach dem Regelwerk: der Anlass aus "{datum}_{anlass}"
      ['2026-09-27', 'Erntedank', 2],
      ['2026-09-20', '20.09.2026', 1],
      ['2025-12-14', 'Advent', 2],
    ]);
    expect(page.items[0].hasCover).toBe(true);
    expect(page.items[1].hasCover).toBe(false);
    // Dieselben Einträge wie in der Albenliste
    const albums = await get('/api/albums?dated=true&sort=date');
    expect(albums.items.map((a: any) => a.id)).toEqual(page.items.map((f: any) => f.id));
  });

  it('führt ältere Ordner-Links zum Album', async () => {
    const folder = await get(`/api/dates/folder?path=${encodeURIComponent('Konzerte/2025-12-14 Advent')}`);
    expect(folder.albumId).toBe(folder.id);
    expect(folder.tracks.map((t: any) => t.title)).toEqual(['Teil 1', 'Teil 2']);
    const erntedank = await get(`/api/dates/folder?path=${encodeURIComponent('Gottesdienste/2026/2026-09-27 Erntedank')}`);
    expect(erntedank.tracks.map((t: any) => t.title)).toEqual(['Predigt', 'Lied']);
    const res = await inject({ method: 'GET', url: '/api/dates/folder?path=Hillsong%2FLet%20There%20Be%20Light' });
    expect(res.statusCode).toBe(404);
  });

  it('aktualisiert sich nach einem Scan', async () => {
    cloud.put('Gottesdienste/2026/2026-10-04/Predigt.mp3', mp3({ title: 'Neu', artist: 'Pastor' }));
    await ctx.scanner.scan();
    expect((await get('/api/dates?limit=1')).items[0].date).toBe('2026-10-04');
  });
});

describe('Gottesdienste erkennen', () => {
  const albums = async () =>
    (await get('/api/albums?dated=true&sort=date&limit=50')).items.map((a: any) => ({
      title: a.title,
      date: a.date,
      artist: a.artist,
      year: a.year,
      speaker: a.speaker,
      passage: a.passage,
      trackCount: a.trackCount,
    }));

  it('fasst Unterordner eines Gottesdienstes zu einem Album zusammen', async () => {
    cloud.put('Gottesdienste/2026-10-11/Predigt/Predigt.mp3', mp3({ title: 'Predigt', artist: 'Pastor' }));
    cloud.put('Gottesdienste/2026-10-11/Lobpreis/01.mp3', mp3({ title: 'Lied 1', artist: 'Band', track: 1 }));
    cloud.put('Gottesdienste/2026-10-11/Lobpreis/02.mp3', mp3({ title: 'Lied 2', artist: 'Band', track: 2 }));
    await ctx.scanner.scan();
    expect((await albums())[0]).toMatchObject({ title: '2026-10-11', date: '2026-10-11', trackCount: 3 });
  });

  it('teilt einen Ordner mit Datum nicht nach abweichenden Album-Tags', async () => {
    cloud.put('Gottesdienste/2026-10-18 Jubiläum/01.mp3', mp3({ title: 'Begrüßung', artist: 'Pastor', album: 'Jubiläum', track: 1 }));
    cloud.put('Gottesdienste/2026-10-18 Jubiläum/02.mp3', mp3({ title: 'Lied', artist: 'Chor', album: 'Jubiläum', track: 2 }));
    cloud.put('Gottesdienste/2026-10-18 Jubiläum/03.mp3', mp3({ title: 'Predigt', artist: 'Pastor', album: 'Jubiläum', track: 3 }));
    cloud.put('Gottesdienste/2026-10-18 Jubiläum/04.mp3', mp3({ title: 'Segen', artist: 'Pastor', album: 'Jubilaeum Live', track: 4 }));
    // ohne Album-Tag: Albumname käme aus dem Ordner
    cloud.put('Gottesdienste/2026-10-18 Jubiläum/05.mp3', mp3({ title: 'Nachspiel', artist: 'Orgel', track: 5 }));
    await ctx.scanner.scan();
    const dated = (await albums()).filter((a: any) => a.date === '2026-10-18');
    expect(dated).toHaveLength(1);
    expect(dated[0]).toMatchObject({ title: 'Jubiläum', trackCount: 5 });
  });

  it('macht aus Dateien mit Datum im Namen je Datum einen Gottesdienst mit Sprecher und Bibelstelle', async () => {
    cloud.put('Predigten 2026/2026-08-02 Meier - Psalm 23.mp3', mp3({}, 60));
    cloud.put('Predigten 2026/2026-08-09 Schulz - Joh 3,16.mp3', mp3({}, 60));
    cloud.put('Predigten 2026/2026-08-16 Meier - Römer 8.mp3', mp3({ title: 'Nichts kann uns trennen', artist: 'Meier' }, 60));
    await ctx.scanner.scan();
    const august = (await albums()).filter((a: any) => a.date?.startsWith('2026-08'));
    expect(august).toEqual([
      { title: 'Nichts kann uns trennen', date: '2026-08-16', artist: 'Meier', year: 2026, speaker: 'Meier', passage: 'Römer 8', trackCount: 1 },
      { title: 'Joh 3,16', date: '2026-08-09', artist: 'Schulz', year: 2026, speaker: 'Schulz', passage: 'Joh 3,16', trackCount: 1 },
      { title: 'Psalm 23', date: '2026-08-02', artist: 'Meier', year: 2026, speaker: 'Meier', passage: 'Psalm 23', trackCount: 1 },
    ]);
    // Der Sprecher aus dem Dateinamen steht auch je Titel
    const speakers = ctx.db.prepare(`SELECT DISTINCT value FROM track_tags WHERE tag = 'sprecher' ORDER BY value`).all();
    expect(speakers.map((row: any) => row.value)).toEqual(['Meier', 'Schulz']);
  });

  it('nimmt ein fehlendes Jahr aus dem Elternordner und keinen Jahresordner als Interpreten', async () => {
    cloud.put('Predigten/2025/30.11./Predigt.mp3', mp3({ title: 'Advent' }));
    await ctx.scanner.scan();
    const [album] = (await albums()).filter((a: any) => a.date === '2025-11-30');
    expect(album).toMatchObject({ title: '30.11.', year: 2025 });
    expect(album.artist).not.toBe('2025');
    const track = (await get('/api/tracks?q=Advent')).items.find((t: any) => t.albumDate === '2025-11-30');
    // Ohne Interpret und Sprecher steht die Art der Aufnahme
    expect(track.artist).toBe('Gottesdienst');
  });
});
