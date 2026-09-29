import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sessionCookie } from './helpers/session.js';

let dir: string;
let ctx: AppContext;
let cookie = '';
/** Anfrage mit angemeldeter Sitzung */
const inject = (options: InjectOptions) => ctx.app.inject({ ...options, headers: { cookie, ...options.headers } });

async function start(webDir: string) {
  const config = loadConfig({
    NEXTCLOUD_URL: 'http://127.0.0.1:1',
    NEXTCLOUD_USER: 'u',
    NEXTCLOUD_PASSWORD: 'p',
    NEXTCLOUD_MUSIC_PATH: '/Musik',
    DATABASE_PATH: ':memory:',
    WEB_DIR: webDir,
  });
  ctx = await buildApp(config, { logger: false });
  cookie = sessionCookie(ctx.db);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gemeinde-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Gemeinde.App</title>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
});

afterEach(async () => {
  await ctx?.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Weboberfläche', () => {
  it('liefert index.html für die Startseite und für Seiten wie /album/3', async () => {
    await start(dir);
    for (const url of ['/', '/album/3', '/interpret/Hillsong', '/suche?q=x']) {
      const res = await inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<title>Gemeinde.App</title>');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('cacht gehashte Dateien lange, andere nicht', async () => {
    await start(dir);
    const asset = await inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    const icon = await inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('antwortet unter /api weiterhin mit JSON-404 und lässt die API unberührt', async () => {
    await start(dir);
    const missing = await inject({ method: 'GET', url: '/api/gibtsnicht' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Nicht gefunden' });
    const health = await inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ status: 'ok' });
  });

  it('läuft ohne gebaute Oberfläche als reine API', async () => {
    await start(join(dir, 'fehlt'));
    expect((await inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    expect((await inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});
