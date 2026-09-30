import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { compileReplacements } from '../src/library/replacements.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

/** Verwaltung → Schreibweisen: Tippfehler in Titeln ersetzen, ohne die Dateien anzufassen */

describe('compileReplacements', () => {
  const fix = compileReplacements([
    { search: 'Tema', replacement: 'Thema', wholeWord: true },
    { search: 'final2', replacement: '', wholeWord: true },
    { search: 'Gotes', replacement: 'Gottes', wholeWord: false },
  ]);

  it('ersetzt ganze Wörter und übernimmt die Schreibweise des Fundes', () => {
    expect(fix('Tema: Gnade')).toBe('Thema: Gnade');
    expect(fix('TEMA der Woche')).toBe('THEMA der Woche');
    expect(fix('unser tema')).toBe('unser Thema');
    expect(fix('Tematik und Schema')).toBe('Tematik und Schema');
    expect(fix('Über-Tema')).toBe('Über-Thema');
  });

  it('ersetzt auf Wunsch auch Wortteile und räumt Leerzeichen auf', () => {
    expect(fix('Gotesdienst am Sonntag')).toBe('Gottesdienst am Sonntag');
    expect(fix('Predigt final2 Teil 1')).toBe('Predigt Teil 1');
    expect(fix('Nichts zu tun  hier')).toBe('Nichts zu tun  hier');
  });

  it('behandelt Sonderzeichen im Suchbegriff wörtlich', () => {
    expect(compileReplacements([{ search: 'Ps.', replacement: 'Psalm', wholeWord: false }])('Ps. 23 und Psx')).toBe('Psalm 23 und Psx');
  });
});

let cloud: FakeNextcloud;
let ctx: AppContext;
let cookie = '';
const inject = (options: InjectOptions) => ctx.app.inject({ ...options, headers: { cookie, ...options.headers } });

async function call<T = any>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<T> {
  const res = await inject({ method, url, payload: payload as InjectOptions['payload'] });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
  return (res.body ? res.json() : undefined) as T;
}
const titles = async (q = '') => (await call('GET', `/api/tracks?limit=50${q}`)).items.map((t: any) => t.title).sort();

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  cloud.put('Gottesdienste/2026/2026-09-27 Tema Erntedank/01 Predigt - Tema Gnade.mp3', mp3({ artist: 'MBG' }));
  cloud.put('Chor/Lieder/01 Tema der Woche.mp3', mp3({ title: 'Tema der Woche', artist: 'Chor', album: 'Lieder' }));
  cloud.put('Chor/Lieder/02 Tematik.mp3', mp3({ title: 'Tematik', artist: 'Chor', album: 'Lieder' }));
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

describe('Schreibweisen in der Verwaltung', () => {
  it('zeigt eine Vorschau, ersetzt in Titeln, Albumnamen und Suche und lässt sich zurücknehmen', async () => {
    expect(await titles()).toEqual(['Predigt: Tema Gnade', 'Tema der Woche', 'Tematik']);

    const preview = await call('POST', '/api/admin/replacements/preview', { search: 'tema', replacement: 'Thema' });
    expect(preview.tracks.items.map((t: any) => [t.before, t.after]).sort()).toEqual([
      ['Predigt: Tema Gnade', 'Predigt: Thema Gnade'],
      ['Tema der Woche', 'Thema der Woche'],
    ]);
    expect(preview.albums.items.map((a: any) => a.after)).toEqual(['Thema Erntedank']);
    // Die Vorschau speichert nichts
    expect(await titles()).toEqual(['Predigt: Tema Gnade', 'Tema der Woche', 'Tematik']);

    const created = await call('POST', '/api/admin/replacements', { search: 'tema', replacement: 'Thema' }, 201);
    expect(created).toMatchObject({ search: 'tema', replacement: 'Thema', wholeWord: true });
    expect(await titles()).toEqual(['Predigt: Thema Gnade', 'Tematik', 'Thema der Woche']);
    const albums = (await call('GET', '/api/albums?limit=50')).items.map((a: any) => a.title);
    expect(albums).toContain('Thema Erntedank');
    // Die Suche findet die richtige und (als Wortanfang) weiter die falsche Schreibweise
    expect(await titles('&q=Thema')).toEqual(['Predigt: Thema Gnade', 'Thema der Woche']);
    expect(await titles('&q=Tema')).toEqual(['Predigt: Thema Gnade', 'Tematik', 'Thema der Woche']);
    // Eine Korrektur des einzelnen Titels geht vor
    const service = (await call('GET', '/api/admin/albums?q=Erntedank')).items[0];
    const detail = await call('GET', `/api/admin/albums/${service.id}`);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/albums/${service.id}/tracks/${detail.tracks[0].id}`,
      headers: { cookie },
      payload: { title: 'Predigt: Tema von Hand' },
    });
    expect(res.statusCode).toBe(200);
    expect(await titles('&q=Hand')).toEqual(['Predigt: Tema von Hand']);

    // Ein neuer Scan behält die Ersetzung
    await ctx.scanner.scan();
    expect(await titles('&q=Woche')).toEqual(['Thema der Woche']);

    // Bearbeiten: die Vorschau rechnet ohne die alte Fassung der Ersetzung
    const edit = await call('POST', '/api/admin/replacements/preview', { id: created.id, search: 'Tema', replacement: 'Themen' });
    expect(edit.tracks.items).toEqual([expect.objectContaining({ before: 'Tema der Woche', after: 'Themen der Woche' })]);
    await call('PUT', `/api/admin/replacements/${created.id}`, { search: 'Tema', replacement: 'Themen', wholeWord: true });
    expect(await titles('&q=Woche')).toEqual(['Themen der Woche']);

    expect((await call('GET', '/api/admin/replacements')).items).toHaveLength(1);
    await call('DELETE', `/api/admin/replacements/${created.id}`, undefined, 204);
    expect(await titles('&q=Woche')).toEqual(['Tema der Woche']);
    expect((await call('GET', '/api/albums?limit=50')).items.map((a: any) => a.title)).toContain('Tema Erntedank');

    const log = (await call('GET', '/api/admin/changes')).items.map((c: any) => [c.action, c.target]);
    expect(log).toEqual(
      expect.arrayContaining([
        ['Schreibweise hinzugefügt', 'tema → Thema'],
        ['Schreibweise geändert', 'tema → Thema'],
        ['Schreibweise gelöscht', 'Tema → Themen'],
      ]),
    );
  });

  it('weist leere, gleiche und doppelte Ersetzungen ab', async () => {
    await call('POST', '/api/admin/replacements', { search: ' ', replacement: 'x' }, 400);
    await call('POST', '/api/admin/replacements', { search: 'Tema', replacement: 'Tema' }, 400);
    await call('POST', '/api/admin/replacements', { search: 'Tema', replacement: 'Thema' }, 201);
    const dup = await call('POST', '/api/admin/replacements', { search: 'TEMA', replacement: 'Thema' }, 409);
    expect(dup.error).toContain('gibt es schon');
    await call('DELETE', '/api/admin/replacements/999', undefined, 404);
  });
});
