import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requiredRole } from '../src/api/auth.js';
import { buildApp, type AppContext } from '../src/app.js';
import { claimValues } from '../src/auth/oidc.js';
import { changePassword, checkLocalLogin, ensureLocalAdmin, hashPassword, verifyPassword } from '../src/auth/users.js';
import { openDatabase } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { mp3 } from './helpers/audio.js';
import { CLIENT_ID, CLIENT_SECRET, FakeIdp } from './helpers/fakeIdp.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';

const ADMIN_PASSWORD = 'start-passwort-123';

let cloud: FakeNextcloud;
let idp: FakeIdp;
let ctx: AppContext;

async function start(env: Record<string, string> = {}) {
  ctx = await buildApp(
    loadConfig({
      NEXTCLOUD_URL: cloud.url,
      NEXTCLOUD_USER: USER,
      NEXTCLOUD_PASSWORD: PASSWORD,
      NEXTCLOUD_MUSIC_PATH: '/Musik',
      DATABASE_PATH: ':memory:',
      ADMIN_PASSWORD,
      PUBLIC_URL: 'http://localhost',
      ...env,
    }),
    { logger: false },
  );
  await ctx.scanner.scan();
}

const sessionOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const value = res.cookies.find((c) => c.name === 'gemeinde_session')?.value;
  return value ? `gemeinde_session=${value}` : undefined;
};

async function localLogin(password = ADMIN_PASSWORD) {
  return ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password } });
}

async function adminCookie(): Promise<string> {
  const res = await localLogin();
  expect(res.statusCode, res.body).toBe(200);
  return sessionOf(res)!;
}

async function as(cookie: string | undefined, options: InjectOptions) {
  return ctx.app.inject({ ...options, headers: { ...(cookie ? { cookie } : {}), ...options.headers } });
}

