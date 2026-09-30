import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { requiredRole } from '../src/api/auth.js';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { compilePattern, DEFAULT_STRUCTURE, fillTemplate, matchPattern } from '../src/library/structure.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

describe('Muster', () => {
  const contents = DEFAULT_STRUCTURE.contents;
  const file = compilePattern('{inhalt} - {titel}', contents, { leadingNumber: true });

  it('liest Ordner- und Dateinamen mit beliebigen Trennzeichen', () => {
    expect(matchPattern(compilePattern('{datum}_{anlass}'), '2026_08_30_Einschulung')).toEqual({ datum: '2026_08_30', anlass: 'Einschulung' });
    expect(matchPattern(compilePattern('{datum}_{anlass}'), '2026_08_30')).toEqual({ datum: '2026_08_30' });
    expect(matchPattern(compilePattern('{datum}_{bibelstelle}'), '2026_01_14_Matthäus 9, 27-38')).toEqual({
      datum: '2026_01_14',
      bibelstelle: 'Matthäus 9, 27-38',
    });
    expect(matchPattern(compilePattern('{datum}_{nr}'), '2026_01_14_001')).toEqual({ datum: '2026_01_14', nr: '001' });
    expect(matchPattern(file, 'Predigt - Der gute Hirte')).toEqual({ inhalt: 'Predigt', titel: 'Der gute Hirte' });
    expect(matchPattern(file, 'Lied_Großer Gott, wir loben dich')).toEqual({ inhalt: 'Lied', titel: 'Großer Gott, wir loben dich' });
    expect(matchPattern(file, '03 Abkündigungen')).toEqual({ lead: '03', inhalt: 'Abkündigungen' });
    expect(matchPattern(file, '03 Predigt: Dankbarkeit')).toEqual({ lead: '03', inhalt: 'Predigt', titel: 'Dankbarkeit' });
  });

  it('trennt freie Textfelder nur an echten Trennzeichen, nicht an Leerzeichen', () => {
    const withSpeaker = compilePattern('{inhalt} - {sprecher} - {titel}', contents, { leadingNumber: true });
    expect(matchPattern(withSpeaker, 'Predigt - Meier - Der gute Hirte')).toEqual({ inhalt: 'Predigt', sprecher: 'Meier', titel: 'Der gute Hirte' });
    expect(matchPattern(withSpeaker, 'Predigt_Anna Schulz_Psalm 23')).toEqual({ inhalt: 'Predigt', sprecher: 'Anna Schulz', titel: 'Psalm 23' });
  });

  it('kennt Inhalte aus mehreren Wörtern, wenn sie in der Liste stehen', () => {
    const custom = compilePattern('{inhalt} - {titel}', ['Gebet und Segen'], { leadingNumber: true });
    expect(matchPattern(custom, 'Gebet und Segen')).toEqual({ inhalt: 'Gebet und Segen' });
  });

  it('lässt leere Platzhalter samt Trennern weg', () => {
    expect(fillTemplate('{inhalt}: {titel}', { inhalt: 'Predigt' })).toBe('Predigt');
    expect(fillTemplate('{inhalt}: {titel}', { titel: 'Großer Gott' })).toBe('Großer Gott');
    expect(fillTemplate('Teil {nr}', { nr: '2' })).toBe('Teil 2');
  });
});

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
const dated = async (query = '') => (await get(`/api/albums?dated=true&sort=date&limit=50${query}`)).items as any[];
const albumTracks = async (id: number) => (await get(`/api/albums/${id}`)).tracks as any[];

