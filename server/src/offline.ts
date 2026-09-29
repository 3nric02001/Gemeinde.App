import { createHash, randomBytes } from 'node:crypto';
import { getMeta, setMeta, type DB } from './db.js';

/**
 * Offline hören: Die App speichert Titel verschlüsselt im Browser. Den Schlüssel (AES-256) gibt es je
 * Benutzer nur von hier; ohne Kontakt zum Server verfallen die Kopien nach `days` Tagen.
 */
export interface OfflineSettings {
  enabled: boolean;
  /** So viele Tage ohne Verbindung zum Server bleiben Offline-Titel abspielbar */
  days: number;
}

export const DEFAULT_OFFLINE: OfflineSettings = { enabled: true, days: 30 };
export const MAX_OFFLINE_DAYS = 365;

export function getOfflineSettings(db: DB): OfflineSettings {
  try {
    const saved = JSON.parse(getMeta(db, 'offline') ?? '{}') as Partial<OfflineSettings>;
    const days = Number.isInteger(saved.days) && saved.days! >= 1 && saved.days! <= MAX_OFFLINE_DAYS ? saved.days! : DEFAULT_OFFLINE.days;
    return { enabled: saved.enabled ?? DEFAULT_OFFLINE.enabled, days };
  } catch {
    return DEFAULT_OFFLINE;
  }
}

/** Beim Abschalten werden alle Schlüssel verworfen: Vorhandene Offline-Kopien sind damit wertlos. */
export function saveOfflineSettings(db: DB, patch: Partial<OfflineSettings>): OfflineSettings {
  const next = { ...getOfflineSettings(db), ...patch };
  db.transaction(() => {
    setMeta(db, 'offline', JSON.stringify(next));
    if (!next.enabled) db.prepare('UPDATE users SET offline_key = NULL').run();
  })();
  return getOfflineSettings(db);
}

/** Schlüssel des Benutzers, beim ersten Abruf erzeugt. */
export function offlineKey(db: DB, userId: number): { key: string; keyId: string } {
  const row = db.prepare('SELECT offline_key FROM users WHERE id = ?').get(userId) as { offline_key: Buffer | null } | undefined;
  let key = row?.offline_key ?? null;
  if (!key) {
    key = randomBytes(32);
    db.prepare('UPDATE users SET offline_key = ? WHERE id = ?').run(key, userId);
  }
  // Kennung, an der die App merkt, dass der Schlüssel gewechselt hat (alte Kopien dann löschen).
  const keyId = createHash('sha256').update(key).digest('base64url').slice(0, 16);
  return { key: key.toString('base64url'), keyId };
}
