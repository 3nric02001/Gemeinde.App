import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrations, openDatabase } from '../src/db.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';
import { preferTags } from './helpers/structure.js';
import { sessionCookie } from './helpers/session.js';

let cookie = '';

let cloud: FakeNextcloud;
let ctx: AppContext;

interface TrackJson {
  id: number;
  title: string;
  album: string | null;
  albumId: number | null;
}
interface AlbumJson {
  id: number;
  title: string;
  artist: string;
  year: number | null;
  kind: 'auto' | 'manual';
  trackCount: number;
  hasCover: boolean;
  hidden?: boolean;
  tracks: TrackJson[];
  excluded?: Array<{ id: number; title: string }>;
  missing?: string[];
  overrides?: Record<string, unknown>;
}

async function call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, status = 200): Promise<T> {
  const res = await ctx.app.inject({ method, url, payload, headers: { cookie } });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
  return (res.body ? res.json() : undefined) as T;
}

async function publicAlbums(query = ''): Promise<AlbumJson[]> {
  return (await call<{ items: AlbumJson[] }>('GET', `/api/albums?limit=500&sort=title${query}`)).items;
}

async function albumId(title: string): Promise<number> {
  const found = (await call<{ items: AlbumJson[] }>('GET', `/api/admin/albums?limit=500`)).items.find((a) => a.title === title);
  expect(found, `Album ${title}`).toBeDefined();
  return found!.id;
}

async function trackIds(...titles: string[]): Promise<number[]> {
  const { items } = await call<{ items: TrackJson[] }>('GET', '/api/tracks?limit=500');
  return titles.map((title) => {
    const track = items.find((t) => t.title === title);
    expect(track, `Titel ${title}`).toBeDefined();
    return track!.id;
  });
}

const titles = (album: { tracks: TrackJson[] }) => album.tracks.map((t) => t.title);

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  cloud.put('Gottesdienste/2024-03-03/01 Begrüßung.mp3', mp3({ title: 'Begrüßung', artist: 'Gemeinde', album: 'Gottesdienst 03.03.', track: 1, year: 2024 }));
  cloud.put('Gottesdienste/2024-03-03/02 Predigt Psalm 23.mp3', mp3({ title: 'Predigt Psalm 23', artist: 'Pastor Meier', album: 'Gottesdienst 03.03.', track: 2, year: 2024 }));
  cloud.put('Gottesdienste/2024-03-03/cover.jpg', Buffer.from('GD1'));
  cloud.put('Gottesdienste/2024-03-10/01 Lied.mp3', mp3({ title: 'Lied', artist: 'Band', album: 'Gottesdienst 10.03.', track: 1, year: 2024 }));
  cloud.put('Gottesdienste/2024-03-10/02 Predigt Römer 8.mp3', mp3({ title: 'Predigt Römer 8', artist: 'Pastor Meier', album: 'Gottesdienst 10.03.', track: 2, year: 2024 }));
  cloud.put('Hillsong/Zion/01 Oceans.mp3', mp3({ title: 'Oceans', artist: 'Hillsong United', album: 'Zion', track: 1, year: 2013 }));
  ctx = await buildApp(
    loadConfig({
      NEXTCLOUD_URL: cloud.url,
      NEXTCLOUD_USER: USER,
      NEXTCLOUD_PASSWORD: PASSWORD,
      NEXTCLOUD_MUSIC_PATH: '/Musik',
      DATABASE_PATH: ':memory:',
    }),
    { logger: false },
  );
  preferTags(ctx.db);
  cookie = sessionCookie(ctx.db);
  await ctx.scanner.scan();
});

afterEach(async () => {
  await ctx.app.close();
  await cloud.stop();
});

