import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { setMeta } from '../src/db.js';
import { DEFAULT_LIBRARY } from '../src/library/settings.js';
import { DEFAULT_STRUCTURE, getStructure, type Structure } from '../src/library/structure.js';
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
const albums = async () => (await get('/api/albums?limit=100&sort=title')).items as any[];
const tracksOf = async (title: string) => {
  const album = (await albums()).find((a) => a.title === title);
  expect(album, `Album ${title}`).toBeDefined();
  return (await get(`/api/albums/${album.id}`)).tracks as any[];
};
/** Regelwerk mit geänderten Einstellungen für Albumbildung und Namen speichern */
const withLibrary = (library: Partial<Structure['library']>) =>
  call('PUT', '/api/admin/structure', { ...getStructure(ctx.db), library: { ...DEFAULT_LIBRARY, ...library } });

beforeEach(async () => {
  cloud = new FakeNextcloud('/Gemeinde');
  await cloud.start();
  cloud.put('Musik/Chorlieder (2021)/Teil 1/01 - Großer Gott.mp3', mp3({}));
  cloud.put('Musik/Chorlieder (2021)/Teil 2/01 - Tochter Zion.mp3', mp3({}));
  cloud.put('Musik/Chorlieder (2021)/CD 3/01 - Stille Nacht.mp3', mp3({}));
  cloud.put('Gottesdienste/2026-10-11/Predigt/Predigt - Psalm 23 - Anna Schulz.mp3', mp3({}, 80));
  cloud.put('Gottesdienste/2026-10-11/Lobpreis/Lied - Großer Gott.mp3', mp3({}, 20));
  cloud.put('Predigten/2026-08-02 Meier - Psalm 23.mp3', mp3({}, 20));
  cloud.put('Predigten/2026-08-09 Schulz - Joh 3,16.mp3', mp3({}, 20));
  cloud.put('Lose Datei.mp3', mp3({}));
  ctx = await buildApp(
    loadConfig({
      NEXTCLOUD_URL: cloud.url,
      NEXTCLOUD_USER: USER,
      NEXTCLOUD_PASSWORD: PASSWORD,
      NEXTCLOUD_MUSIC_PATH: '/Gemeinde',
      DATABASE_PATH: ':memory:',
    }),
    { logger: false },
  );
  cookie = sessionCookie(ctx.db);
  await ctx.scanner.scan();
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('Albumbildung und Namen in der Verwaltung', () => {
  it('bringt die bisherigen Vorgaben mit, auch für Regelwerke ohne diese Einstellungen', async () => {
    expect((await get('/api/admin/structure')).structure.library).toEqual(DEFAULT_LIBRARY);
    const { library: _, ...old } = DEFAULT_STRUCTURE;
    setMeta(ctx.db, 'structure', JSON.stringify(old));
    expect(getStructure(ctx.db).library).toEqual(DEFAULT_LIBRARY);
    // Vorgabe: "CD 3" zählt zum Album, "Teil 1" nicht; Unterordner des Gottesdienstes gehören dazu; lose Datei
    expect((await albums()).map((a) => [a.title, a.trackCount])).toEqual([
      ['2026-10-11', 2],
      ['Chorlieder', 1],
      ['Einzeltitel', 1],
      ['Joh 3,16', 1],
      ['Psalm 23', 1],
      ['Teil 1', 1],
      ['Teil 2', 1],
    ]);
  });

  it('fasst eigene Disc-Unterordner zusammen, ohne neuen Scan', async () => {
    await withLibrary({ discFolders: ['CD', 'Teil'] });
    const chor = await tracksOf('Chorlieder');
    expect(chor.map((t) => [t.discNo, t.title])).toEqual([
      [1, 'Großer Gott'],
      [2, 'Tochter Zion'],
      [3, 'Stille Nacht'],
    ]);
  });

  it('lässt Unterordner eines Gottesdienstes auf Wunsch eigene Alben sein', async () => {
    await withLibrary({ mergeDatedSubfolders: false });
    const titles = (await albums()).map((a) => a.title);
    expect(titles).toContain('Predigt');
    expect(titles).toContain('Lobpreis');
    expect(titles).not.toContain('2026-10-11');
  });

  it('teilt Ordner mit Datum in den Dateinamen auf Wunsch nicht auf', async () => {
    await withLibrary({ splitByFileDate: false });
    const predigten = await tracksOf('Predigten');
    expect(predigten.map((t) => [t.title, t.speaker])).toEqual([
      ['Psalm 23', 'Meier'],
      ['Joh 3,16', 'Schulz'],
    ]);
  });

  it('benennt Musik, Sonstiges und lose Dateien nach eigenen Vorlagen', async () => {
    await withLibrary({ albumTitle: '{ordner} ({jahr})', trackTitle: '{nr}. {titel}', looseTitle: 'Ohne Ordner' });
    const titles = (await albums()).map((a) => a.title);
    expect(titles).toContain('Chorlieder (2021)');
    expect(titles).toContain('Ohne Ordner');
    expect((await tracksOf('Chorlieder (2021)')).map((t) => t.title)).toEqual(['1. Stille Nacht']);
    // Aufnahmen behalten die Vorlage ihrer Art
    expect((await tracksOf('2026-10-11')).map((t) => t.title).sort()).toEqual(['Lied: Großer Gott', 'Predigt: Psalm 23']);
    // Zurück auf die Vorgabe
    await withLibrary({});
    expect((await tracksOf('Chorlieder')).map((t) => t.title)).toEqual(['Stille Nacht']);
  });

  it('stellt die Länge für den Predigt-Player ohne Policy ein', async () => {
    const song = (await tracksOf('Chorlieder'))[0];
    await call('PUT', `/api/me/progress/${song.id}`, { position: 60, duration: 300 }, 204);
    expect((await get('/api/me/progress')).items).toEqual([]);
    await withLibrary({ sermonMinutes: 4 });
    expect((await get('/api/me/progress')).items.map((p: any) => p.trackId)).toEqual([song.id]);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/status' })).json().sermonMinutes).toBe(4);
  });

  it('kennt eigene Wörter vor Bibelstellen und weitere Schreibweisen von Bibelbüchern', async () => {
    cloud.put('Gottesdienste/2026-10-18/Predigt - Bergpredigt Lesung_Mathäus 5,1-12 - Anna Schulz.mp3', mp3({}, 80));
    await ctx.scanner.scan();
    const service = () => get('/api/albums?dated=true&sort=date&limit=1').then((page) => page.items[0]);
    expect((await service()).passage).toBeNull();
    await withLibrary({ passagePrefixes: ['Text', 'Lesung'], bookSpellings: ['Kollosser', 'Mathäus'] });
    expect(await service()).toMatchObject({ date: '2026-10-18', passage: 'Mathäus 5,1-12' });
    expect((await tracksOf('2026-10-18')).map((t) => t.title)).toEqual(['Predigt: Bergpredigt (Mathäus 5,1-12)']);
    expect((await get('/api/categories/sprecher/values')).items.map((v: any) => v.value)).toContain('Anna Schulz');
  });

  it('zeigt Musik und Sonstiges in der Vorschau, ohne die gespeicherten Einstellungen zu ändern', async () => {
    const structure = { ...getStructure(ctx.db), library: { ...DEFAULT_LIBRARY, albumTitle: '{ordner} ({jahr})', trackTitle: '{nr}. {titel}' } };
    const preview = await call('POST', '/api/admin/structure/preview', structure);
    expect(preview.others).toContainEqual({
      folder: 'Musik/Chorlieder (2021)',
      section: 'music',
      title: 'Chorlieder (2021)',
      tracks: [{ file: '01 - Stille Nacht.mp3', title: '1. Stille Nacht' }],
    });
    expect(getStructure(ctx.db).library).toEqual(DEFAULT_LIBRARY);
    expect((await tracksOf('Chorlieder')).map((t) => t.title)).toEqual(['Stille Nacht']);
  });

  it('prüft Eingaben', async () => {
    const put = (library: Record<string, unknown>) =>
      call('PUT', '/api/admin/structure', { ...getStructure(ctx.db), library: { ...DEFAULT_LIBRARY, ...library } }, 400);
    expect((await put({ albumTitle: '{anlass}' })).error).toContain('Unbekannter Platzhalter {anlass}');
    expect((await put({ sermonMinutes: -1 })).error).toContain('Minuten');
    expect((await put({ discFolders: ['CD(1)'] })).error).toContain('Disc-Unterordner');
    expect((await put({ discFolders: 'CD' })).error).toContain('Liste');
  });
});