beforeEach(async () => {
  cloud = new FakeNextcloud('/Gemeinde');
  await cloud.start();
  // Ablage wie in der Gemeinde: Jahr / Gottesdienst-Ordner / Inhalt - Titel, Bibelstunden mit nummerierten Teilen
  const service = 'Audio Aufnahmen/2026/2026_08_30_Einschulung';
  cloud.put(`${service}/Begrüßung.mp3`, mp3({}, 10));
  cloud.put(`${service}/Lied - Großer Gott.mp3`, mp3({}, 20));
  cloud.put(`${service}/Predigt - Der gute Hirte.mp3`, mp3({}, 80));
  cloud.put('Audio Aufnahmen/2026/2026_09_06/Predigt - Joh 10, 11.mp3', mp3({}, 80));
  const study = 'Audio Aufnahmen/2026/Bibelstunden/2026_01_14_Matthäus 9, 27-38';
  cloud.put(`${study}/2026_01_14_001.mp3`, mp3({}, 30));
  cloud.put(`${study}/2026_01_14_002.mp3`, mp3({}, 30));
  cloud.put('Musik/Hillsong/Zion/01.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion' }));
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

describe('Aufnahmen nach dem Regelwerk', () => {
  it('bildet Gottesdienste mit Anlass, Inhalt und Titel aus dem Dateinamen', async () => {
    const service = (await dated()).find((a) => a.date === '2026-08-30');
    expect(service).toMatchObject({ title: 'Einschulung', recording: 'Gottesdienst', trackCount: 3 });
    const tracks = await albumTracks(service.id);
    expect(tracks.map((t) => [t.title, t.content])).toEqual([
      ['Begrüßung', 'Begrüßung'],
      ['Lied: Großer Gott', 'Lied'],
      ['Predigt: Der gute Hirte', 'Predigt'],
    ]);
    // "Lied" und "Predigt" sind keine Interpreten
    expect(tracks.map((t) => t.artist)).toEqual(['Gottesdienst', 'Gottesdienst', 'Gottesdienst']);
    const artists = (await get('/api/artists')).items.map((a: any) => a.name);
    expect(artists).toEqual(['Hillsong United']);
  });

  it('nimmt die Bibelstelle aus dem Titel der Predigt', async () => {
    const service = (await dated()).find((a) => a.date === '2026-09-06');
    expect(service).toMatchObject({ recording: 'Gottesdienst', passage: 'Joh 10,11' });
  });

  it('erkennt Bibelstunden an ihrem Ordner, mit Bibelstelle und nummerierten Teilen', async () => {
    const study = (await dated()).find((a) => a.date === '2026-01-14');
    expect(study).toMatchObject({ title: 'Matthäus 9, 27-38', recording: 'Bibelstunde', passage: 'Matthäus 9, 27-38' });
    expect((await albumTracks(study.id)).map((t) => t.title)).toEqual(['Teil 1', 'Teil 2']);
    expect((await dated('&recording=Bibelstunde')).map((a) => a.date)).toEqual(['2026-01-14']);
    expect((await get('/api/dates?recording=Gottesdienst')).items.map((a: any) => a.date)).toEqual(['2026-09-06', '2026-08-30']);
    expect((await get('/api/facets')).recordings).toEqual([
      { name: 'Bibelstunde', plural: 'Bibelstunden', count: 1 },
      { name: 'Gottesdienst', plural: 'Gottesdienste', count: 2 },
    ]);
  });

  it('findet Aufnahmen über Inhalt und Titel aus dem Regelwerk', async () => {
    expect((await get('/api/tracks?q=gute%20hirte')).items.map((t: any) => t.title)).toEqual(['Predigt: Der gute Hirte']);
    expect((await get('/api/categories/inhalt/values')).items.map((v: any) => v.value)).toEqual(['Begrüßung', 'Lied', 'Predigt']);
  });
});

