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

  it('ignoriert Namen ohne gültiges Datum', () => {
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
  it('listet unterste Ordner mit Datum, neueste zuerst', async () => {
    const page = await get('/api/dates');
    expect(page.total).toBe(3);
    expect(page.items.map((f: any) => [f.date, f.name, f.trackCount])).toEqual([
      ['2026-09-27', '2026-09-27 Erntedank', 2],
      ['2026-09-20', '20.09.2026', 1],
      ['2025-12-14', '2025-12-14 Advent', 2],
    ]);
    expect(page.items[0].coverTrackId).not.toBeNull();
    expect(page.items[1].coverTrackId).toBeNull();
  });

  it('liefert die Titel eines Ordners in Reihenfolge', async () => {
    const folder = await get(`/api/dates/folder?path=${encodeURIComponent('Konzerte/2025-12-14 Advent')}`);
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