describe('Admin-Zugang', () => {
  it('verlangt eine Anmeldung', async () => {
    for (const headers of [{}, { cookie: 'gemeinde_session=falsch' }]) {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/albums', headers });
      expect(res.statusCode).toBe(401);
    }
    const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/albums', payload: { title: 'X' } });
    expect(res.statusCode).toBe(401);
  });

  it('prüft Eingaben', async () => {
    await call('POST', '/api/admin/albums', { title: '   ' }, 400);
    await call('POST', '/api/admin/albums', { title: 'X', trackIds: [99999] }, 400);
    await call('PATCH', '/api/admin/albums/99999', { title: 'X' }, 404);
  });
});

describe('Manuelle Alben', () => {
  it('stellt Titel aus verschiedenen Ordnern zusammen, ohne sie aus ihren Alben zu nehmen', async () => {
    const ids = await trackIds('Predigt Römer 8', 'Predigt Psalm 23');
    const created = await call<AlbumJson>('POST', '/api/admin/albums', { title: 'Predigten', artist: 'Pastor Meier', trackIds: ids }, 201);
    expect(created).toMatchObject({ title: 'Predigten', artist: 'Pastor Meier', kind: 'manual', trackCount: 2, year: 2024 });
    expect(titles(created)).toEqual(['Predigt Römer 8', 'Predigt Psalm 23']);
    // Cover vom ersten Titel mit Cover
    expect(created.hasCover).toBe(true);

    // Beide Titel stehen jetzt in zwei Alben
    const detail = await call<AlbumJson>('GET', `/api/albums/${created.id}`);
    expect(titles(detail)).toEqual(['Predigt Römer 8', 'Predigt Psalm 23']);
    const gd = await call<AlbumJson>('GET', `/api/albums/${await albumId('Gottesdienst 03.03.')}`);
    expect(titles(gd)).toEqual(['Begrüßung', 'Predigt Psalm 23']);
    const inAlbum = await call<{ items: TrackJson[] }>('GET', `/api/tracks?albumId=${created.id}`);
    expect(inAlbum.items.map((t) => t.title).sort()).toEqual(['Predigt Psalm 23', 'Predigt Römer 8']);
    expect(await call('GET', `/api/admin/track-albums?ids=${ids[0]}`)).toEqual({
      [ids[0]!]: [
        { id: await albumId('Gottesdienst 10.03.'), title: 'Gottesdienst 10.03.', kind: 'auto' },
        { id: created.id, title: 'Predigten', kind: 'manual' },
      ],
    });

    // Auffindbar über den Albumtitel, auch wenn kein Titel so heißt
    expect((await publicAlbums('&q=predigten')).map((a) => a.title)).toEqual(['Predigten']);
    expect((await call('GET', '/api/facets')).totals).toMatchObject({ albums: 4, tracks: 5 });
  });

  it('verschiebt Titel auf Wunsch aus ihrem automatischen Album', async () => {
    const ids = await trackIds('Predigt Psalm 23', 'Predigt Römer 8');
    const { id } = await call<AlbumJson>('POST', '/api/admin/albums', { title: 'Predigten', trackIds: ids, move: true }, 201);
    const gd = await call<AlbumJson>('GET', `/api/admin/albums/${await albumId('Gottesdienst 03.03.')}`);
    expect(titles(gd)).toEqual(['Begrüßung']);
    expect(gd.excluded!.map((t) => t.title)).toEqual(['Predigt Psalm 23']);
    // Hauptalbum des Titels ist jetzt das manuelle Album
    const [track] = (await call<{ items: TrackJson[] }>('GET', '/api/tracks?q=psalm')).items;
    expect(track).toMatchObject({ albumId: id, album: 'Predigten' });

    // Wiederherstellen
    const restored = await call<AlbumJson>('POST', `/api/admin/albums/${gd.id}/tracks/${ids[0]}/restore`);
    expect(titles(restored)).toEqual(['Begrüßung', 'Predigt Psalm 23']);
    expect(restored.excluded).toEqual([]);
  });

  it('sortiert, ergänzt und entfernt Titel', async () => {
    const [psalm, roemer, oceans] = await trackIds('Predigt Psalm 23', 'Predigt Römer 8', 'Oceans');
    const { id } = await call<AlbumJson>('POST', '/api/admin/albums', { title: 'Mix', trackIds: [psalm] }, 201);
    let album = await call<AlbumJson>('POST', `/api/admin/albums/${id}/tracks`, { trackIds: [roemer, psalm, oceans] });
    expect(titles(album)).toEqual(['Predigt Psalm 23', 'Predigt Römer 8', 'Oceans']);
    album = await call<AlbumJson>('PUT', `/api/admin/albums/${id}/tracks`, { trackIds: [oceans, psalm] });
    expect(titles(album)).toEqual(['Oceans', 'Predigt Psalm 23']);
    album = await call<AlbumJson>('DELETE', `/api/admin/albums/${id}/tracks/${oceans}`);
    expect(titles(album)).toEqual(['Predigt Psalm 23']);
    expect(album.artist).toBe('Pastor Meier');
  });

  it('löscht nur manuelle Alben', async () => {
    const { id } = await call<AlbumJson>('POST', '/api/admin/albums', { title: 'Weg damit' }, 201);
    await call('DELETE', `/api/admin/albums/${id}`, undefined, 204);
    await call('GET', `/api/albums/${id}`, undefined, 404);
    await call('DELETE', `/api/admin/albums/${await albumId('Zion')}`, undefined, 409);
  });
});

