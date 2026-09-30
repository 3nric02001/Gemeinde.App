import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { compilePolicies, parsePolicies, policyMatcher, type Policy } from '../src/library/policies.js';
import { DEFAULT_STRUCTURE, getStructure, parseStructure, type Structure } from '../src/library/structure.js';
import { setMeta } from '../src/db.js';
import { rebuildAlbums } from '../src/library/albums.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

describe('Policies', () => {
  const policies: Policy[] = [
    { name: 'Konzerte', enabled: true, when: { field: 'genre', op: 'contains', value: 'Konzert' }, player: 'music' },
    { name: 'Aus', enabled: false, when: { field: 'content', op: 'equals', value: 'Lied' }, sermon: true, player: 'sermon' },
    { name: 'Predigt', enabled: true, when: { field: 'content', op: 'equals', value: 'Predigt' }, sermon: true, player: 'sermon' },
    { name: 'Lang', enabled: true, when: { field: 'duration', op: 'at_least', value: '20' }, player: 'sermon' },
  ];
  const decide = compilePolicies(policies);

  it('entscheidet je Wirkung mit der ersten passenden Policy, abgeschaltete zählen nicht', () => {
    expect(decide({ content: 'Predigt', genre: 'Gottesdienst' })).toEqual({
      sermon: true,
      sermonBy: 'Predigt',
      player: 'sermon',
      playerBy: 'Predigt',
    });
    // Der Player kommt schon aus "Konzerte", die Predigt trotzdem aus der nächsten passenden Policy
    expect(decide({ content: 'predigt', genre: 'Konzert-Mitschnitt' })).toEqual({
      sermon: true,
      sermonBy: 'Predigt',
      player: 'music',
      playerBy: 'Konzerte',
    });
    expect(decide({ content: 'Lied', duration: 1500 })).toEqual({ player: 'sermon', playerBy: 'Lang' });
    expect(decide({ content: 'Lied', duration: 300 })).toEqual({});
    // Unbekannte Dauer passt auf keinen Vergleich
    expect(decide({ content: 'Lied', duration: null })).toEqual({});
  });

  it('vergleicht Ordner als ganze Namen und ohne Groß-/Kleinschreibung und Umlaute', () => {
    const folder = policyMatcher({ field: 'folder', op: 'equals', value: 'Bibelstunden' });
    expect(folder({ path: 'Audio/bibelstunden/2026_01_14/' })).toBe(true);
    expect(folder({ path: 'Audio/Bibelstunden 2025/2026_01_14/' })).toBe(false);
    // Der Dateiname selbst ist kein Ordner
    expect(folder({ path: 'Audio/Bibelstunden.mp3' })).toBe(false);
    expect(policyMatcher({ field: 'title', op: 'starts', value: 'BEGRUSSUNG' })({ title: 'Begrussung am Morgen' })).toBe(true);
    expect(policyMatcher({ field: 'content', op: 'equals', value: 'Gebet' })({ content: 'Gebét' })).toBe(true);
  });

  it('weist unvollständige oder widersprüchliche Policies verständlich ab', () => {
    expect(() => parsePolicies([{ name: 'X', when: { field: 'title', op: 'contains', value: 'a' } }])).toThrow('bewirkt nichts');
    expect(() => parsePolicies([{ name: 'X', when: { field: 'duration', op: 'contains', value: '5' }, player: 'music' }])).toThrow(
      'mindestens',
    );
    expect(() => parsePolicies([{ name: 'X', when: { field: 'duration', op: 'at_least', value: 'lang' }, player: 'music' }])).toThrow(
      'Minuten',
    );
    expect(() => parsePolicies([{ name: 'X', when: { field: 'title', op: 'contains', value: ' ' }, player: 'music' }])).toThrow('Wert');
  });

  it('übernimmt Regelwerke von vor den Policies: Ordner wird Bedingung, Inhalt der Predigt wird Policy', () => {
    const legacy = {
      kinds: [
        { ...DEFAULT_STRUCTURE.kinds[0], match: undefined, datedOnly: undefined, folder: 'Bibelstunden', sermon: '' },
        { ...DEFAULT_STRUCTURE.kinds[1], match: undefined, datedOnly: undefined, folder: '', sermon: 'Predigt' },
      ],
      contents: DEFAULT_STRUCTURE.contents,
      untitled: DEFAULT_STRUCTURE.untitled,
    };
    const parsed = parseStructure(JSON.parse(JSON.stringify(legacy)));
    expect(parsed.kinds.map((k) => [k.name, k.match, k.datedOnly])).toEqual([
      ['Bibelstunde', { field: 'folder', op: 'equals', value: 'Bibelstunden' }, true],
      ['Gottesdienst', null, true],
    ]);
    expect(parsed.policies.map((p) => [p.when, p.sermon, p.player])).toEqual(
      [...DEFAULT_STRUCTURE.policies].reverse().map((p) => [p.when, p.sermon, p.player]),
    );
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
const albums = async () => (await get('/api/albums?limit=50&sort=title')).items as any[];
const albumTracks = async (id: number) => (await get(`/api/albums/${id}`)).tracks as any[];
const byDate = async (date: string) => (await albums()).find((a) => a.date === date);

beforeEach(async () => {
  cloud = new FakeNextcloud('/Gemeinde');
  await cloud.start();
  const service = 'Audio Aufnahmen/2026/2026_08_30_Einschulung';
  cloud.put(`${service}/Lied - Großer Gott - Chor.mp3`, mp3({}, 20));
  cloud.put(`${service}/Predigt - Der gute Hirte - Pastor Meier.mp3`, mp3({}, 80));
  cloud.put(`${service}/Zeugnis - Anna Schulz.mp3`, mp3({}, 40));
  const study = 'Audio Aufnahmen/2026/Bibelstunden/2026_01_14_Matthäus 9, 27-38';
  cloud.put(`${study}/2026_01_14_001.mp3`, mp3({}, 30));
  cloud.put('Audio Aufnahmen/Jugend/Abend mit Tim/Andacht - Mut.mp3', mp3({}, 30));
  cloud.put('Musik/Hillsong/Zion/01.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion' }));
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

describe('Policies im Regelwerk', () => {
  it('geben der Predigt den Predigt-Player, den übrigen Titeln keinen festen', async () => {
    const service = await byDate('2026-08-30');
    expect(service).toMatchObject({ recording: 'Gottesdienst', speaker: 'Pastor Meier' });
    expect((await albumTracks(service.id)).map((t) => [t.content, t.player])).toEqual([
      ['Lied', null],
      ['Predigt', 'sermon'],
      ['Zeugnis', null],
    ]);
    // Bibelstunden gelten ganz als Predigt
    const study = await byDate('2026-01-14');
    expect((await albumTracks(study.id)).map((t) => t.player)).toEqual(['sermon']);
    // Musik ohne passende Policy: nach Länge (im Browser)
    const zion = (await albums()).find((a) => a.title === 'Zion');
    expect((await albumTracks(zion.id))[0].player).toBeNull();
  });

  it('legen fest, was als Predigt gilt: dann kommen Sprecher und Player von dort', async () => {
    const structure: Structure = structuredClone(getStructure(ctx.db));
    structure.policies = [
      {
        name: 'Zeugnis zählt als Predigt',
        enabled: true,
        when: { field: 'content', op: 'equals', value: 'Zeugnis' },
        sermon: true,
        player: 'sermon',
      },
      { name: 'Sonst Musik', enabled: true, when: { field: 'path', op: 'contains', value: 'Aufnahmen' }, sermon: false, player: 'music' },
    ];
    await call('PUT', '/api/admin/structure', structure);
    const service = await byDate('2026-08-30');
    expect(service).toMatchObject({ speaker: 'Anna Schulz', artist: 'Anna Schulz' });
    expect((await albumTracks(service.id)).map((t) => [t.content, t.player])).toEqual([
      ['Lied', 'music'],
      ['Predigt', 'music'],
      ['Zeugnis', 'sermon'],
    ]);
    expect((await get('/api/categories/sprecher/values')).items.map((v: any) => v.value)).toEqual(['Anna Schulz']);
  });

  it('zeigen in der Vorschau, was als Predigt gilt und welcher Player läuft', async () => {
    const preview = await call('POST', '/api/admin/structure/preview', getStructure(ctx.db));
    const service = preview.kinds[1].examples.find((e: any) => e.date === '2026-08-30');
    expect(service.tracks.map((t: any) => [t.content, t.sermon, t.player])).toEqual([
      ['Lied', false, 'music'],
      ['Predigt', true, 'sermon'],
      ['Zeugnis', false, 'music'],
    ]);
  });

  it('merken sich die Stelle nur im Predigt-Player', async () => {
    const service = await byDate('2026-08-30');
    const [song, sermon] = await albumTracks(service.id);
    await inject({ method: 'PUT', url: `/api/me/progress/${song.id}`, payload: { position: 5, duration: 20 } });
    await inject({ method: 'PUT', url: `/api/me/progress/${sermon.id}`, payload: { position: 5, duration: 80 } });
    expect((await get('/api/me/progress')).items.map((p: any) => p.trackId)).toEqual([sermon.id]);
  });
});

describe('Eigene Arten', () => {
  it('erkennen Ordner auch ohne Datum an einer eigenen Bedingung', async () => {
    const structure: Structure = structuredClone(getStructure(ctx.db));
    structure.kinds.unshift({
      name: 'Jugendabend',
      plural: 'Jugendabende',
      match: { match: 'all', conditions: [{ field: 'folder', op: 'equals', value: 'Jugend' }] },
      datedOnly: false,
      folderPattern: '{anlass}',
      filePattern: '{inhalt} - {titel}',
      albumTitle: '{anlass}',
      trackTitle: '{titel}',
      preferTags: false,
    });
    structure.contents.push('Andacht');
    structure.policies.push({ name: 'Andachten', enabled: true, when: { field: 'kind', op: 'equals', value: 'Jugendabend' }, sermon: true, player: 'sermon' });
    const saved = (await call('PUT', '/api/admin/structure', structure)).structure;
    // Eine Gruppe mit nur einer Bedingung wird zur Bedingung
    expect(saved.kinds[0].match).toEqual({ field: 'folder', op: 'equals', value: 'Jugend' });
    const youth = (await albums()).find((a) => a.recording === 'Jugendabend');
    expect(youth).toMatchObject({ title: 'Abend mit Tim' });
    expect((await albumTracks(youth.id)).map((t) => [t.title, t.content, t.player])).toEqual([['Mut', 'Andacht', 'sermon']]);
    // Musik bleibt Musik
    expect((await albums()).find((a) => a.title === 'Zion').recording).toBeNull();
  });

  it('lassen sich je Album von Hand setzen; das geht dem Regelwerk vor und landet im Protokoll', async () => {
    const service = await byDate('2026-08-30');
    await call('PATCH', `/api/admin/albums/${service.id}`, { recording: 'bibelstunde' });
    expect(await byDate('2026-08-30')).toMatchObject({ recording: 'Bibelstunde' });
    // Als Bibelstunde gilt jeder Titel als Predigt
    expect((await albumTracks(service.id)).map((t) => t.player)).toEqual(['sermon', 'sermon', 'sermon']);
    expect((await get(`/api/admin/albums/${service.id}`)).manualRecording).toBe('Bibelstunde');
    const changes = (await get('/api/admin/changes')).items as any[];
    expect(changes[0].action).toBe('Album bearbeitet (Art)');

    // Keine Art: wieder Musik
    await call('PATCH', `/api/admin/albums/${service.id}`, { recording: '' });
    expect((await byDate('2026-08-30')).recording).toBeNull();
    // Zurück zum Regelwerk
    await call('PATCH', `/api/admin/albums/${service.id}`, { recording: null });
    expect(await byDate('2026-08-30')).toMatchObject({ recording: 'Gottesdienst' });
    expect((await get(`/api/admin/albums/${service.id}`)).manualRecording).toBeNull();

    await call('PATCH', `/api/admin/albums/${service.id}`, { recording: 'Konzert' }, 400);
  });

  it('zeigen je Titel die greifende Policy und lassen sich je Titel korrigieren', async () => {
    const service = await byDate('2026-08-30');
    const [song, sermon, testimony] = await albumTracks(service.id);
    let detail = await get(`/api/admin/albums/${service.id}`);
    expect(detail.trackEdits.map((t: any) => [t.id, t.auto, t.sermon, t.player])).toEqual([
      [song.id, {}, null, null],
      [sermon.id, { sermon: true, sermonBy: 'Predigt im Gottesdienst', player: 'sermon', playerBy: 'Predigt im Gottesdienst' }, null, null],
      [testimony.id, {}, null, null],
    ]);

    // Das Zeugnis wird von Hand zur Predigt, die eigentliche Predigt läuft im Musik-Player
    await call('PATCH', `/api/admin/albums/${service.id}/tracks/${testimony.id}`, { sermon: true, player: 'sermon' });
    await call('PATCH', `/api/admin/albums/${service.id}/tracks/${sermon.id}`, { sermon: false, player: 'music' });
    expect(await byDate('2026-08-30')).toMatchObject({ speaker: 'Anna Schulz' });
    expect((await albumTracks(service.id)).map((t) => t.player)).toEqual([null, 'music', 'sermon']);
    detail = await get(`/api/admin/albums/${service.id}`);
    // Die Policy bleibt sichtbar, auch wenn die Korrektur vorgeht
    expect(detail.trackEdits[1]).toMatchObject({ sermon: false, player: 'music', auto: { sermon: true, player: 'sermon' } });

    // Korrekturen überstehen neue Scans; null heißt wieder nach den Policies
    await ctx.scanner.scan();
    expect((await albumTracks(service.id)).map((t) => t.player)).toEqual([null, 'music', 'sermon']);
    await call('PATCH', `/api/admin/albums/${service.id}/tracks/${sermon.id}`, { sermon: null, player: null });
    await call('PATCH', `/api/admin/albums/${service.id}/tracks/${testimony.id}`, { sermon: null, player: null });
    expect((await albumTracks(service.id)).map((t) => t.player)).toEqual([null, 'sermon', null]);
    expect(await byDate('2026-08-30')).toMatchObject({ speaker: 'Pastor Meier' });
    expect(ctx.db.prepare('SELECT count(*) AS n FROM track_overrides').get()).toEqual({ n: 0 });
    await call('PATCH', `/api/admin/albums/${service.id}/tracks/${sermon.id}`, { player: 'laut' }, 400);
  });

  it('bleiben nach einem Neustart mit altem gespeichertem Regelwerk erhalten', () => {
    setMeta(
      ctx.db,
      'structure',
      JSON.stringify({
        kinds: [{ name: 'Gottesdienst', plural: 'Gottesdienste', folder: '', folderPattern: '{datum}_{anlass}', filePattern: '{inhalt} - {titel} - {sprecher}', albumTitle: '{anlass}', trackTitle: '{inhalt}: {titel}', sermon: 'Zeugnis', preferTags: false }],
        contents: ['Lied', 'Predigt', 'Zeugnis'],
      }),
    );
    rebuildAlbums(ctx.db);
    const row = ctx.db.prepare("SELECT speaker FROM albums WHERE date = '2026-08-30'").get() as { speaker: string };
    expect(row.speaker).toBe('Anna Schulz');
  });
});