describe('Regelwerk in der Verwaltung', () => {
  it('dürfen Manager ändern', () => {
    expect(requiredRole('PUT', '/api/admin/structure')).toBe('manager');
    expect(requiredRole('POST', '/api/admin/structure/preview')).toBe('manager');
  });

  it('liefert Regelwerk, Vorgaben und Platzhalter', async () => {
    const body = await get('/api/admin/structure');
    expect(body.structure).toEqual(DEFAULT_STRUCTURE);
    expect(body.placeholders).toContain('bibelstelle');
  });

  it('zeigt vor dem Speichern, was herauskommt', async () => {
    const preview = await call('POST', '/api/admin/structure/preview', DEFAULT_STRUCTURE);
    expect(preview.kinds.map((k: any) => [k.name, k.albums, k.unmatchedFiles])).toEqual([
      ['Bibelstunde', 1, 0],
      ['Gottesdienst', 2, 0],
    ]);
    expect(preview.kinds[1].examples[1]).toMatchObject({
      folder: 'Audio Aufnahmen/2026/2026_08_30_Einschulung',
      title: 'Einschulung',
      tracks: [
        { file: 'Begrüßung.mp3', title: 'Begrüßung', content: 'Begrüßung', matched: true },
        { file: 'Lied - Großer Gott.mp3', title: 'Lied: Großer Gott', content: 'Lied', matched: true },
        { file: 'Predigt - Der gute Hirte.mp3', title: 'Predigt: Der gute Hirte', content: 'Predigt', matched: true },
      ],
    });
  });

  it('wendet ein geändertes Regelwerk sofort an, ohne neuen Scan', async () => {
    const structure = structuredClone(DEFAULT_STRUCTURE);
    structure.kinds[1]!.trackTitle = '{titel}';
    structure.kinds[1]!.albumTitle = 'Gottesdienst {anlass}';
    await call('PUT', '/api/admin/structure', structure);
    const service = (await dated()).find((a) => a.date === '2026-08-30');
    expect(service.title).toBe('Gottesdienst Einschulung');
    expect((await albumTracks(service.id)).map((t) => t.title)).toEqual(['Begrüßung', 'Großer Gott', 'Der gute Hirte']);
    expect((await get('/api/admin/structure')).structure.kinds[1].trackTitle).toBe('{titel}');
  });

  it('liest den Sprecher aus dem Dateinamen, wenn das Muster ihn nennt', async () => {
    // Nur Gottesdienste, deren Dateien den Sprecher nennen
    for (const path of [...cloud.files.keys()]) if (path.includes('2026_0')) cloud.delete(path);
    cloud.put('Audio Aufnahmen/2026/2026_09_13/Predigt - Meier - Psalm 23.mp3', mp3({}, 80));
    cloud.put('Audio Aufnahmen/2026/2026_09_13/Lied - Befiehl du deine Wege.mp3', mp3({}, 20));
    await ctx.scanner.scan();
    const structure = structuredClone(DEFAULT_STRUCTURE);
    structure.kinds[1]!.filePattern = '{inhalt} - {sprecher} - {titel}';
    await call('PUT', '/api/admin/structure', structure);
    const service = (await dated()).find((a) => a.date === '2026-09-13');
    expect(service).toMatchObject({ speaker: 'Meier', artist: 'Meier', passage: 'Psalm 23' });
    expect((await get('/api/categories/sprecher/values')).items.map((v: any) => v.value)).toEqual(['Meier']);
  });

  it('liest standardmäßig Inhalt - Titel - Sprecher, auch wenn die Datei Tags hat', async () => {
    const folder = 'Audio Aufnahmen/2026/2026_09_20_Erntedank';
    cloud.put(`${folder}/Predigt - Dankbarkeit - Pastor Meier.mp3`, mp3({ title: 'Aufnahme 3', artist: 'Mischpult' }, 80));
    cloud.put(`${folder}/Lied - Nun danket alle Gott - Chor.mp3`, mp3({ title: 'Aufnahme 1', artist: 'Mischpult' }, 20));
    cloud.put(`${folder}/Begrüßung.mp3`, mp3({ title: 'Aufnahme 0', artist: 'Mischpult' }, 10));
    await ctx.scanner.scan();
    const service = (await dated()).find((a) => a.date === '2026-09-20');
    expect(service).toMatchObject({ title: 'Erntedank', speaker: 'Pastor Meier', artist: 'Pastor Meier' });
    // Der Chor ist Interpret seines Liedes, aber nicht Sprecher des Gottesdienstes; ohne Namen im
    // Dateinamen bleibt der Interpret aus dem Tag.
    expect((await albumTracks(service.id)).map((t) => [t.title, t.artist])).toEqual([
      ['Begrüßung', 'Mischpult'],
      ['Lied: Nun danket alle Gott', 'Chor'],
      ['Predigt: Dankbarkeit', 'Pastor Meier'],
    ]);
    expect((await get('/api/categories/sprecher/values')).items.map((v: any) => v.value)).toEqual(['Pastor Meier']);
  });

  it('weist ungültige Muster verständlich ab', async () => {
    const structure = structuredClone(DEFAULT_STRUCTURE);
    structure.kinds[0]!.filePattern = '{datum}_{teil}';
    const res = await inject({ method: 'PUT', url: '/api/admin/structure', payload: structure });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Unbekannter Platzhalter {teil}');
    await call('PUT', '/api/admin/structure', { kinds: [] }, 400);
  });
});