describe('Automatische Alben korrigieren', () => {
  it('ändert Titel und Jahr und setzt sie wieder zurück', async () => {
    const id = await albumId('Zion');
    let album = await call<AlbumJson>('PATCH', `/api/admin/albums/${id}`, { title: 'Zion (Deluxe)', year: 2014 });
    expect(album).toMatchObject({ title: 'Zion (Deluxe)', year: 2014, overrides: { title: 'Zion (Deluxe)', year: 2014 } });
    expect((await call<{ items: TrackJson[] }>('GET', '/api/tracks?q=oceans')).items[0]!.album).toBe('Zion (Deluxe)');
    album = await call<AlbumJson>('PATCH', `/api/admin/albums/${id}`, { title: null, year: null });
    expect(album).toMatchObject({ title: 'Zion', year: 2013 });
  });

  it('blendet Alben für Hörer aus', async () => {
    const id = await albumId('Zion');
    await call('PATCH', `/api/admin/albums/${id}`, { hidden: true });
    expect((await publicAlbums()).map((a) => a.title)).not.toContain('Zion');
    await call('GET', `/api/albums/${id}`, undefined, 404);
    expect((await call<AlbumJson>('GET', `/api/admin/albums/${id}`)).hidden).toBe(true);
    // Der Titel bleibt suchbar, verweist aber nicht auf das ausgeblendete Album
    expect((await call<{ items: TrackJson[] }>('GET', '/api/tracks?q=oceans')).items[0]!.albumId).toBeNull();
    await call('PATCH', `/api/admin/albums/${id}`, { hidden: false });
    expect((await publicAlbums()).map((a) => a.title)).toContain('Zion');
  });
});

