import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import type { Role } from './users.js';

export const SESSION_COOKIE = 'gemeinde_session';
/** Wer die App mindestens alle 30 Tage öffnet, bleibt angemeldet. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Ablauf höchstens einmal pro Stunde verlängern, sonst schriebe jeder Stream-Abruf in die Datenbank.
const TOUCH_AFTER_MS = 60 * 60 * 1000;

export interface SessionUser {
  id: number;
  kind: 'local' | 'oidc';
  name: string;
  role: Role;
  /** Hash der Sitzungs-ID, z. B. um beim Passwortwechsel diese Sitzung zu behalten */
  sessionHash: string;
}

export const hashSessionId = (id: string) => createHash('sha256').update(id).digest('base64url');

export function createSession(db: DB, userId: number): string {
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    hashSessionId(id),
    userId,
    now,
    now,
    now + SESSION_TTL_MS,
  );
  // Gelegentlich aufräumen, ohne eigenen Timer.
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return id;
}

/** Benutzer zur Sitzung, sofern sie gültig ist und der Benutzer (noch) Zugang hat. */
export function sessionUser(db: DB, id: string | undefined): SessionUser | undefined {
  if (!id) return undefined;
  const hash = hashSessionId(id);
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT u.id, u.kind, u.name, u.role, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ? AND u.disabled = 0 AND u.role IS NOT NULL`,
    )
    .get(hash, now) as { id: number; kind: 'local' | 'oidc'; name: string; role: Role; last_seen_at: number } | undefined;
  if (!row) return undefined;
  if (now - row.last_seen_at > TOUCH_AFTER_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(now, now + SESSION_TTL_MS, hash);
  }
  return { id: row.id, kind: row.kind, name: row.name, role: row.role, sessionHash: hash };
}

export function deleteSession(db: DB, id: string | undefined): void {
  if (id) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashSessionId(id));
}
