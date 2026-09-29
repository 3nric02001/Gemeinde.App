import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import sharp from 'sharp';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MAX_CHANGES, recordChange } from '../src/library/changes.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

/** Verwaltung aus Sicht von Managern: Filter, Titel korrigieren, Titelbild, Änderungsprotokoll */

let cloud: FakeNextcloud;
let ctx: AppContext;
let cookie = '';
const inject = (options: InjectOptions, as = cookie) => ctx.app.inject({ ...options, headers: { cookie: as, ...options.headers } });

async function get<T = any>(url: string, as = cookie): Promise<T> {
  const res = await inject({ method: 'GET', url }, as);
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

async function send<T = any>(method: 'PATCH' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, as = cookie): Promise<T> {
  const res = await inject({ method, url, payload: payload as InjectOptions['payload'] }, as);
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return (res.body ? res.json() : undefined) as T;
}

function addUser(name: string, role: 'listener' | 'manager'): number {
  const { id } = ctx.db
    .prepare("INSERT INTO users (kind, issuer, subject, name, role, created_at) VALUES ('oidc', 'idp', ?, ?, ?, 0) RETURNING id")
    .get(name, name, role) as { id: number };
  return id;
}

const albumId = (title: string) => (ctx.db.prepare('SELECT id FROM albums WHERE title = ?').get(title) as { id: number }).id;
const service = (folder: string, title: string, custom: Record<string, string> = {}) =>
  cloud.put(`Gottesdienste/2026/${folder}/01 ${title}.mp3`, mp3({ title, artist: 'MBG', genre: 'Gottesdienst', custom }));

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  service('2026-08-30 Jugendgottesdienst', 'Input');
  service('2026-09-20', 'Predigt Psalm 23', { Sprecher: 'Pastor Meier', Bibelstelle: 'Psalm 23' });
  service('2026-09-27 Erntedank', 'Predigt_final2');
  cloud.put('Hillsong/Let There Be Light/01 Behold.mp3', mp3({ title: 'Behold', artist: 'Hillsong', album: 'Let There Be Light' }));
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

describe('Filter der Albumliste', () => {
  it('findet Gottesdienste ohne Sprecher, Musik und ausgeblendete Alben', async () => {
    const titles = async (query: string) => (await get(`/api/admin/albums?${query}`)).items.map((a: any) => a.date ?? a.title);
    expect(await titles('noSpeaker=true')).toEqual(['2026-09-27', '2026-08-30']);
    expect(await titles('dated=false')).toEqual(['Let There Be Light']);
    expect(await titles('hidden=true')).toEqual([]);

    await send('PATCH', `/api/admin/albums/${albumId('Let There Be Light')}`, { hidden: true });
    expect(await titles('hidden=true')).toEqual(['Let There Be Light']);
    // Sprecher nachgetragen: fällt aus dem Filter
    await send('PATCH', `/api/admin/albums/${albumId('2026-08-30 Jugendgottesdienst')}`, { speaker: 'Jugendteam' });
    expect(await titles('noSpeaker=true')).toEqual(['2026-09-27']);
  });
});

describe('Titel korrigieren', () => {
  it('ändert Namen und Sprecher, übersteht neue Scans und lässt sich zurücksetzen', async () => {
    const id = albumId('2026-09-27 Erntedank');
    const album = await get(`/api/admin/albums/${id}`);
    const track = album.tracks[0];
    expect(album.trackEdits).toEqual([
      { id: track.id, fileTitle: 'Predigt_final2', title: null, speaker: null, fileSpeaker: null },
    ]);

    const edited = await send('PATCH', `/api/admin/albums/${id}/tracks/${track.id}`, { title: 'Predigt: Dankbar leben', speaker: 'Pastorin Schulz' });
    expect(edited.tracks[0]).toMatchObject({ title: 'Predigt: Dankbar leben', speaker: 'Pastorin Schulz' });
    // Der Sprecher des Titels wird zum Sprecher des Gottesdienstes, und die Suche findet ihn.
    expect(edited.speaker).toBe('Pastorin Schulz');
    expect((await get('/api/tracks?q=Schulz')).items.map((t: any) => t.title)).toEqual(['Predigt: Dankbar leben']);
    expect((await get('/api/tracks?q=dankbar')).items).toHaveLength(1);

    // Datei ändert sich in der Nextcloud: die Korrektur bleibt, der Dateiname wird aktualisiert
    service('2026-09-27 Erntedank', 'Predigt_final2', { Kommentar: 'neu' });
    await ctx.scanner.scan();
    const rescanned = await get(`/api/admin/albums/${id}`);
    expect(rescanned.tracks[0].title).toBe('Predigt: Dankbar leben');
    expect(rescanned.trackEdits[0]).toMatchObject({ fileTitle: 'Predigt_final2', title: 'Predigt: Dankbar leben' });

    const reset = await send('PATCH', `/api/admin/albums/${id}/tracks/${track.id}`, { title: null, speaker: null });
    expect(reset.tracks[0]).toMatchObject({ title: 'Predigt_final2', speaker: null });
    expect(reset.speaker).toBeNull();
    expect((await get('/api/tracks?q=Schulz')).items).toEqual([]);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM track_overrides').get()).toEqual({ n: 0 });
  });

  it('lehnt Titel ab, die nicht im Album stehen', async () => {
    const other = (await get(`/api/admin/albums/${albumId('Let There Be Light')}`)).tracks[0].id;
    const res = await inject({ method: 'PATCH', url: `/api/admin/albums/${albumId('2026-09-20')}/tracks/${other}`, payload: { title: 'x' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('Eigenes Titelbild', () => {
  const png = () =>
    sharp({ create: { width: 2400, height: 1800, channels: 4, background: { r: 200, g: 120, b: 40, alpha: 1 } } }).png().toBuffer();

  it('wird verkleinert, gilt für Album und Titel und übersteht Scans', async () => {
    const id = albumId('2026-09-20');
    expect((await get(`/api/admin/albums/${id}`)).hasCover).toBe(false);

    const res = await inject({ method: 'PUT', url: `/api/admin/albums/${id}/cover`, payload: await png(), headers: { 'content-type': 'image/png' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ hasCover: true, customCover: true });
    const stored = ctx.db.prepare('SELECT c.mime, c.data FROM album_overrides o JOIN covers c ON c.id = o.cover_id').get() as {
      mime: string;
      data: Buffer;
    };
    expect(stored.mime).toBe('image/jpeg');
    expect(await sharp(stored.data).metadata()).toMatchObject({ width: 1600, height: 1200 });

    const cover = await inject({ method: 'GET', url: `/api/albums/${id}/cover` });
    expect(cover.statusCode).toBe(200);
    const trackId = (await get(`/api/albums/${id}`)).tracks[0].id;
    expect((await inject({ method: 'GET', url: `/api/tracks/${trackId}/cover` })).statusCode).toBe(200);

    // Der Scan räumt nicht mehr verwendete Bilder weg, das hochgeladene bleibt.
    await ctx.scanner.scan();
    expect((await get(`/api/admin/albums/${id}`)).customCover).toBe(true);

    const removed = await send('DELETE', `/api/admin/albums/${id}/cover`);
    expect(removed).toMatchObject({ hasCover: false, customCover: false });
    expect(ctx.db.prepare('SELECT count(*) AS n FROM album_overrides').get()).toEqual({ n: 0 });
  });

  it('lehnt Dateien ab, die kein Bild sind', async () => {
    const id = albumId('2026-09-20');
    const bad = await inject({
      method: 'PUT',
      url: `/api/admin/albums/${id}/cover`,
      payload: Buffer.from('kein Bild'),
      headers: { 'content-type': 'image/png' },
    });
    expect(bad.statusCode).toBe(400);
    const svg = await inject({
      method: 'PUT',
      url: `/api/admin/albums/${id}/cover`,
      payload: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      headers: { 'content-type': 'image/svg+xml' },
    });
    expect(svg.statusCode).toBe(415);
    const huge = await inject({
      method: 'PUT',
      url: `/api/admin/albums/${id}/cover`,
      payload: Buffer.alloc(16 * 1024 * 1024),
      headers: { 'content-type': 'image/jpeg' },
    });
    expect(huge.statusCode).toBe(413);
  });
});

describe('Änderungsprotokoll', () => {
  it('hält fest, wer was geändert hat, und zeigt es nur Admins ganz', async () => {
    const anna = sessionCookie(ctx.db, addUser('Anna Beispiel', 'manager'));
    const id = albumId('2026-09-27 Erntedank');
    await send('PATCH', `/api/admin/albums/${id}`, { title: 'Erntedank-Gottesdienst', speaker: 'Pastorin Schulz' }, anna);
    await send('PATCH', `/api/admin/albums/${id}`, { hidden: true }, anna);
    // Vorschauen und abgelehnte Änderungen zählen nicht
    await send('POST', '/api/admin/rules/preview', { field: 'title', op: 'contains', value: 'x' }, anna);
    expect((await inject({ method: 'PATCH', url: `/api/admin/albums/${id}`, payload: { year: 1 } }, anna)).statusCode).toBe(400);

    const detail = await get(`/api/admin/albums/${id}`, anna);
    expect(detail.lastChange).toMatchObject({ userName: 'Anna Beispiel', action: 'Album ausgeblendet' });

    expect((await inject({ method: 'GET', url: '/api/admin/changes' }, anna)).statusCode).toBe(403);
    const log = await get('/api/admin/changes');
    expect(log.items.map((c: any) => [c.userName, c.action, c.target])).toEqual([
      ['Anna Beispiel', 'Album ausgeblendet', 'Erntedank-Gottesdienst'],
      ['Anna Beispiel', 'Album bearbeitet (Name, Sprecher)', '2026-09-27 Erntedank'],
    ]);
  });

  it('behält nur die neuesten Einträge', () => {
    for (let i = 0; i < MAX_CHANGES + 3; i++) recordChange(ctx.db, { userId: null, userName: 'x', action: `a${i}` });
    const { n, first } = ctx.db.prepare('SELECT count(*) AS n, min(action) AS first FROM changes').get() as { n: number; first: string };
    expect(n).toBe(MAX_CHANGES);
    expect(first).not.toBe('a0');
  });
});

describe('Datum-Seite', () => {
  it('zeigt den in der Verwaltung korrigierten Anlass', async () => {
    await send('PATCH', `/api/admin/albums/${albumId('2026-09-20')}`, { title: 'Gottesdienst mit Abendmahl' });
    const folders = (await get('/api/dates')).items;
    expect(folders.find((f: any) => f.date === '2026-09-20')).toMatchObject({ title: 'Gottesdienst mit Abendmahl' });
  });
});
