import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { getMeta, setMeta, type DB } from '../db.js';

export const ROLES = ['listener', 'manager', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Admin darf alles, Manager die Inhalte, Listener nur hören. */
export function hasRole(role: Role | null | undefined, needed: Role): boolean {
  return role != null && ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

export const LOCAL_ADMIN = 'admin';

export interface User {
  id: number;
  kind: 'local' | 'oidc';
  username: string | null;
  name: string;
  email: string | null;
  role: Role | null;
  groups: string[];
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface UserRow {
  id: number;
  kind: 'local' | 'oidc';
  username: string | null;
  name: string;
  email: string | null;
  role: Role | null;
  groups: string;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

const USER_COLUMNS = 'id, kind, username, name, email, role, groups, disabled, created_at, last_login_at';

function toUser(row: UserRow): User {
  return {
    id: row.id,
    kind: row.kind,
    username: row.username,
    name: row.name,
    email: row.email,
    role: row.role,
    groups: JSON.parse(row.groups) as string[],
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function getUser(db: DB, id: number): User | undefined {
  const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  return row && toUser(row);
}

/** Lokaler Admin zuerst, dann nach Name. */
export function listUsers(db: DB): User[] {
  const rows = db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY kind = 'oidc', name COLLATE NOCASE, id`).all() as UserRow[];
  return rows.map(toUser);
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- Passwörter ----------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = (stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) {
    // Gleich lange rechnen wie bei einem echten Vergleich, damit die Antwortzeit nichts verrät.
    await derive(password, randomBytes(16), SCRYPT);
    return false;
  }
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), { ...SCRYPT, N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const MIN_PASSWORD_LENGTH = 10;

// ---------- Lokaler Admin ----------

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

// Hash des zuletzt aus ADMIN_PASSWORD übernommenen Passworts, um Änderungen in der .env zu erkennen.
const ENV_PASSWORD_META = 'adminEnvPassword';

/**
 * Legt beim Start den lokalen Admin an und hält sein Passwort mit ADMIN_PASSWORD abgestimmt:
 * Ein neuer oder geänderter Wert in der .env gilt nach dem Neustart. Solange er gleich bleibt,
 * bleibt ein in der Verwaltung geändertes Passwort erhalten. Ohne ADMIN_PASSWORD wird beim ersten
 * Start eines erzeugt; RESET_ADMIN_PASSWORD erzwingt ein neues. Ein erzeugtes Passwort landet in
 * `passwordFile` (nur für den Container-Benutzer lesbar) statt im Log, das oft an zentrale Systeme geht;
 * ohne Datei (Tests, Datenbank im Speicher) im Log.
 */
export async function ensureLocalAdmin(
  db: DB,
  options: { password?: string; reset?: boolean; passwordFile?: string },
  log: Logger,
): Promise<void> {
  const existing = db.prepare("SELECT id FROM users WHERE kind = 'local' AND username = ?").get(LOCAL_ADMIN) as
    | { id: number }
    | undefined;
  const fromEnv = options.password;
  const applied = getMeta(db, ENV_PASSWORD_META);
  const envChanged = fromEnv !== undefined && !(applied && (await verifyPassword(fromEnv, applied)));

  if (existing && !options.reset && !envChanged) {
    log.info(
      { username: LOCAL_ADMIN },
      fromEnv
        ? 'Lokaler Admin: ADMIN_PASSWORD unverändert, es gilt das zuletzt gesetzte Passwort'
        : 'Lokaler Admin vorhanden; zum Zurücksetzen ADMIN_PASSWORD ändern oder RESET_ADMIN_PASSWORD=true setzen',
    );
    return;
  }

  const password = fromEnv ?? randomBytes(12).toString('base64url');
  const hash = await hashPassword(password);
  db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?').run(hash, existing.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    } else {
      db.prepare(
        "INSERT INTO users (kind, username, password_hash, name, role, created_at) VALUES ('local', ?, ?, 'Administrator', 'admin', ?)",
      ).run(LOCAL_ADMIN, hash, Date.now());
    }
    if (fromEnv !== undefined) setMeta(db, ENV_PASSWORD_META, hash);
  })();

  const action = existing ? 'Passwort gesetzt' : 'angelegt';
  if (fromEnv === undefined && options.passwordFile) {
    writeFileSync(
      options.passwordFile,
      `Startpasswort des lokalen Admins "${LOCAL_ADMIN}" (gilt, bis es in der Verwaltung geändert wird):\n${password}\n`,
      { mode: 0o600 },
    );
    log.warn(
      { username: LOCAL_ADMIN, file: options.passwordFile },
      `Lokaler Admin ${action}. Das Passwort steht in der Datei; bitte damit anmelden, es in der Verwaltung ändern und die Datei löschen.`,
    );
  } else if (fromEnv === undefined) {
    log.warn(
      { username: LOCAL_ADMIN, password },
      `Lokaler Admin ${action}. Bitte mit diesem Passwort anmelden und es in der Verwaltung ändern.`,
    );
  } else {
    // Ein früher erzeugtes Startpasswort gilt nicht mehr.
    if (options.passwordFile) rmSync(options.passwordFile, { force: true });
    log.info({ username: LOCAL_ADMIN }, `Lokaler Admin ${action}, Passwort aus ADMIN_PASSWORD`);
  }
}

export async function checkLocalLogin(db: DB, username: string, password: string): Promise<User | undefined> {
  const row = db
    .prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE kind = 'local' AND username = ?`)
    .get(username.trim().toLowerCase()) as (UserRow & { password_hash: string | null }) | undefined;
  const ok = await verifyPassword(password, row?.password_hash ?? null);
  if (!row || !ok || row.disabled) return undefined;
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id);
  return toUser(row);
}

export async function changePassword(db: DB, userId: number, current: string, next: string, keepSession: string): Promise<void> {
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ? AND kind = 'local'").get(userId) as
    | { password_hash: string | null }
    | undefined;
  if (!row) throw new AuthError(400, 'Nur der lokale Admin hat ein Passwort');
  if (!(await verifyPassword(current, row.password_hash))) throw new AuthError(400, 'Das bisherige Passwort stimmt nicht');
  if (next.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(400, `Das neue Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen`);
  }
  const hash = await hashPassword(next);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    // Andere Geräte abmelden, die aktuelle Sitzung bleibt.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, keepSession);
  })();
}

// ---------- OIDC-Benutzer und Gruppen ----------

export interface Group {
  name: string;
  enabled: boolean;
  role: Role;
  lastSeenAt: number | null;
  userCount: number;
}

export function listGroups(db: DB): Group[] {
  const rows = db
    .prepare(
      `SELECT g.name, g.enabled, g.role, g.last_seen_at,
         (SELECT count(*) FROM users u, json_each(u.groups) j WHERE u.kind = 'oidc' AND j.value = g.name) AS user_count
       FROM oidc_groups g ORDER BY g.enabled DESC, g.name COLLATE NOCASE`,
    )
    .all() as Array<{ name: string; enabled: number; role: Role; last_seen_at: number | null; user_count: number }>;
  return rows.map((r) => ({
    name: r.name,
    enabled: r.enabled === 1,
    role: r.role,
    lastSeenAt: r.last_seen_at,
    userCount: r.user_count,
  }));
}

/** Höchste Rolle aus den freigeschalteten Gruppen; null ohne passende Gruppe. */
function roleFor(db: DB, groups: string[]): Role | null {
  if (!groups.length) return null;
  const enabled = db
    .prepare(`SELECT role FROM oidc_groups WHERE enabled = 1 AND name IN (${groups.map(() => '?').join(',')})`)
    .all(...groups) as Array<{ role: Role }>;
  let best: Role | null = null;
  for (const { role } of enabled) if (!best || hasRole(role, best)) best = role;
  return best;
}

/** Nach jeder Änderung an Gruppen gelten die neuen Rollen sofort, nicht erst beim nächsten Login. */
export function recomputeRoles(db: DB): void {
  const users = db.prepare("SELECT id, groups FROM users WHERE kind = 'oidc'").all() as Array<{ id: number; groups: string }>;
  const update = db.prepare('UPDATE users SET role = ? WHERE id = ?');
  db.transaction(() => {
    for (const user of users) update.run(roleFor(db, JSON.parse(user.groups) as string[]), user.id);
  })();
}

export function saveGroup(db: DB, name: string, fields: { enabled?: boolean; role?: Role }): void {
  const trimmed = name.trim();
  if (!trimmed) throw new AuthError(400, 'Gruppenname fehlt');
  db.transaction(() => {
    db.prepare('INSERT INTO oidc_groups (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(trimmed);
    if (fields.enabled !== undefined)
      db.prepare('UPDATE oidc_groups SET enabled = ? WHERE name = ?').run(fields.enabled ? 1 : 0, trimmed);
    if (fields.role !== undefined) db.prepare('UPDATE oidc_groups SET role = ? WHERE name = ?').run(fields.role, trimmed);
    recomputeRoles(db);
  })();
}

export function deleteGroup(db: DB, name: string): void {
  db.transaction(() => {
    if (db.prepare('DELETE FROM oidc_groups WHERE name = ?').run(name).changes === 0) {
      throw new AuthError(404, 'Gruppe nicht gefunden');
    }
    recomputeRoles(db);
  })();
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  name: string;
  email: string | null;
  groups: string[];
  /** Namen aller Claims, die der Identity Provider geliefert hat (für die Fehlersuche) */
  claimNames?: string[];
}

/** Letzte abgewiesene OIDC-Anmeldung, damit der Admin sieht, welche Gruppen ankamen */
export interface DeniedLogin {
  at: number;
  name: string;
  email: string | null;
  reason: 'no-group' | 'disabled';
  groups: string[];
  groupsClaim: string;
  claimNames: string[];
}

const DENIED_LOGIN_KEY = 'oidcLastDenied';

export function recordDeniedLogin(db: DB, login: DeniedLogin): void {
  setMeta(db, DENIED_LOGIN_KEY, JSON.stringify(login));
}

export function lastDeniedLogin(db: DB): DeniedLogin | null {
  const raw = getMeta(db, DENIED_LOGIN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeniedLogin;
  } catch {
    return null;
  }
}

export type OidcLoginResult = { user: User } | { denied: 'no-group' | 'disabled' };

/**
 * Anmeldung über OIDC: Gruppen merken (damit der Admin sie freischalten kann), Rolle bestimmen,
 * Benutzer anlegen oder aktualisieren. Wer in keiner freigeschalteten Gruppe ist, wird nicht angelegt.
 */
export function upsertOidcUser(db: DB, identity: OidcIdentity): OidcLoginResult {
  return db.transaction((): OidcLoginResult => {
    const now = Date.now();
    const seen = db.prepare(
      'INSERT INTO oidc_groups (name, last_seen_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_seen_at = excluded.last_seen_at',
    );
    for (const group of identity.groups) seen.run(group, now);

    const role = roleFor(db, identity.groups);
    const existing = db
      .prepare("SELECT id, disabled FROM users WHERE kind = 'oidc' AND issuer = ? AND subject = ?")
      .get(identity.issuer, identity.subject) as { id: number; disabled: number } | undefined;
    const groups = JSON.stringify(identity.groups);

    if (existing) {
      db.prepare('UPDATE users SET name = ?, email = ?, groups = ?, role = ?, last_login_at = ? WHERE id = ?').run(
        identity.name,
        identity.email,
        groups,
        role,
        now,
        existing.id,
      );
      if (existing.disabled) return { denied: 'disabled' };
      if (!role) return { denied: 'no-group' };
      return { user: getUser(db, existing.id)! };
    }
    if (!role) return { denied: 'no-group' };
    const id = db
      .prepare(
        "INSERT INTO users (kind, issuer, subject, name, email, groups, role, created_at, last_login_at) VALUES ('oidc', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(identity.issuer, identity.subject, identity.name, identity.email, groups, role, now, now).lastInsertRowid;
    return { user: getUser(db, Number(id))! };
  })();
}

export function setUserDisabled(db: DB, id: number, disabled: boolean): void {
  const user = getUser(db, id);
  if (!user) throw new AuthError(404, 'Benutzer nicht gefunden');
  if (user.kind === 'local') throw new AuthError(400, 'Der lokale Admin kann nicht gesperrt werden');
  db.transaction(() => {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    if (disabled) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      // Offline gespeicherte Titel dieses Benutzers werden damit unbrauchbar.
      db.prepare('UPDATE users SET offline_key = NULL WHERE id = ?').run(id);
    }
  })();
}

/** Entfernt einen OIDC-Benutzer; meldet er sich wieder an und ist in einer freigeschalteten Gruppe, entsteht er neu. */
export function deleteUser(db: DB, id: number): void {
  const user = getUser(db, id);
  if (!user) throw new AuthError(404, 'Benutzer nicht gefunden');
  if (user.kind === 'local') throw new AuthError(400, 'Der lokale Admin kann nicht gelöscht werden');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

/** Hat der Benutzer die Einführung schon gesehen? Liegt am Benutzer, damit sie auf keinem Gerät wiederkommt. */
export function isOnboarded(db: DB, userId: number): boolean {
  const row = db.prepare('SELECT onboarded_at FROM users WHERE id = ?').get(userId) as { onboarded_at: number | null } | undefined;
  return Boolean(row?.onboarded_at);
}

export function markOnboarded(db: DB, userId: number): void {
  db.prepare('UPDATE users SET onboarded_at = coalesce(onboarded_at, ?) WHERE id = ?').run(Date.now(), userId);
}
