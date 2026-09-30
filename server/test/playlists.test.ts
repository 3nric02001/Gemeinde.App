import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

let cloud: FakeNextcloud;
let ctx: AppContext;
let anna = '';
let ben = '';
let annaId = 0;
let benId = 0;
let carlaId = 0;

const inject = (as: string, options: InjectOptions) => ctx.app.inject({ ...options, headers: { cookie: as, ...options.headers } });

function addListener(name: string, role: string | null = 'listener'): number {
  const { id } = ctx.db
    .prepare("INSERT INTO users (kind, issuer, subject, name, role, created_at) VALUES ('oidc', 'idp', ?, ?, ?, 0) RETURNING id")
    .get(name, name, role) as { id: number };
  return id;
}

const trackId = (title: string) =>
  (ctx.db.prepare('SELECT id FROM tracks WHERE coalesce(display_title, title) = ?').get(title) as { id: number }).id;

async function create(as: string, title: string, trackIds: number[] = []) {
  const res = await inject(as, { method: 'POST', url: '/api/me/playlists', payload: { title, trackIds } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number; title: string; tracks: Array<{ id: number }> };
}

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  cloud.put('Lieder/Album (2020)/01 Eins.mp3', mp3({ title: 'Eins' }));
  cloud.put('Lieder/Album (2020)/02 Zwei.mp3', mp3({ title: 'Zwei' }));
  cloud.put('Lieder/Album (2020)/03 Drei.mp3', mp3({ title: 'Drei' }));
  const config = loadConfig({
    NEXTCLOUD_URL: cloud.url,
    NEXTCLOUD_USER: USER,
    NEXTCLOUD_PASSWORD: PASSWORD,
    NEXTCLOUD_MUSIC_PATH: '/Musik',
    DATABASE_PATH: ':memory:',
  });
  ctx = await buildApp(config, { logger: false });
  await ctx.scanner.scan();
  annaId = addListener('Anna');
  benId = addListener('Ben');
  carlaId = addListener('Carla');
  addListener('Ohne Zugang', null);
  anna = sessionCookie(ctx.db, annaId);
  ben = sessionCookie(ctx.db, benId);
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('eigene Playlists', () => {
  it('legt an, hängt an ohne Doppelte, sortiert um und benennt um', async () => {
    const [eins, zwei, drei] = [trackId('Eins'), trackId('Zwei'), trackId('Drei')];
    const list = await create(anna, '  Für  unterwegs ', [zwei, zwei, 99999]);
    expect(list.title).toBe('Für unterwegs');
    expect(list.tracks.map((t) => t.id)).toEqual([zwei]);

    const added = await inject(anna, { method: 'POST', url: `/api/me/playlists/${list.id}/tracks`, payload: { trackIds: [zwei, eins, drei] } });
    expect(added.json()).toEqual({ added: 2 });
    await inject(anna, { method: 'PUT', url: `/api/me/playlists/${list.id}/tracks`, payload: { trackIds: [drei, zwei] } });
    await inject(anna, { method: 'PATCH', url: `/api/me/playlists/${list.id}`, payload: { title: 'Sonntag' } });

    const detail = (await inject(anna, { method: 'GET', url: `/api/me/playlists/${list.id}` })).json();
    expect(detail.title).toBe('Sonntag');
    expect(detail.tracks.map((t: { id: number }) => t.id)).toEqual([drei, zwei]);
    expect(detail).toMatchObject({ mine: true, trackCount: 2, owner: 'Anna' });

    const all = (await inject(anna, { method: 'GET', url: '/api/me/playlists' })).json();
    expect(all.own.map((p: { title: string }) => p.title)).toEqual(['Sonntag']);
    expect(all.shared).toEqual([]);
  });

  it('lehnt einen leeren Namen ab', async () => {
    const res = await inject(anna, { method: 'POST', url: '/api/me/playlists', payload: { title: '   ' } });
    expect(res.statusCode).toBe(400);
  });

  it('sind für andere unsichtbar, bis sie geteilt werden; Empfänger hören nur zu', async () => {
    const list = await create(anna, 'Lobpreis', [trackId('Eins')]);
    expect((await inject(ben, { method: 'GET', url: `/api/me/playlists/${list.id}` })).statusCode).toBe(404);

    const people = (await inject(anna, { method: 'GET', url: '/api/me/people' })).json().items.map((p: { name: string }) => p.name);
    expect(people).toEqual(['Ben', 'Carla', 'Administrator']);

    const shared = await inject(anna, {
      method: 'PUT',
      url: `/api/me/playlists/${list.id}/shares`,
      payload: { userIds: [benId, annaId, 424242] },
    });
    expect(shared.json().sharedWith).toEqual([{ id: benId, name: 'Ben' }]);

    const forBen = (await inject(ben, { method: 'GET', url: '/api/me/playlists' })).json();
    expect(forBen.shared).toHaveLength(1);
    expect(forBen.shared[0]).toMatchObject({ title: 'Lobpreis', owner: 'Anna', mine: false, trackCount: 1 });
    const detail = (await inject(ben, { method: 'GET', url: `/api/me/playlists/${list.id}` })).json();
    expect(detail.sharedWith).toEqual([]);

    // Ändern darf nur Anna
    for (const change of [
      { method: 'PATCH' as const, url: `/api/me/playlists/${list.id}`, payload: { title: 'Meins' } },
      { method: 'POST' as const, url: `/api/me/playlists/${list.id}/tracks`, payload: { trackIds: [trackId('Zwei')] } },
      { method: 'PUT' as const, url: `/api/me/playlists/${list.id}/tracks`, payload: { trackIds: [] } },
      { method: 'PUT' as const, url: `/api/me/playlists/${list.id}/shares`, payload: { userIds: [carlaId] } },
    ]) {
      expect((await inject(ben, change)).statusCode, change.url).toBe(403);
    }

    // Ben entfernt sie nur für sich, Annas Playlist bleibt
    expect((await inject(ben, { method: 'DELETE', url: `/api/me/playlists/${list.id}` })).statusCode).toBe(204);
    expect((await inject(ben, { method: 'GET', url: '/api/me/playlists' })).json().shared).toEqual([]);
    expect((await inject(anna, { method: 'GET', url: `/api/me/playlists/${list.id}` })).json().sharedWith).toEqual([]);
  });

  it('verschwinden mit dem Besitzer, gelöschte Titel fallen heraus', async () => {
    const list = await create(anna, 'Mix', [trackId('Eins'), trackId('Zwei')]);
    await inject(anna, { method: 'PUT', url: `/api/me/playlists/${list.id}/shares`, payload: { userIds: [benId] } });
    ctx.db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId('Eins'));
    const detail = (await inject(ben, { method: 'GET', url: `/api/me/playlists/${list.id}` })).json();
    expect(detail.tracks.map((t: { title: string }) => t.title)).toEqual(['Zwei']);

    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(annaId);
    expect((await inject(ben, { method: 'GET', url: '/api/me/playlists' })).json().shared).toEqual([]);
  });

  it('löscht der Besitzer, ist sie auch für Empfänger weg', async () => {
    const list = await create(anna, 'Weg');
    await inject(anna, { method: 'PUT', url: `/api/me/playlists/${list.id}/shares`, payload: { userIds: [benId] } });
    expect((await inject(anna, { method: 'DELETE', url: `/api/me/playlists/${list.id}` })).statusCode).toBe(204);
    expect((await inject(ben, { method: 'GET', url: `/api/me/playlists/${list.id}` })).statusCode).toBe(404);
  });
});
