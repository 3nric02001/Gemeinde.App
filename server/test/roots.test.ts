import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { getMeta } from '../src/db.js';
import { createManualAlbum, updateAlbum } from '../src/library/curation.js';
import { movePath } from '../src/library/relocate.js';
import { commonBase } from '../src/nextcloud/webdav.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { sessionCookie } from './helpers/session.js';

let cloud: FakeNextcloud;
let dir: string;
const open: AppContext[] = [];

/** App mit echter Datenbankdatei, damit ein Neustart mit geänderten Ordnern prüfbar ist */
async function start(musicPath: string): Promise<AppContext> {
  const ctx = await buildApp(
    loadConfig({
      NEXTCLOUD_URL: cloud.url,
      NEXTCLOUD_USER: USER,
      NEXTCLOUD_PASSWORD: PASSWORD,
      NEXTCLOUD_MUSIC_PATH: musicPath,
      DATABASE_PATH: join(dir, 'library.db'),
    }),
    { logger: false },
  );
  open.push(ctx);
  return ctx;
}

async function stop(ctx: AppContext): Promise<void> {
  open.splice(open.indexOf(ctx), 1);
  await ctx.app.close();
}

const paths = (ctx: AppContext) =>
  (ctx.db.prepare('SELECT path FROM tracks ORDER BY path').all() as Array<{ path: string }>).map((r) => r.path);
const albumTitles = (ctx: AppContext) =>
  (ctx.db.prepare("SELECT title FROM albums WHERE kind = 'auto' ORDER BY title").all() as Array<{ title: string }>).map(
    (r) => r.title,
  );

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gemeinde-roots-'));
  // Die simulierte Nextcloud zeigt den ganzen Account, die Musikordner liegen darin.
  cloud = new FakeNextcloud('');
  await cloud.start();
  cloud.put('Gemeinde/Musik/Hillsong/Let There Be Light/01 Behold.mp3', mp3({ title: 'Behold', artist: 'Hillsong', album: 'Let There Be Light' }));
  cloud.put('Gemeinde/Musik/Hillsong/Let There Be Light/cover.jpg', Buffer.from('JPEG'));
  cloud.put('Gemeinde/Musik/.trash/alt.mp3', mp3({ title: 'Alt' }));
  cloud.put('Gemeinde/Predigten/2026-09-27 Erntedank/Predigt.mp3', mp3({ title: 'Predigt', artist: 'Pastor Meier' }));
  cloud.put('Jugend/Lieder/Band/Sommer/01 Du bist Herr.mp3', mp3({ title: 'Du bist Herr', artist: 'Jugendband', album: 'Sommer' }));
  cloud.put('Privat/geheim.mp3', mp3({ title: 'Geheim' }));
});