async function configureOidc(cookie: string, extra: Record<string, unknown> = {}) {
  const res = await as(cookie, {
    method: 'PUT',
    url: '/api/admin/oidc',
    payload: { enabled: true, issuer: idp.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, ...extra },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Kompletter OIDC-Ablauf wie im Browser; liefert das Ziel der letzten Weiterleitung und ggf. das Sitzungs-Cookie. */
async function oidcLogin(returnTo = '/alben') {
  const begin = await ctx.app.inject({ method: 'GET', url: `/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}` });
  expect(begin.statusCode, begin.body).toBe(302);
  const state = begin.cookies.find((c) => c.name === 'gemeinde_oidc')!;
  const atIdp = await fetch(begin.headers.location as string, { redirect: 'manual' });
  expect(atIdp.status).toBe(302);
  const callback = new URL(atIdp.headers.get('location')!);
  const done = await ctx.app.inject({
    method: 'GET',
    url: callback.pathname + callback.search,
    headers: { cookie: `gemeinde_oidc=${state.value}` },
  });
  expect(done.statusCode, done.body).toBe(302);
  return { location: done.headers.location as string, cookie: sessionOf(done) };
}

async function setGroup(cookie: string, name: string, body: object) {
  const res = await as(cookie, { method: 'PUT', url: `/api/admin/groups/${encodeURIComponent(name)}`, payload: body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as Array<{ name: string; enabled: boolean; role: string; userCount: number }>;
}

beforeEach(async () => {
  cloud = new FakeNextcloud('/Musik');
  await cloud.start();
  cloud.put('Chor/Advent/01.mp3', mp3({ title: 'Eins', artist: 'Chor', album: 'Advent', track: 1 }));
  idp = new FakeIdp();
  await idp.start();
});

afterEach(async () => {
  await ctx?.app.close();
  await cloud.stop();
  await idp.stop();
});

describe('Rollen', () => {
  it('ordnet jeder Route die nötige Rolle zu', () => {
    expect(requiredRole('GET', '/api/health')).toBeUndefined();
    expect(requiredRole('POST', '/api/auth/login')).toBeUndefined();
    expect(requiredRole('GET', '/alben')).toBeUndefined();
    expect(requiredRole('GET', '/api/albums')).toBe('listener');
    expect(requiredRole('GET', '/api/scan')).toBe('listener');
    expect(requiredRole('POST', '/api/scan')).toBe('manager');
    expect(requiredRole('PATCH', '/api/admin/albums/3')).toBe('manager');
    expect(requiredRole('GET', '/api/admin/users')).toBe('admin');
    expect(requiredRole('PUT', '/api/admin/groups/musik')).toBe('admin');
    expect(requiredRole('POST', '/api/admin/oidc/test')).toBe('admin');
    // Kein Schlupfloch über ähnliche Namen
    expect(requiredRole('GET', '/api/admin/usersettings')).toBe('manager');
  });
});

describe('Lokaler Admin', () => {
  it('meldet sich mit Passwort an und wieder ab', async () => {
    await start();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/albums' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toEqual({ user: null, oidc: null, branding: { name: 'Gemeinde.App', welcome: '' } });

    expect((await localLogin('falsch')).statusCode).toBe(401);
    const res = await localLogin();
    expect(res.statusCode).toBe(200);
    const session = res.cookies.find((c) => c.name === 'gemeinde_session')!;
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    const cookie = sessionOf(res)!;

    expect((await as(cookie, { method: 'GET', url: '/api/auth/status' })).json()).toMatchObject({
      user: { name: 'Administrator', role: 'admin', kind: 'local' },
    });
    expect((await as(cookie, { method: 'GET', url: '/api/albums' })).statusCode).toBe(200);
    expect((await as(cookie, { method: 'GET', url: '/api/admin/users' })).statusCode).toBe(200);

    expect((await as(cookie, { method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(204);
    expect((await as(cookie, { method: 'GET', url: '/api/albums' })).statusCode).toBe(401);
  });

  it('ändert das Passwort und meldet andere Sitzungen ab', async () => {
    await start();
    const current = await adminCookie();
    const other = await adminCookie();
    const change = (payload: object) => as(current, { method: 'POST', url: '/api/auth/password', payload });

    expect((await change({ current: 'falsch', next: 'ganz-neues-passwort' })).statusCode).toBe(400);
    expect((await change({ current: ADMIN_PASSWORD, next: 'kurz' })).statusCode).toBe(400);
    expect((await change({ current: ADMIN_PASSWORD, next: 'ganz-neues-passwort' })).statusCode).toBe(204);

    expect((await as(current, { method: 'GET', url: '/api/albums' })).statusCode).toBe(200);
    expect((await as(other, { method: 'GET', url: '/api/albums' })).statusCode).toBe(401);
    expect((await localLogin()).statusCode).toBe(401);
    expect((await localLogin('ganz-neues-passwort')).statusCode).toBe(200);
  });

  it('bremst nach vielen Fehlversuchen', async () => {
    await start();
    for (let i = 0; i < 10; i++) expect((await localLogin('falsch')).statusCode).toBe(401);
    expect((await localLogin()).statusCode).toBe(429);
  });

  it('glaubt X-Forwarded-For nur einem Proxy aus dem eigenen Netz', async () => {
    await start();
    const attempt = (remoteAddress: string, forwarded: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress,
        headers: { 'x-forwarded-for': forwarded },
        payload: { username: 'admin', password: 'falsch' },
      });
    // Direkt aus dem Internet: Die gefälschte IP zählt nicht, nach 10 Versuchen ist Schluss.
    for (let i = 0; i < 10; i++) expect((await attempt('203.0.113.9', `198.51.100.${i}`)).statusCode).toBe(401);
    expect((await attempt('203.0.113.9', '198.51.100.99')).statusCode).toBe(429);
    // Über den Reverse Proxy im Docker-Netz: jede echte Client-IP für sich.
    expect((await attempt('172.18.0.2', '198.51.100.7')).statusCode).toBe(401);
  });

  it('bremst Raten von vielen IPs über den Benutzernamen und lässt nur wenige Prüfungen gleichzeitig zu', async () => {
    await start({ TRUST_PROXY: 'false' });
    const from = (ip: string, password = 'falsch') =>
      ctx.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: { username: 'admin', password } });
    for (let i = 0; i < 100; i++) expect((await from(`198.51.100.${i}`)).statusCode).toBe(401);
    expect((await from('198.51.100.200', ADMIN_PASSWORD)).statusCode).toBe(429);

    await ctx.app.close();
    await start();
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => from(`192.0.2.${i}`)));
    const codes = burst.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes.filter((c) => c === 401).length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('lässt sich nicht mit kodierten Pfaden umgehen', async () => {
    await start();
    const admin = await adminCookie();
    await configureOidc(admin);
    await setGroup(admin, 'musik', { enabled: true });
    const { cookie } = await oidcLogin();
    for (const url of ['/api/%61dmin/users', '/api/admin/%75sers', '/api/%61dmin/albums']) {
      expect((await as(cookie, { method: 'GET', url })).statusCode, url).toBe(403);
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/%61lbums' })).statusCode).toBe(401);
  });

  it('lehnt Änderungen von fremden Seiten ab, auch wenn PUBLIC_URL nicht zur Adresse passt', async () => {
    // PUBLIC_URL wie im Beispiel, aufgerufen wird die App aber direkt über den Server
    await start({ PUBLIC_URL: 'https://musik.gemeinde.de' });
    const cookie = await adminCookie();
    const post = (headers: Record<string, string>) =>
      as(cookie, { method: 'POST', url: '/api/admin/albums', payload: { title: 'X' }, headers });

    expect((await post({ origin: 'https://boese.example' })).statusCode).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site', origin: 'http://localhost' })).statusCode).toBe(403);
    expect((await post({ 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);

    // Browser auf http://server:3000 hinter keinem Proxy
    expect((await post({ host: 'server:3000', origin: 'http://server:3000' })).statusCode).toBe(201);
    // Proxy mit TLS davor, App sieht http
    expect((await post({ host: 'musik.gemeinde.de', origin: 'https://musik.gemeinde.de' })).statusCode).toBe(201);
    // Proxy, der den Host umschreibt: PUBLIC_URL passt
    expect((await post({ host: '127.0.0.1:3000', origin: 'https://musik.gemeinde.de' })).statusCode).toBe(201);
    // Moderne Browser melden die Herkunft selbst
    expect((await post({ 'sec-fetch-site': 'same-origin', origin: 'http://anders:8080' })).statusCode).toBe(201);
    // Ohne Origin (z. B. curl mit Cookie)
    expect((await post({})).statusCode).toBe(201);
  });

  it('übernimmt ADMIN_PASSWORD auch nachträglich, sobald es sich ändert', async () => {
    const db = openDatabase(':memory:');
    const logged: Array<Record<string, unknown>> = [];
    const log = { info: (obj: object) => logged.push({ ...obj }), warn: (obj: object) => logged.push({ ...obj }) };
    const canLogin = async (password: string) => Boolean(await checkLocalLogin(db, 'admin', password));

    // Erster Start ohne ADMIN_PASSWORD: erzeugtes Passwort im Log
    await ensureLocalAdmin(db, {}, log);
    const generated = logged[0]!.password as string;
    expect(generated.length).toBeGreaterThanOrEqual(16);
    expect(await canLogin(generated)).toBe(true);
    await ensureLocalAdmin(db, {}, log);
    expect(await canLogin(generated)).toBe(true);

    // ADMIN_PASSWORD später in die .env geschrieben: gilt nach dem Neustart
    await ensureLocalAdmin(db, { password: 'aus-der-env-1' }, log);
    expect(await canLogin('aus-der-env-1')).toBe(true);
    expect(await canLogin(generated)).toBe(false);

    // In der Verwaltung geändert, .env unverändert: das neue Passwort bleibt
    const { id } = (await checkLocalLogin(db, 'admin', 'aus-der-env-1'))!;
    await changePassword(db, id, 'aus-der-env-1', 'in-der-verwaltung', '');
    await ensureLocalAdmin(db, { password: 'aus-der-env-1' }, log);
    expect(await canLogin('in-der-verwaltung')).toBe(true);

    // Wert in der .env geändert: gilt wieder
    await ensureLocalAdmin(db, { password: 'aus-der-env-2' }, log);
    expect(await canLogin('aus-der-env-2')).toBe(true);

    // RESET_ADMIN_PASSWORD ohne ADMIN_PASSWORD erzeugt ein neues
    await ensureLocalAdmin(db, { reset: true }, log);
    expect(await canLogin(logged.at(-1)!.password as string)).toBe(true);
    expect(await canLogin('aus-der-env-2')).toBe(false);
    db.close();
  });

  it('schreibt ein erzeugtes Passwort in eine Datei statt ins Log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemeinde-admin-'));
    const file = join(dir, 'admin-password.txt');
    const db = openDatabase(':memory:');
    const logged: Array<Record<string, unknown>> = [];
    const log = { info: (obj: object) => logged.push({ ...obj }), warn: (obj: object) => logged.push({ ...obj }) };
    await ensureLocalAdmin(db, { passwordFile: file }, log);
    expect(logged.some((entry) => 'password' in entry)).toBe(false);
    const password = readFileSync(file, 'utf8').trim().split('\n').at(-1)!;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await checkLocalLogin(db, 'admin', password)).toBeDefined();
    // Kommt später ADMIN_PASSWORD, verschwindet die veraltete Datei.
    await ensureLocalAdmin(db, { password: 'aus-der-env-3', passwordFile: file }, log);
    expect(existsSync(file)).toBe(false);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignoriert Leerzeichen und Zeilenenden um ADMIN_PASSWORD', () => {
    const env = { NEXTCLOUD_URL: 'https://c', NEXTCLOUD_USER: 'u', NEXTCLOUD_PASSWORD: 'p', NEXTCLOUD_MUSIC_PATH: '/M' };
    expect(loadConfig({ ...env, ADMIN_PASSWORD: ' geheim-passwort\r' }).adminPassword).toBe('geheim-passwort');
    expect(loadConfig({ ...env, ADMIN_PASSWORD: '  ' }).adminPassword).toBeUndefined();
  });

  it('speichert Passwörter nur als scrypt-Hash', async () => {
    const hash = await hashPassword('geheim-geheim');
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain('geheim');
    expect(await verifyPassword('geheim-geheim', hash)).toBe(true);
    expect(await verifyPassword('anders', hash)).toBe(false);
    expect(await verifyPassword('egal', null)).toBe(false);
  });
});

describe('OIDC', () => {
  it('ist ohne Einrichtung aus', async () => {
    await start();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?anmeldung=fehler');
  });

  it('legt nur Benutzer aus freigeschalteten Gruppen an und merkt sich gesehene Gruppen', async () => {
    await start();
    const admin = await adminCookie();
    await configureOidc(admin);
    const settings = (await as(admin, { method: 'GET', url: '/api/admin/oidc' })).json();
    expect(settings).toMatchObject({ enabled: true, hasSecret: true, redirectUri: 'http://localhost/api/auth/oidc/callback' });
    expect(settings.clientSecret).toBeUndefined();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/status' })).json().oidc).toEqual({
      label: 'Mit Gemeinde-Konto anmelden',
    });

    idp.user = { sub: 'anna', name: 'Anna', email: 'anna@example.org', groups: ['musik', 'jugend'] };
    const denied = await oidcLogin();
    expect(denied).toEqual({ location: '/?anmeldung=keine-gruppe', cookie: undefined });
    expect((await as(admin, { method: 'GET', url: '/api/admin/users' })).json().items).toHaveLength(1);
    const seen = (await as(admin, { method: 'GET', url: '/api/admin/groups' })).json().items;
    expect(seen.map((g: { name: string }) => g.name).sort()).toEqual(['jugend', 'musik']);

    await setGroup(admin, 'musik', { enabled: true });
    const ok = await oidcLogin('/album/1');
    expect(ok.location).toBe('/album/1');
    expect((await as(ok.cookie, { method: 'GET', url: '/api/auth/status' })).json().user).toMatchObject({
      name: 'Anna',
      role: 'listener',
      kind: 'oidc',
    });
    const users = (await as(admin, { method: 'GET', url: '/api/admin/users' })).json().items;
    expect(users[1]).toMatchObject({
      kind: 'oidc',
      name: 'Anna',
      email: 'anna@example.org',
      role: 'listener',
      groups: ['musik', 'jugend'],
    });
  });

  it('gibt Listenern nur den Player, Managern die Inhalte und Admins alles', async () => {
    await start();
    const admin = await adminCookie();
    await configureOidc(admin);
    await setGroup(admin, 'musik', { enabled: true, role: 'listener' });
    await setGroup(admin, 'technik', { enabled: true, role: 'manager' });

    idp.user = { sub: 'lena', name: 'Lena', groups: ['musik'] };
    const listener = (await oidcLogin()).cookie;
    idp.user = { sub: 'max', name: 'Max', groups: ['musik', 'technik'] };
    const manager = (await oidcLogin()).cookie;

    const status = async (cookie: string | undefined, method: InjectOptions['method'], url: string, payload?: object) =>
      (await as(cookie, { method, url, payload })).statusCode;

    expect(await status(listener, 'GET', '/api/albums')).toBe(200);
    expect(await status(listener, 'GET', '/api/admin/albums')).toBe(403);
    expect(await status(listener, 'POST', '/api/scan')).toBe(403);

    expect(await status(manager, 'GET', '/api/admin/albums')).toBe(200);
    expect(await status(manager, 'POST', '/api/admin/albums', { title: 'Predigten' })).toBe(201);
    expect(await status(manager, 'POST', '/api/scan')).toBe(202);
    await ctx.scanner.scan();
    expect(await status(manager, 'GET', '/api/admin/users')).toBe(403);
    expect(await status(manager, 'PUT', '/api/admin/groups/technik', { role: 'admin' })).toBe(403);
    expect(await status(manager, 'PUT', '/api/admin/oidc', { enabled: false })).toBe(403);

    // Rolle folgt sofort den Gruppeneinstellungen, ohne neue Anmeldung
    await setGroup(admin, 'technik', { role: 'admin' });
    expect(await status(manager, 'GET', '/api/admin/users')).toBe(200);
    await setGroup(admin, 'technik', { enabled: false });
    expect(await status(manager, 'GET', '/api/admin/albums')).toBe(403);
    await setGroup(admin, 'musik', { enabled: false });
    expect(await status(manager, 'GET', '/api/albums')).toBe(401);
    expect(await status(listener, 'GET', '/api/albums')).toBe(401);
  });

  it('sperrt und löscht Benutzer', async () => {
    await start();
    const admin = await adminCookie();
    await configureOidc(admin);
    await setGroup(admin, 'musik', { enabled: true });
    const { cookie } = await oidcLogin();
    const users = (await as(admin, { method: 'GET', url: '/api/admin/users' })).json().items;
    const [local, anna] = users;

    expect(
      (await as(admin, { method: 'PATCH', url: `/api/admin/users/${local.id}`, payload: { disabled: true } })).statusCode,
    ).toBe(400);
    expect((await as(admin, { method: 'DELETE', url: `/api/admin/users/${local.id}` })).statusCode).toBe(400);

    expect(
      (await as(admin, { method: 'PATCH', url: `/api/admin/users/${anna.id}`, payload: { disabled: true } })).statusCode,
    ).toBe(200);
    expect((await as(cookie, { method: 'GET', url: '/api/albums' })).statusCode).toBe(401);
    expect((await oidcLogin()).location).toBe('/?anmeldung=gesperrt');

    expect((await as(admin, { method: 'DELETE', url: `/api/admin/users/${anna.id}` })).statusCode).toBe(204);
    const again = await oidcLogin();
    expect(again.location).toBe('/alben');
    expect((await as(again.cookie, { method: 'GET', url: '/api/albums' })).statusCode).toBe(200);
  });

  it('liest Gruppen auch aus Userinfo und verschachtelten Claims', async () => {
    await start();
    const admin = await adminCookie();
    await configureOidc(admin, { groupsClaim: 'realm_access.roles' });
    await setGroup(admin, 'gemeinde', { enabled: true });
    idp.user = { sub: 'kai', preferred_username: 'kai' };
    idp.userinfo = { name: 'Kai Muster', realm_access: { roles: ['gemeinde', 'offline_access'] } };
    const { cookie } = await oidcLogin();
    expect((await as(cookie, { method: 'GET', url: '/api/auth/status' })).json().user).toMatchObject({
      name: 'Kai Muster',
      role: 'listener',
    });

    expect(claimValues({ groups: 'eine' }, 'groups')).toEqual(['eine']);
    expect(claimValues({ a: { b: ['x', 'x', 3, ' y '] } }, 'a.b')).toEqual(['x', 'y']);
    expect(claimValues({}, 'groups')).toBeUndefined();
  });

  it('weist Rückkehr ohne passendes Cookie oder mit fremdem Ziel ab', async () => {
    await start();
    const admin = await adminCookie();
    await configureOidc(admin);
    await setGroup(admin, 'musik', { enabled: true });

    const begin = await ctx.app.inject({ method: 'GET', url: '/api/auth/oidc/start?returnTo=//boese.example' });
    const atIdp = await fetch(begin.headers.location as string, { redirect: 'manual' });
    const callback = new URL(atIdp.headers.get('location')!);
    // Ein anderer Browser (ohne das state-Cookie) kann die Anmeldung nicht abschließen.
    const stolen = await ctx.app.inject({ method: 'GET', url: callback.pathname + callback.search });
    expect(stolen.headers.location).toBe('/?anmeldung=fehler');
    expect(sessionOf(stolen)).toBeUndefined();

    expect((await oidcLogin('//boese.example')).location).toBe('/');
    expect((await oidcLogin('https://boese.example')).location).toBe('/');
  });

  it('beendet OIDC-Sitzungen spätestens 30 Tage nach der Anmeldung, auch bei täglicher Nutzung', async () => {
    await start();
    const admin = await adminCookie();
    await configureOidc(admin);
    await setGroup(admin, 'musik', { enabled: true, role: 'listener' });
    idp.user = { sub: 'anna', name: 'Anna', email: 'anna@example.org', groups: ['musik'] };
    const { cookie } = await oidcLogin();
    expect((await as(cookie, { method: 'GET', url: '/api/albums' })).statusCode).toBe(200);

    const age = (days: number) => ctx.db.prepare('UPDATE sessions SET created_at = ?').run(Date.now() - days * 24 * 60 * 60 * 1000);
    age(29);
    expect((await as(cookie, { method: 'GET', url: '/api/albums' })).statusCode).toBe(200);
    age(31);
    expect((await as(cookie, { method: 'GET', url: '/api/albums' })).statusCode).toBe(401);
    // Der lokale Admin hat keinen Identity Provider, seine Sitzung läuft weiter.
    expect((await as(admin, { method: 'GET', url: '/api/albums' })).statusCode).toBe(200);
  });

  it('lässt sich ohne PUBLIC_URL nicht einschalten', async () => {
    await start({ PUBLIC_URL: '' });
    const admin = await adminCookie();
    const res = await as(admin, {
      method: 'PUT',
      url: '/api/admin/oidc',
      payload: { enabled: true, issuer: idp.url, clientId: CLIENT_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('PUBLIC_URL');
    expect((await as(admin, { method: 'GET', url: '/api/admin/oidc' })).json()).toMatchObject({ enabled: false, publicUrlMissing: true });
  });

  it('verträgt Issuer mit und ohne Schrägstrich am Ende (Authentik)', async () => {
    await start();
    const admin = await adminCookie();
    idp.issuerPath = '/application/o/gemeinde/';
    await setGroup(admin, 'musik', { enabled: true });
    const test = async (issuer: string) => {
      await configureOidc(admin, { issuer });
      return as(admin, { method: 'POST', url: '/api/admin/oidc/test' });
    };
    // Genau wie bei Authentik angezeigt
    expect((await test(`${idp.url}/application/o/gemeinde/`)).json()).toEqual({ issuer: idp.issuer });
    // Ohne Schrägstrich eingegeben: klappt trotzdem, auch die Anmeldung
    expect((await test(`${idp.url}/application/o/gemeinde`)).json()).toEqual({ issuer: idp.issuer });
    expect((await oidcLogin()).location).toBe('/alben');
    // Anbieter ohne Schrägstrich, Eingabe mit
    idp.issuerPath = '/realms/gemeinde';
    expect((await test(`${idp.url}/realms/gemeinde/`)).json()).toEqual({ issuer: idp.issuer });
    // Echte Abweichung (z. B. anderer Host): Fehlermeldung nennt beide Werte
    idp.issuerOverride = 'https://auth.example.org/realms/gemeinde';
    const failed = await test(`${idp.url}/realms/gemeinde`);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toContain('meldet: https://auth.example.org/realms/gemeinde');
  });

  it('prüft die Einstellungen', async () => {
    await start();
    const admin = await adminCookie();
    const put = (payload: object) => as(admin, { method: 'PUT', url: '/api/admin/oidc', payload });
    expect((await put({ enabled: true })).statusCode).toBe(400);
    expect((await put({ issuer: 'http://idp.example.org' })).statusCode).toBe(400);
    expect((await put({ issuer: 'kein link' })).statusCode).toBe(400);
    const saved = await put({ issuer: `${idp.url}/`, clientId: ' app ', clientSecret: 's', scopes: 'profile groups' });
    expect(saved.json()).toMatchObject({ issuer: `${idp.url}/`, clientId: 'app', scopes: 'openid profile groups', hasSecret: true });
    // Ohne clientSecret bleibt das gespeicherte erhalten, leer löscht es
    expect((await put({ label: 'Anmelden' })).json().hasSecret).toBe(true);
    expect((await put({ clientSecret: '' })).json().hasSecret).toBe(false);
    expect((await as(admin, { method: 'POST', url: '/api/admin/oidc/test' })).json()).toEqual({ issuer: idp.url });
  });
});
