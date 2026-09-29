import { createSession, SESSION_COOKIE } from '../../src/auth/sessions.js';
import type { DB } from '../../src/db.js';

/** Cookie-Header einer frischen Sitzung, standardmäßig für den lokalen Admin. */
export function sessionCookie(db: DB, userId?: number): string {
  const id = userId ?? (db.prepare("SELECT id FROM users WHERE kind = 'local'").get() as { id: number }).id;
  return `${SESSION_COOKIE}=${createSession(db, id)}`;
}
