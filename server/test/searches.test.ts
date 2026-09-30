import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';
import { recordPlay } from '../src/library/popularity.js';
import { MIN_SEARCHERS, RETENTION_MS, recordSearch } from '../src/library/searches.js';

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

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  const service = (folder: string, file: string, custom: Record<string, string> = {}) =>
    cloud.put(`Gottesdienste/2026/${folder}/01 ${file}.mp3`, mp3({ title: 'Tag', artist: 'MBG', custom }));
  service('2026-08-30 Jugendgottesdienst', 'Input');
  service('2026-09-20', 'Predigt - Psalm 23 - Pastor Meier');
  // Datum im deutschen Format: sortiert trotzdem richtig
  service('13.09.2026 Taufgottesdienst', 'Taufe');
  service('2026-09-27 Erntedank', 'Predigt - Dankbarkeit - Anna Schulz');
  cloud.put('Hillsong/Let There Be Light/01 Behold.mp3', mp3({}));
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


const search = (q: string, as = cookie) => inject({ method: 'POST', url: '/api/me/searches', payload: { q } }, as);
const suggestions = () => get<{ searches: string[]; albums: Array<{ title: string }> }>('/api/search/suggestions');
/** Sitzungen für n verschiedene Hörer */
const listeners = (n: number, prefix = 'h') => Array.from({ length: n }, (_, i) => sessionCookie(ctx.db, addListener(`${prefix}${i}`)));

describe('Vorschläge auf der Suchseite', () => {
  it('zeigt einen Begriff erst, wenn ihn mehrere Personen gesucht haben', async () => {
    const people = listeners(MIN_SEARCHERS);
    for (const person of people.slice(1)) expect((await search('Pastor Meier', person)).statusCode).toBe(204);
    // Dieselbe Person mehrfach zählt nicht mehr
    await search('pastor  meier', people[1]);
    await search('Pastor Meier', people[1]);
    expect((await suggestions()).searches).toEqual([]);
    await search('pastor meier', people[0]);
    expect((await suggestions()).searches).toEqual(['pastor meier']);
  });

  it('merkt sich keine Begriffe ohne Treffer, zu kurze oder zu lange', async () => {
    for (const person of listeners(MIN_SEARCHERS)) {
      await search('Geheimes Anliegen', person);
      await search('x', person);
      await search('Predigt '.repeat(10), person);
    }
    expect(ctx.db.prepare('SELECT count(*) AS n FROM search_log').get()).toEqual({ n: 0 });
    expect((await suggestions()).searches).toEqual([]);
  });

  it('ordnet nach Zahl der Personen und verrät nicht, wer gesucht hat', async () => {
    const people = listeners(MIN_SEARCHERS + 1);
    for (const person of people) await search('Behold', person);
    for (const person of people.slice(0, MIN_SEARCHERS)) await search('Psalm 23', person);
    const body = await get('/api/search/suggestions');
    expect(body.searches).toEqual(['Behold', 'Psalm 23']);
    expect(JSON.stringify(body)).not.toMatch(/h0|user/);
  });

  it('vergisst alte Einträge und die eines gelöschten Benutzers', async () => {
    const ids = Array.from({ length: MIN_SEARCHERS }, (_, i) => addListener(`alt${i}`));
    const old = Date.now() - RETENTION_MS - 1000;
    for (const id of ids) recordSearch(ctx.db, id, 'Taufe', old);
    expect((await suggestions()).searches).toEqual([]);
    recordSearch(ctx.db, ids[0]!, 'Behold');
    expect(ctx.db.prepare('SELECT count(*) AS n FROM search_log').get()).toEqual({ n: 1 });
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(ids[0]);
    expect(ctx.db.prepare('SELECT count(*) AS n FROM search_log').get()).toEqual({ n: 0 });
  });

  it('zeigt einen Begriff nicht mehr, wenn die Bibliothek nichts mehr dazu hat', async () => {
    for (const person of listeners(MIN_SEARCHERS)) await search('Behold', person);
    expect((await suggestions()).searches).toEqual(['Behold']);
    ctx.db.prepare("DELETE FROM tracks WHERE title = 'Behold'").run();
    expect((await suggestions()).searches).toEqual([]);
  });

  it('schlägt nur Alben vor, die wirklich gehört wurden', async () => {
    expect((await suggestions()).albums).toEqual([]);
    recordPlay(ctx.db, addListener('anna'), trackId('Behold'));
    expect((await suggestions()).albums.map((album) => album.title)).toEqual(['Let There Be Light']);
  });

  it('nimmt nur angemeldete Hörer an', async () => {
    expect((await search('Hillsong', '')).statusCode).toBe(401);
  });
});