describe('Uneinheitliche Dateinamen', () => {
  const folder = 'Audio Aufnahmen/2026/2026_09_20';
  beforeEach(async () => {
    for (const [name, length] of [
      ['01 - Lied - Einst scheint Ewiges Licht - Gemeindechor', 20],
      ['03 - Begrüßung - Jakob Rauschenberger', 10],
      ['05 - Einleitung - Text_Richter 7,1-4 - Jonathan Dürksen', 30],
      ['07 - Beitrag - Es tut mir heute noch weh - Irene Krahn& Fam. Dückmann', 20],
      ['09 - Predigt - Bergpredigt Text_Matthäus 7,7-14 - Jakob Rauschenberger', 90],
      ['10 - Schlusslied_Chor', 20],
    ] as Array<[string, number]>) {
      cloud.put(`${folder}/${name}.mp3`, mp3({}, length));
    }
    await ctx.scanner.scan();
  });

  const service = async () => (await dated()).find((a) => a.date === '2026-09-20');

  it('trennt nur an " - ", kennt Inhalte ohne Titel und liest "Text_" als Bibelstelle', async () => {
    const album = await service();
    // Alle Bibelstellen des Gottesdienstes, die der Predigt zuerst
    expect(album).toMatchObject({ speaker: 'Jakob Rauschenberger', passage: 'Matthäus 7,7-14; Richter 7,1-4', artist: 'Jakob Rauschenberger' });
    expect((await albumTracks(album.id)).map((t) => [t.title, t.artist, t.content])).toEqual([
      ['Lied: Einst scheint Ewiges Licht', 'Gemeindechor', 'Lied'],
      ['Begrüßung', 'Jakob Rauschenberger', 'Begrüßung'],
      ['Einleitung: Richter 7,1-4', 'Jonathan Dürksen', 'Einleitung'],
      ['Beitrag: Es tut mir heute noch weh', 'Irene Krahn& Fam. Dückmann', 'Beitrag'],
      ['Predigt: Bergpredigt (Matthäus 7,7-14)', 'Jakob Rauschenberger', 'Predigt'],
      ['Schlusslied: Chor', 'Jakob Rauschenberger', 'Schlusslied'],
    ]);
  });

  it('behält eine Korrektur aus der Verwaltung, wenn die Datei umbenannt wird', async () => {
    const album = await service();
    const odd = (await albumTracks(album.id)).find((t) => t.title === 'Schlusslied: Chor');
    await call('PATCH', `/api/admin/albums/${album.id}/tracks/${odd.id}`, { title: 'Lied: Schlusslied', speaker: 'Chor' });
    const fixed = async () => (await albumTracks(album.id)).find((t) => t.id === odd.id);
    expect(await fixed()).toMatchObject({ title: 'Lied: Schlusslied' });
    cloud.move(`${folder}/10 - Schlusslied_Chor.mp3`, `${folder}/10 - Schlusslied.mp3`);
    await ctx.scanner.scan();
    expect(await fixed()).toMatchObject({ title: 'Lied: Schlusslied' });
  });
});