afterEach(async () => {
  for (const ctx of open.splice(0)) await ctx.app.close();
  await cloud.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('Mehrere Musikordner', () => {
  it('berechnet den gemeinsamen Elternordner', () => {
    expect(commonBase(['/Gemeinde/Musik'])).toBe('/Gemeinde/Musik');
    expect(commonBase(['/Gemeinde/Musik', '/Gemeinde/Predigten'])).toBe('/Gemeinde');
    expect(commonBase(['/Gemeinde/Musik', '/Jugend/Lieder'])).toBe('');
    expect(commonBase(['/Gemeinde/Musik', '/Gemeinde/Musikarchiv'])).toBe('/Gemeinde');
  });

  it('rechnet Pfade zwischen Bezugsordnern um', () => {
    expect(movePath('Hillsong/a.mp3', '/Gemeinde/Musik', '/Gemeinde')).toBe('Musik/Hillsong/a.mp3');
    expect(movePath('Musik/Hillsong/a.mp3', '/Gemeinde', '/Gemeinde/Musik')).toBe('Hillsong/a.mp3');
    expect(movePath('Predigten/a.mp3', '/Gemeinde', '/Gemeinde/Musik')).toBeUndefined();
    expect(movePath('a.mp3', '/Gemeinde', '')).toBe('Gemeinde/a.mp3');
    expect(movePath('', '/Gemeinde/Musik', '/Gemeinde')).toBe('Musik');
  });

  it('scannt alle angegebenen Ordner und nur diese', async () => {
    const ctx = await start('/Gemeinde/Musik, /Gemeinde/Predigten; /Jugend/Lieder');
    expect(await ctx.scanner.scan()).toMatchObject({ state: 'idle', filesSeen: 3, added: 3, failed: 0 });
    expect(paths(ctx)).toEqual([
      'Gemeinde/Musik/Hillsong/Let There Be Light/01 Behold.mp3',
      'Gemeinde/Predigten/2026-09-27 Erntedank/Predigt.mp3',
      'Jugend/Lieder/Band/Sommer/01 Du bist Herr.mp3',
    ]);
    expect(albumTitles(ctx)).toEqual(expect.arrayContaining(['Let There Be Light', 'Sommer']));
    expect(albumTitles(ctx)).toHaveLength(3);
    // Streaming und Ordner-Cover funktionieren mit den längeren Pfaden.
    const track = ctx.db.prepare("SELECT id FROM tracks WHERE title = 'Behold'").get() as { id: number };
    const signedIn = { cookie: sessionCookie(ctx.db) };
    expect((await ctx.app.inject({ method: 'GET', url: `/api/tracks/${track.id}/stream`, headers: signedIn })).statusCode).toBe(200);
    expect(ctx.db.prepare('SELECT path FROM folder_covers').all()).toEqual([
      { path: 'Gemeinde/Musik/Hillsong/Let There Be Light/cover.jpg' },
    ]);
  });

  it('bricht ab, statt Titel zu löschen, wenn einer der Ordner fehlt', async () => {
    const ctx = await start('/Gemeinde/Musik, /Gemeinde/Predigten');
    await ctx.scanner.scan();
    await stop(ctx);
    const next = await start('/Gemeinde/Musik, /Gemeinde/Predigten, /Gemeinde/Gibt es nicht');
    const status = await next.scanner.scan();
    expect(status).toMatchObject({ state: 'failed', lastError: 'Musikordner nicht gefunden: /Gemeinde/Gibt es nicht (NEXTCLOUD_MUSIC_PATH prüfen)' });
    expect(paths(next)).toHaveLength(2);
  });

  it('behält eigene Alben, Korrekturen und Regeln, wenn ein Ordner dazukommt oder wegfällt', async () => {
    const single = await start('/Gemeinde/Musik');
    await single.scanner.scan();
    expect(paths(single)).toEqual(['Hillsong/Let There Be Light/01 Behold.mp3']);
    const behold = single.db.prepare("SELECT id FROM tracks WHERE title = 'Behold'").get() as { id: number };
    const auto = single.db.prepare("SELECT id FROM albums WHERE title = 'Let There Be Light'").get() as { id: number };
    updateAlbum(single.db, auto.id, { title: 'Licht' });
    const manual = createManualAlbum(single.db, {
      title: 'Lobpreis',
      trackIds: [behold.id],
      rules: [{ condition: { field: 'path', op: 'starts', value: 'Hillsong/' } }],
    });
    await stop(single);

    const multi = await start('/Gemeinde/Musik, /Gemeinde/Predigten');
    expect(getMeta(multi.db, 'musicBase')).toBe('/Gemeinde');
    expect(await multi.scanner.scan()).toMatchObject({ state: 'idle', added: 1, updated: 0, removed: 0 });
    expect(paths(multi)).toEqual([
      'Musik/Hillsong/Let There Be Light/01 Behold.mp3',
      'Predigten/2026-09-27 Erntedank/Predigt.mp3',
    ]);
    // Gleiche Album-ID, Umbenennung bleibt, eigenes Album samt Regel ebenso
    const renamed = multi.db.prepare('SELECT title FROM albums WHERE id = ?').get(auto.id) as { title: string };
    expect(renamed.title).toBe('Licht');
    const inManual = multi.db.prepare('SELECT path FROM manual_album_tracks WHERE album_id = ?').all(manual);
    expect(inManual).toEqual([{ path: 'Musik/Hillsong/Let There Be Light/01 Behold.mp3' }]);
    const rule = multi.db.prepare('SELECT condition FROM album_rules WHERE album_id = ?').get(manual) as { condition: string };
    expect(JSON.parse(rule.condition)).toMatchObject({ field: 'path', op: 'starts', value: 'Musik/Hillsong/' });
    await stop(multi);

    // Zurück zu einem Ordner: alles wandert wieder zurück.
    const back = await start('/Gemeinde/Musik');
    // Die Predigt liegt in keinem Ordner mehr und ist schon beim Start verschwunden.
    expect(paths(back)).toEqual(['Hillsong/Let There Be Light/01 Behold.mp3']);
    expect(await back.scanner.scan()).toMatchObject({ state: 'idle', added: 0, updated: 0, removed: 0 });
    expect(paths(back)).toEqual(['Hillsong/Let There Be Light/01 Behold.mp3']);
    expect((back.db.prepare('SELECT title FROM albums WHERE id = ?').get(auto.id) as { title: string }).title).toBe('Licht');
    const trackCount = back.db.prepare('SELECT track_count AS n FROM albums WHERE id = ?').get(manual) as { n: number };
    expect(trackCount.n).toBe(1);
  });
});
