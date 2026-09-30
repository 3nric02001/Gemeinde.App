import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { requiredRole } from '../src/api/auth.js';
import { buildApp, type AppContext } from '../src/app.js';
import { suggestMerges } from '../src/library/artists.js';
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
const artists = async () => (await get('/api/artists?limit=100')).items.map((a: any) => a.name);

beforeEach(async () => {
  cloud = new FakeNextcloud('/Gemeinde');
  await cloud.start();
  // Derselbe Prediger in drei Schreibweisen: im Tag, im Dateinamen und mit Tippfehler
  cloud.put('Musik/Lieder/01.mp3', mp3({ title: 'Wort des Lebens', artist: 'J. Rauschenberger', album: 'Lieder' }));
  cloud.put('Musik/Andachten/01.mp3', mp3({ title: 'Andacht', artist: 'Jakob Rauschenberger', album: 'Andachten' }));
  cloud.put('Audio Aufnahmen/2026/2026_09_20/Predigt - Bergpredigt - Jakob Rauschenbeger.mp3', mp3({}, 80));
  cloud.put('Audio Aufnahmen/2026/2026_09_27/Predigt - Erntedank - Jakob Rauschenberger.mp3', mp3({}, 80));
  const config = loadConfig({
    NEXTCLOUD_URL: cloud.url,
    NEXTCLOUD_USER: USER,
    NEXTCLOUD_PASSWORD: PASSWORD,
    NEXTCLOUD_MUSIC_PATH: '/Gemeinde',
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

describe('Interpreten zusammenführen', () => {
  it('dürfen Manager', () => {
    expect(requiredRole('POST', '/api/admin/artists/merge')).toBe('manager');
    expect(requiredRole('POST', '/api/admin/artists/unmerge')).toBe('manager');
  });

  it('zeigt alle Schreibweisen mit Anzahl und schlägt Zusammengehöriges vor', async () => {
    const overview = await get('/api/admin/artists');
    expect(overview.items).toEqual([
      { name: 'J. Rauschenberger', trackCount: 1, target: null },
      // Ein Titel zählt einmal, auch wenn der Name dort Interpret und Sprecher ist
      { name: 'Jakob Rauschenbeger', trackCount: 1, target: null },
      { name: 'Jakob Rauschenberger', trackCount: 2, target: null },
    ]);
    expect(overview.suggestions).toEqual([
      { names: ['Jakob Rauschenberger', 'Jakob Rauschenbeger', 'J. Rauschenberger'], target: 'Jakob Rauschenberger' },
    ]);
  });

  it('führt überall unter einem Namen: Titel, Alben, Sprecher, Interpretenliste, Kategorie, Filter', async () => {
    expect(await artists()).toEqual(['J. Rauschenberger', 'Jakob Rauschenbeger', 'Jakob Rauschenberger']);
    const state = await call('POST', '/api/admin/artists/merge', {
      sources: ['J. Rauschenberger', 'Jakob Rauschenbeger'],
      target: 'Jakob Rauschenberger',
    });
    expect(state.aliases).toEqual([
      { source: 'J. Rauschenberger', target: 'Jakob Rauschenberger' },
      { source: 'Jakob Rauschenbeger', target: 'Jakob Rauschenberger' },
    ]);
    expect(await artists()).toEqual(['Jakob Rauschenberger']);
    const tracks = (await get('/api/tracks?artist=Jakob%20Rauschenberger&limit=50')).items;
    expect(tracks).toHaveLength(4);
    expect(new Set(tracks.map((t: any) => t.artist))).toEqual(new Set(['Jakob Rauschenberger']));
    const services = (await get('/api/albums?dated=true&sort=date')).items;
    expect(services.map((a: any) => a.speaker)).toEqual(['Jakob Rauschenberger', 'Jakob Rauschenberger']);
    const speakers = await get('/api/categories/sprecher/values');
    expect(speakers.items.map((v: any) => v.value)).toEqual(['Jakob Rauschenberger']);
    const interpreters = await get('/api/categories/interpreten/values');
    expect(interpreters.items.map((v: any) => v.value)).toContain('Jakob Rauschenberger');
    expect(interpreters.items.map((v: any) => v.value)).not.toContain('J. Rauschenberger');
  });

  it('führt Ketten zusammen und lässt sich wieder trennen', async () => {
    await call('POST', '/api/admin/artists/merge', { sources: ['J. Rauschenberger'], target: 'Jakob Rauschenberger' });
    await call('POST', '/api/admin/artists/merge', { sources: ['Jakob Rauschenberger'], target: 'Pastor Jakob Rauschenberger' });
    let state = await get('/api/admin/artists');
    expect(state.aliases).toEqual([
      { source: 'J. Rauschenberger', target: 'Pastor Jakob Rauschenberger' },
      { source: 'Jakob Rauschenberger', target: 'Pastor Jakob Rauschenberger' },
    ]);
    expect(await artists()).toEqual(['Jakob Rauschenbeger', 'Pastor Jakob Rauschenberger']);

    state = await call('POST', '/api/admin/artists/unmerge', { source: 'J. Rauschenberger' });
    expect(state.aliases).toEqual([{ source: 'Jakob Rauschenberger', target: 'Pastor Jakob Rauschenberger' }]);
    expect(await artists()).toEqual(['J. Rauschenberger', 'Jakob Rauschenbeger', 'Pastor Jakob Rauschenberger']);
  });

  it('prüft Eingaben', async () => {
    await call('POST', '/api/admin/artists/merge', { sources: ['A'], target: '  ' }, 400);
    await call('POST', '/api/admin/artists/unmerge', { source: 'Niemand' }, 400);
  });

  it('protokolliert die Zusammenführung', async () => {
    await call('POST', '/api/admin/artists/merge', { sources: ['J. Rauschenberger'], target: 'Jakob Rauschenberger' });
    const changes = await get('/api/admin/changes');
    expect(changes.items[0]).toMatchObject({ action: 'Interpreten zusammengeführt: J. Rauschenberger', target: 'Jakob Rauschenberger' });
  });
});

describe('Vorschläge', () => {
  it('erkennt Initialen, fehlende Leerzeichen und Tippfehler, aber keine bloßen Namensvettern', () => {
    const entry = (name: string, trackCount = 1) => ({ name, trackCount });
    expect(
      suggestMerges([entry('Gemeinde Chor'), entry('Gemeindechor', 5), entry('Anna Schulz'), entry('Paul Schulz'), entry('Hillsong')]),
    ).toEqual([{ names: ['Gemeindechor', 'Gemeinde Chor'], target: 'Gemeindechor' }]);
  });
});