describe('Manuelle Änderungen überstehen Scans', () => {
  it('behält Alben, Reihenfolge, Korrekturen und Ausnahmen nach erneutem Scan', async () => {
    const ids = await trackIds('Predigt Römer 8', 'Predigt Psalm 23');
    const manual = await call<AlbumJson>('POST', '/api/admin/albums', { title: 'Predigten', trackIds: ids, move: true }, 201);
    const zion = await albumId('Zion');
    await call('PATCH', `/api/admin/albums/${zion}`, { title: 'Zion (Deluxe)', hidden: true });

    // Neue Datei, geänderte Tags und ein kompletter Scan
    cloud.put('Gottesdienste/2024-03-03/02 Predigt Psalm 23.mp3', mp3({ title: 'Predigt Psalm 23 (neu)', artist: 'Pastor Meier', album: 'Gottesdienst 03.03.', track: 2, year: 2024 }));
    cloud.put('Gottesdienste/2024-03-10/03 Segen.mp3', mp3({ title: 'Segen', artist: 'Gemeinde', album: 'Gottesdienst 10.03.', track: 3, year: 2024 }));
    expect(await ctx.scanner.scan()).toMatchObject({ state: 'idle', added: 1, updated: 1 });

    const after = await call<AlbumJson>('GET', `/api/admin/albums/${manual.id}`);
    expect(titles(after)).toEqual(['Predigt Römer 8', 'Predigt Psalm 23 (neu)']);
    expect(titles(await call<AlbumJson>('GET', `/api/admin/albums/${await albumId('Gottesdienst 03.03.')}`))).toEqual(['Begrüßung']);
    expect(titles(await call<AlbumJson>('GET', `/api/admin/albums/${await albumId('Gottesdienst 10.03.')}`))).toEqual(['Lied', 'Segen']);
    expect(await call<AlbumJson>('GET', `/api/admin/albums/${zion}`)).toMatchObject({ title: 'Zion (Deluxe)', hidden: true });
  });

  it('holt Titel zurück ins Album, wenn sie nach kurzem Fehlen wieder auftauchen', async () => {
    const ids = await trackIds('Predigt Römer 8', 'Predigt Psalm 23');
    const { id } = await call<AlbumJson>('POST', '/api/admin/albums', { title: 'Predigten', trackIds: ids }, 201);
    const file = cloud.files.get('Gottesdienste/2024-03-10/02 Predigt Römer 8.mp3')!;
    cloud.delete('Gottesdienste/2024-03-10/02 Predigt Römer 8.mp3');
    await ctx.scanner.scan();
    let album = await call<AlbumJson>('GET', `/api/admin/albums/${id}`);
    expect(titles(album)).toEqual(['Predigt Psalm 23']);
    expect(album.missing).toEqual(['Gottesdienste/2024-03-10/02 Predigt Römer 8.mp3']);

    // Umsortieren, während der Titel fehlt, verliert ihn nicht
    await call('PUT', `/api/admin/albums/${id}/tracks`, { trackIds: [ids[1]] });
    cloud.put('Gottesdienste/2024-03-10/02 Predigt Römer 8.mp3', file.data);
    await ctx.scanner.scan();
    album = await call<AlbumJson>('GET', `/api/admin/albums/${id}`);
    expect(titles(album)).toEqual(['Predigt Psalm 23', 'Predigt Römer 8']);
    expect(album.missing).toEqual([]);
  });
});

