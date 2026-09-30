import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { preferTags } from './helpers/structure.js';
import { sessionCookie } from './helpers/session.js';
import { HALF_LIFE_MS, PLAY_COOLDOWN_MS, recordPlay } from '../src/library/popularity.js';

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

const trackId = (title: string) => (ctx.db.prepare('SELECT id FROM tracks WHERE title = ?').get(title) as { id: number }).id;
const albumId = (title: string) => (ctx.db.prepare('SELECT id FROM albums WHERE title = ?').get(title) as { id: number }).id;

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  const service = (folder: string, title: string, custom: Record<string, string> = {}) =>
    cloud.put(`Gottesdienste/2026/${folder}/01 ${title}.mp3`, mp3({ title, artist: 'MBG', genre: 'Gottesdienst', custom }));
  service('2026-08-30 Jugendgottesdienst', 'Input');
  service('2026-09-20', 'Predigt Psalm 23', { Sprecher: 'Pastor Meier', Bibelstelle: 'Psalm 23' });
  // Datum im deutschen Format und ohne Jahr in den Tags: sortiert trotzdem richtig
  service('13.09.2026 Taufgottesdienst', 'Taufe');
  service('2026-09-27 Erntedank', 'Predigt Dankbarkeit', { Sprecher: 'Anna Schulz' });
  cloud.put('Hillsong/Let There Be Light/01 Behold.mp3', mp3({ title: 'Behold', artist: 'Hillsong', album: 'Let There Be Light', year: 2016, genre: 'Worship' }));
  const config = loadConfig({
    NEXTCLOUD_URL: cloud.url,
    NEXTCLOUD_USER: USER,
    NEXTCLOUD_PASSWORD: PASSWORD,
    NEXTCLOUD_MUSIC_PATH: '/Musik',
    DATABASE_PATH: ':memory:',
  });
  ctx = await buildApp(config, { logger: false });
  preferTags(ctx.db);
  cookie = sessionCookie(ctx.db);
  await ctx.scanner.scan();
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});


const play = (id: number, as = cookie) => inject({ method: 'POST', url: `/api/me/plays/${id}` }, as);
const titles = (items: Array<{ title: string }>) => items.map((item) => item.title);

describe('Verdecktes Scoring', () => {
  it('zählt Wiedergaben nur für vorhandene Titel', async () => {
    expect((await play(trackId('Behold'))).statusCode).toBe(204);
    expect((await play(999_999)).statusCode).toBe(404);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM track_popularity').get()).toEqual({ n: 1 });
  });

  it('holt oft Gehörtes in der Titelsuche nach oben, sonst bleibt das neueste vorne', async () => {
    expect(titles((await get('/api/tracks?q=predigt')).items)).toEqual(['Predigt Dankbarkeit', 'Predigt Psalm 23']);
    await play(trackId('Predigt Psalm 23'));
    const found = await get('/api/tracks?q=predigt');
    expect(titles(found.items)).toEqual(['Predigt Psalm 23', 'Predigt Dankbarkeit']);
    // Die Zahl selbst bleibt verborgen
    expect(Object.keys(found.items[0])).not.toContain('score');
  });

  it('zählt dieselbe Person nur einmal in der Sperrfrist, andere Hörer schon', async () => {
    const id = trackId('Predigt Psalm 23');
    const score = () => (ctx.db.prepare('SELECT score FROM track_popularity WHERE track_id = ?').get(id) as { score: number }).score;
    const now = Date.now();
    const user = addListener('anna');
    recordPlay(ctx.db, user, id, now);
    const once = score();
    recordPlay(ctx.db, user, id, now + 60_000);
    expect(score()).toBe(once);
    recordPlay(ctx.db, addListener('ben'), id, now);
    expect(score()).toBeCloseTo(2 * once);
    recordPlay(ctx.db, user, id, now + PLAY_COOLDOWN_MS + 1);
    expect(score()).toBeGreaterThan(2.9 * once);
  });

  it('lässt alte Wiedergaben verblassen', async () => {
    recordPlay(ctx.db, addListener('anna'), trackId('Predigt Psalm 23'), Date.now() - 2 * HALF_LIFE_MS);
    expect(titles((await get('/api/tracks?q=predigt')).items)).toEqual(['Predigt Dankbarkeit', 'Predigt Psalm 23']);
  });

  it('ordnet Alben in Suche und Vorschlägen nach Beliebtheit, bewusst gewählte Sortierung bleibt', async () => {
    const byDate = titles((await get('/api/albums?q=predigt&sort=date')).items);
    expect(byDate).toHaveLength(2);
    const older = byDate[1]!;
    const olderTrack = older.includes('Erntedank') ? 'Predigt Dankbarkeit' : 'Predigt Psalm 23';
    await play(trackId(olderTrack));
    expect(titles((await get('/api/albums?q=predigt&sort=date')).items)[0]).toBe(older);
    const byTitle = titles((await get('/api/albums?q=predigt&sort=title')).items);
    expect(byTitle).toEqual([...byTitle].sort((a, b) => a.localeCompare(b)));
    expect(titles((await get('/api/albums?genre=Gottesdienst&sort=popular')).items)[0]).toBe(older);
  });

  it('lässt die Startseite mit neuen Alben unberührt', async () => {
    const before = titles((await get('/api/albums?sort=recent')).items);
    await play(trackId('Behold'));
    expect(titles((await get('/api/albums?sort=recent')).items)).toEqual(before);
  });

  it('vergisst die Zählung mit dem Titel', async () => {
    const id = trackId('Behold');
    await play(id);
    ctx.db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM track_popularity').get()).toEqual({ n: 0 });
    expect(ctx.db.prepare('SELECT count(*) AS n FROM track_plays').get()).toEqual({ n: 0 });
  });
});
