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
const inject = (options: InjectOptions, as = cookie) => ctx.app.inject({ ...options, headers: { cookie: as, ...options.headers } });

async function get<T = any>(url: string, as = cookie): Promise<T> {
  const res = await inject({ method: 'GET', url }, as);
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

function addListener(name: string): number {
  const { id } = ctx.db
    .prepare(
      "INSERT INTO users (kind, issuer, subject, name, role, created_at) VALUES ('oidc', 'idp', ?, ?, 'listener', 0) RETURNING id",
    )
    .get(name, name) as { id: number };
  return id;
}

const trackId = (title: string) =>
  (ctx.db.prepare('SELECT id FROM tracks WHERE coalesce(display_title, title) = ?').get(title) as { id: number }).id;
const albumId = (title: string) => (ctx.db.prepare('SELECT id FROM albums WHERE title = ?').get(title) as { id: number }).id;

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  // Tags zählen nicht; Sprecher und Bibelstelle kommen aus den Dateinamen
  const service = (folder: string, file: string) =>
    cloud.put(`Gottesdienste/2026/${folder}/01 ${file}.mp3`, mp3({ title: 'Tag-Titel', artist: 'MBG', custom: { Sprecher: 'Tag' } }));
  service('2026-08-30 Jugendgottesdienst', 'Input');
  service('2026-09-20', 'Predigt - Psalm 23 - Pastor Meier');
  // Datum im deutschen Format: sortiert trotzdem richtig
  service('13.09.2026 Taufgottesdienst', 'Taufe');
  service('2026-09-27 Erntedank', 'Predigt - Dankbarkeit - Anna Schulz');
  cloud.put('Hillsong/Let There Be Light (2016)/01 Behold.mp3', mp3({ title: 'Behold', artist: 'Hillsong', album: 'Let There Be Light' }));
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

describe('Alben mit Datum', () => {
  it('liefern Datum, Jahr und Sprecher und stehen nach Datum sortiert', async () => {
    const page = await get('/api/albums?dated=true&sort=year');
    expect(page.items.map((a: any) => [a.date, a.year])).toEqual([
      ['2026-09-27', 2026],
      ['2026-09-20', 2026],
      ['2026-09-13', 2026],
      ['2026-08-30', 2026],
    ]);
    expect(page.items[1]).toMatchObject({ speaker: 'Pastor Meier', passage: 'Psalm 23' });

    // Gottesdienste und Musik getrennt abfragen (Startseite)
    expect((await get('/api/albums?dated=true&sort=date')).items.map((a: any) => a.date)).toEqual([
      '2026-09-27', '2026-09-20', '2026-09-13', '2026-08-30',
    ]);
    expect((await get('/api/albums?dated=false')).items.map((a: any) => a.title)).toEqual(['Let There Be Light']);
    // Die Verwaltung listet ebenfalls neueste Gottesdienste zuerst
    expect((await get('/api/admin/albums')).items.map((a: any) => a.date ?? a.title)).toEqual([
      '2026-09-27', '2026-09-20', '2026-09-13', '2026-08-30', 'Let There Be Light',
    ]);

    const byDate = await get('/api/albums?sort=date');
    expect(byDate.items.at(-1).title).toBe('Let There Be Light');
    expect(byDate.items.at(-1).date).toBeNull();
  });

  it('Titel kennen Datum und Sprecher ihres Albums', async () => {
    const page = await get('/api/tracks?q=predigt');
    expect(page.items.map((t: any) => [t.title, t.albumDate, t.speaker])).toEqual([
      ['Predigt: Dankbarkeit', '2026-09-27', 'Anna Schulz'],
      ['Predigt: Psalm 23', '2026-09-20', 'Pastor Meier'],
    ]);
  });

  it('sammeln alle Bibelstellen ihrer Titel, eine Korrektur in der Verwaltung geht vor', async () => {
    const folder = 'Gottesdienste/2026/2026-10-04 Bibeltag';
    cloud.put(`${folder}/01 Lesung - Römer 8.mp3`, mp3({}));
    cloud.put(`${folder}/02 Predigt - Psalm 23 und Joh 3,16 - Pastor Meier.mp3`, mp3({}, 80));
    cloud.put(`${folder}/03 Zeugnis - Joh 3, 16 - Anna Schulz.mp3`, mp3({}));
    await ctx.scanner.scan();
    const id = albumId('Bibeltag');
    // Zuerst die der Predigt, dann je Titel in Albumreihenfolge, ohne Doppelte
    expect((await get(`/api/albums/${id}`)).passage).toBe('Psalm 23; Römer 8; Joh 3,16');

    const res = await inject({ method: 'PATCH', url: `/api/admin/albums/${id}`, payload: { passage: 'Psalm 23' } });
    expect(res.statusCode, res.body).toBe(200);
    await ctx.scanner.scan();
    expect((await get(`/api/albums/${id}`)).passage).toBe('Psalm 23');
  });

  it('Sprecher, Bibelstelle und Beschreibung lassen sich in der Verwaltung setzen', async () => {
    const id = albumId('Taufgottesdienst');
    const res = await inject({
      method: 'PATCH',
      url: `/api/admin/albums/${id}`,
      payload: { speaker: 'Pastorin Kurz', description: 'Taufe von drei Kindern' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().overrides).toMatchObject({ speaker: 'Pastorin Kurz', description: 'Taufe von drei Kindern' });
    const folder = await get(`/api/dates/folder?path=${encodeURIComponent('Gottesdienste/2026/13.09.2026 Taufgottesdienst')}`);
    expect(folder).toMatchObject({ speaker: 'Pastorin Kurz', description: 'Taufe von drei Kindern', passage: null });
    // Übersteht einen Scan
    await ctx.scanner.scan();
    expect((await get(`/api/albums/${id}`)).speaker).toBe('Pastorin Kurz');
  });
});

describe('Suche', () => {
  it('findet eigene Felder wie den Sprecher, auch zusammen mit dem Titel', async () => {
    expect((await get('/api/tracks?q=meier')).items.map((t: any) => t.title)).toEqual(['Predigt: Psalm 23']);
    expect((await get('/api/tracks?q=psalm%20meier')).total).toBe(1);
    expect((await get('/api/albums?q=schulz')).items.map((a: any) => a.title)).toEqual(['Erntedank']);
  });

  it('findet keine Tags, vergisst alte Namen, wenn Dateien umbenannt werden', async () => {
    expect((await get('/api/tracks?q=mbg')).total).toBe(0);
    cloud.move(
      'Gottesdienste/2026/2026-09-20/01 Predigt - Psalm 23 - Pastor Meier.mp3',
      'Gottesdienste/2026/2026-09-20/01 Predigt - Psalm 23 - Gastprediger Weber.mp3',
    );
    await ctx.scanner.scan();
    expect((await get('/api/tracks?q=meier')).total).toBe(0);
    expect((await get('/api/tracks?q=weber')).total).toBe(1);
  });
});

describe('Favoriten', () => {
  it('gehören jedem Hörer allein', async () => {
    const anna = sessionCookie(ctx.db, addListener('Anna'));
    const behold = trackId('Behold');
    const album = albumId('Let There Be Light');
    expect((await inject({ method: 'PUT', url: `/api/me/favorites/track/${behold}` }, anna)).statusCode).toBe(204);
    expect((await inject({ method: 'PUT', url: `/api/me/favorites/album/${album}` }, anna)).statusCode).toBe(204);
    // Doppelt setzen schadet nicht
    expect((await inject({ method: 'PUT', url: `/api/me/favorites/album/${album}` }, anna)).statusCode).toBe(204);
    expect((await inject({ method: 'PUT', url: '/api/me/favorites/track/99999' }, anna)).statusCode).toBe(404);

    const mine = await get('/api/me/favorites', anna);
    expect(mine.tracks.map((t: any) => t.title)).toEqual(['Behold']);
    expect(mine.albums.map((a: any) => a.title)).toEqual(['Let There Be Light']);
    expect(await get('/api/me/favorites')).toEqual({ tracks: [], albums: [] });

    expect((await inject({ method: 'DELETE', url: `/api/me/favorites/track/${behold}` }, anna)).statusCode).toBe(204);
    expect((await get('/api/me/favorites', anna)).tracks).toEqual([]);
  });

  it('ausgeblendete Alben verschwinden aus den Favoriten', async () => {
    const album = albumId('Let There Be Light');
    await inject({ method: 'PUT', url: `/api/me/favorites/album/${album}` });
    await inject({ method: 'PATCH', url: `/api/admin/albums/${album}`, payload: { hidden: true } });
    expect((await get('/api/me/favorites')).albums).toEqual([]);
  });
});

describe('Favoriten verschwundener Alben', () => {
  it('gehen mit dem Album und landen nie bei einem neuen Album mit derselben ID', async () => {
    const album = albumId('Let There Be Light');
    await inject({ method: 'PUT', url: `/api/me/favorites/album/${album}` });
    await inject({ method: 'PUT', url: `/api/me/favorites/track/${trackId('Behold')}` });
    cloud.delete('Hillsong/Let There Be Light (2016)/01 Behold.mp3');
    await ctx.scanner.scan();
    expect(ctx.db.prepare('SELECT count(*) AS n FROM favorites').get()).toEqual({ n: 0 });

    cloud.put('Chor/Neu/01 Neu.mp3', mp3({}));
    await ctx.scanner.scan();
    expect((await get('/api/me/favorites')).albums).toEqual([]);
  });
});

describe('Weiterhören', () => {
  it('merkt sich die Stelle langer Titel und zeigt zuletzt gehörte Alben', async () => {
    const sermon = trackId('Predigt: Psalm 23');
    const song = trackId('Behold');
    ctx.db.prepare('UPDATE tracks SET duration = 2400 WHERE id = ?').run(sermon);
    const save = (id: number, position: number) =>
      inject({ method: 'PUT', url: `/api/me/progress/${id}`, payload: { position } });

    expect((await save(song, 20)).statusCode).toBe(204);
    expect((await save(sermon, 754.5)).statusCode).toBe(204);
    expect((await save(99999, 1)).statusCode).toBe(404);

    expect((await get('/api/me/progress')).items).toEqual([{ trackId: sermon, position: 754.5, duration: 2400 }]);
    const home = await get('/api/me/home');
    expect(home.resume.map((t: any) => [t.id, t.position])).toEqual([[sermon, 754.5]]);
    expect(home.recent.map((a: any) => a.title)).toEqual(['2026-09-20', 'Let There Be Light']);

    // Zu Ende gehört: nicht mehr unter "Weiterhören", aber weiter unter "Zuletzt gehört"
    await save(sermon, 2400);
    expect((await get('/api/me/progress')).items).toEqual([]);
    expect((await get('/api/me/home')).resume).toEqual([]);
    expect((await get('/api/me/home')).recent).toHaveLength(2);
  });

  it('blendet geschlossene Titel aus, bis weitergehört wird', async () => {
    const sermon = trackId('Predigt: Psalm 23');
    ctx.db.prepare('UPDATE tracks SET duration = 2400 WHERE id = ?').run(sermon);
    const save = (position: number) => inject({ method: 'PUT', url: `/api/me/progress/${sermon}`, payload: { position } });
    await save(600);
    expect((await inject({ method: 'DELETE', url: `/api/me/resume/${sermon}` })).statusCode).toBe(204);
    expect((await get('/api/me/home')).resume).toEqual([]);
    // Die Stelle bleibt; dieselbe Stelle noch einmal gemeldet (z. B. Pause) holt ihn nicht zurück
    expect((await get('/api/me/progress')).items).toEqual([{ trackId: sermon, position: 600, duration: 2400 }]);
    await save(600);
    expect((await get('/api/me/home')).resume).toEqual([]);
    await save(650);
    expect((await get('/api/me/home')).resume.map((t: any) => t.id)).toEqual([sermon]);
  });

  it('nimmt die Länge vom Browser, wenn der Scan sie nicht genau kennt', async () => {
    // Der Scan liest nur den Dateianfang; ohne Xing-Header ist die Länge dann geschätzt.
    const sermon = trackId('Predigt: Psalm 23');
    await inject({ method: 'PUT', url: `/api/me/progress/${sermon}`, payload: { position: 300, duration: 1800 } });
    expect((await get('/api/me/progress')).items).toEqual([{ trackId: sermon, position: 300, duration: 1800 }]);
    // Spätere Meldungen ohne Länge behalten die gemessene
    await inject({ method: 'PUT', url: `/api/me/progress/${sermon}`, payload: { position: 320 } });
    expect((await get('/api/me/progress')).items[0]).toMatchObject({ position: 320, duration: 1800 });
  });
});

describe('Name der Gemeinde', () => {
  it('stellt der Admin ein, die Anmeldeseite zeigt ihn ohne Sitzung', async () => {
    const res = await inject({
      method: 'PUT',
      url: '/api/admin/branding',
      payload: { name: 'MBG Brake', welcome: 'Predigten und Musik der Gemeinde' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(status.json().branding).toEqual({ name: 'MBG Brake', welcome: 'Predigten und Musik der Gemeinde' });

    const anna = sessionCookie(ctx.db, addListener('Anna'));
    expect((await inject({ method: 'PUT', url: '/api/admin/branding', payload: { name: 'X' } }, anna)).statusCode).toBe(403);
  });
});