describe('Datenbank-Migration', () => {
  it('übernimmt bestehende Alben und Cover aus Version 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemeinde-'));
    try {
      const path = join(dir, 'library.db');
      const old = new Database(path);
      old.exec(migrations[0]!);
      old.pragma('user_version = 1');
      old.exec(`
        INSERT INTO albums (id, key, title, artist, folder, cover_path, track_count, duration, created_at)
          VALUES (7, 'A/B' || char(0) || 'b', 'B', 'A', 'A/B', 'A/B/CD 1/cover.jpg', 2, 0, 0);
        INSERT INTO tracks (path, etag, size, title, artist, album, album_id, track_no, disc_no, scanned_at) VALUES
          ('A/B/CD 1/02.mp3', 'e', 1, 'Zwei', 'A', 'B', 7, 2, 1, 0),
          ('A/B/CD 1/01.mp3', 'e', 1, 'Eins', 'A', 'B', 7, 1, 1, 0);
      `);
      old.close();

      const db = openDatabase(path);
      expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
      expect(
        db.prepare('SELECT t.title FROM album_tracks at JOIN tracks t ON t.id = at.track_id ORDER BY at.position').all(),
      ).toEqual([{ title: 'Eins' }, { title: 'Zwei' }]);
      expect(db.prepare('SELECT folder, path FROM folder_covers').all()).toEqual([
        { folder: 'A/B/CD 1', path: 'A/B/CD 1/cover.jpg' },
      ]);
      expect(db.prepare('SELECT kind, hidden FROM albums').get()).toEqual({ kind: 'auto', hidden: 0 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Regeln', () => {
  it('füllt ein Album mit allen passenden Titeln, auch künftigen', async () => {
    const preview = await call('POST', '/api/admin/rules/preview', { field: 'title', value: 'predigt' });
    expect(preview.total).toBe(2);

    const album = await call<AlbumJson & { rules: Array<{ id: number }> }>(
      'POST',
      '/api/admin/albums',
      { title: 'Predigten', rules: [{ field: 'title', op: 'contains', value: 'Predigt' }] },
      201,
    );
    // Neueste zuerst nach Datum im Ordnernamen
    expect(titles(album)).toEqual(['Predigt Römer 8', 'Predigt Psalm 23']);
    expect(album.rules).toHaveLength(1);
    // Ohne "verschieben" bleiben sie auch im Gottesdienst-Album
    expect(titles(await call('GET', `/api/admin/albums/${await albumId('Gottesdienst 03.03.')}`))).toEqual([
      'Begrüßung',
      'Predigt Psalm 23',
    ]);

    cloud.put('Gottesdienste/2024-03-17/02 PREDIGT Johannes 3.mp3', mp3({ title: 'PREDIGT: Johannes 3', artist: 'Pastor Meier', album: 'Gottesdienst 17.03.', track: 2, year: 2024 }));
    await ctx.scanner.scan();
    const after = await call<AlbumJson>('GET', `/api/admin/albums/${album.id}`);
    expect(titles(after)).toEqual(['PREDIGT: Johannes 3', 'Predigt Römer 8', 'Predigt Psalm 23']);
  });

  it('verschiebt auf Wunsch und lässt von Hand entfernte Titel draußen', async () => {
    const { id } = await call<AlbumJson>('POST', '/api/admin/albums', { title: 'Predigten' }, 201);
    let album = await call<AlbumJson & { rules: Array<{ id: number }> }>('POST', `/api/admin/albums/${id}/rules`, {
      field: 'artist',
      op: 'equals',
      value: 'pastor meier',
      move: true,
    });
    expect(titles(album)).toEqual(['Predigt Römer 8', 'Predigt Psalm 23']);
    const gd = await call<AlbumJson & { movedByRule: Array<{ title: string; albumTitle: string }> }>(
      'GET',
      `/api/admin/albums/${await albumId('Gottesdienst 03.03.')}`,
    );
    expect(titles(gd)).toEqual(['Begrüßung']);
    expect(gd.movedByRule).toEqual([expect.objectContaining({ title: 'Predigt Psalm 23', albumTitle: 'Predigten' })]);

    const [psalm] = await trackIds('Predigt Psalm 23');
    album = await call('DELETE', `/api/admin/albums/${id}/tracks/${psalm}`);
    expect(titles(album)).toEqual(['Predigt Römer 8']);
    await ctx.scanner.scan();
    expect(titles(await call('GET', `/api/admin/albums/${id}`))).toEqual(['Predigt Römer 8']);
    // Von Hand wieder hinzufügen geht
    album = await call('POST', `/api/admin/albums/${id}/tracks`, { trackIds: [psalm] });
    expect(titles(album)).toEqual(['Predigt Psalm 23', 'Predigt Römer 8']);

    // Regel löschen: nur noch der von Hand eingetragene Titel, der andere ist zurück im Gottesdienst
    album = await call('DELETE', `/api/admin/albums/${id}/rules/${album.rules[0]!.id}`);
    expect(titles(album)).toEqual(['Predigt Psalm 23']);
    expect(titles(await call('GET', `/api/admin/albums/${await albumId('Gottesdienst 10.03.')}`))).toEqual([
      'Lied',
      'Predigt Römer 8',
    ]);
  });

  it('prüft Regeln', async () => {
    const { id } = await call<AlbumJson>('POST', '/api/admin/albums', { title: 'X' }, 201);
    await call('POST', `/api/admin/albums/${id}/rules`, { field: 'farbe', value: 'rot' }, 400);
    await call('POST', `/api/admin/albums/${id}/rules`, { field: 'title', value: '   ' }, 400);
    await call('POST', `/api/admin/albums/${id}/rules`, { condition: { match: 'all', conditions: [] } }, 400);
    await call('POST', `/api/admin/albums/${id}/rules`, { condition: { match: 'vielleicht', conditions: [{ field: 'title', value: 'a' }] } }, 400);
    let deep: object = { field: 'title', value: 'a' };
    for (let i = 0; i < 5; i++) deep = { match: 'any', conditions: [deep, { field: 'title', value: 'b' }] };
    const res = await ctx.app.inject({ method: 'POST', url: `/api/admin/albums/${id}/rules`, headers: { cookie }, payload: { condition: deep } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Ebenen');
    await call('POST', `/api/admin/albums/${await albumId('Zion')}/rules`, { field: 'title', value: 'a' }, 409);
    await call('DELETE', `/api/admin/albums/${id}/rules/999`, undefined, 404);
  });
});

describe('Verschachtelte Regeln', () => {
  it('verknüpft Bedingungen mit UND, ODER und "enthält nicht"', async () => {
    // (Titel enthält Predigt UND Interpret ist Pastor Meier) ODER (Ordner enthält 2024-03-10 UND Titel enthält nicht Predigt)
    const condition = {
      match: 'any',
      conditions: [
        { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'predigt' }, { field: 'artist', op: 'equals', value: 'Pastor Meier' }] },
        { match: 'all', conditions: [{ field: 'path', op: 'contains', value: '2024-03-10' }, { field: 'title', op: 'not_contains', value: 'Predigt' }] },
      ],
    };
    const preview = await call('POST', '/api/admin/rules/preview', { condition });
    expect(preview.total).toBe(3);
    const album = await call<AlbumJson & { rules: Array<{ id: number; condition: unknown }> }>(
      'POST',
      '/api/admin/albums',
      { title: 'Mix', rules: [{ condition }] },
      201,
    );
    expect(titles(album).sort()).toEqual(['Lied', 'Predigt Psalm 23', 'Predigt Römer 8']);
    expect(album.rules[0]!.condition).toEqual(condition);

    // Regel ändern: nur noch der erste Zweig
    const updated = await call<AlbumJson>('PUT', `/api/admin/albums/${album.id}/rules/${album.rules[0]!.id}`, {
      condition: { match: 'all', conditions: [condition.conditions[0]] },
    });
    // Gruppe mit einem Eintrag wird zur einfachen Bedingung aufgelöst
    expect((updated as unknown as { rules: Array<{ condition: unknown }> }).rules[0]!.condition).toEqual(condition.conditions[0]);
    expect(titles(updated).sort()).toEqual(['Predigt Psalm 23', 'Predigt Römer 8']);
  });

  it('übernimmt einfache Regeln aus Version 4', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemeinde-'));
    try {
      const path = join(dir, 'library.db');
      const old = new Database(path);
      for (const sql of migrations.slice(0, 4)) old.exec(sql);
      old.pragma('user_version = 4');
      old.exec(`
        INSERT INTO albums (id, key, kind, title, artist, folder, created_at) VALUES (1, 'manual:x', 'manual', 'P', '', '', 0);
        INSERT INTO album_rules (album_id, field, op, value, move, created_at) VALUES (1, 'title', 'contains', 'Predigt', 1, 0);
      `);
      old.close();
      const db = openDatabase(path);
      expect(db.prepare('SELECT album_id, condition, move FROM album_rules').all()).toEqual([
        { album_id: 1, condition: '{"field":"title","op":"contains","value":"Predigt"}', move: 1 },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
