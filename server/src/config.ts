export interface NextcloudConfig {
  /** Basis-URL der Nextcloud, z. B. https://cloud.example.org */
  url: string;
  user: string;
  /** App-Passwort des Service-Accounts (nicht das Login-Passwort) */
  password: string;
  /**
   * Ordner innerhalb des Accounts, der gescannt wird, z. B. /Gemeinde/Medien/Musik.
   * Nur dieser Ordner und seine Unterordner landen in der Bibliothek; "/" wäre der ganze Account.
   */
  musicPath: string;
}

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  databasePath: string;
  adminToken: string | undefined;
  /** Ordner mit der gebauten Weboberfläche; fehlt er, liefert der Server nur die API aus */
  webDir: string;
  nextcloud: NextcloudConfig;
  /** Intervall für automatische Scans in Minuten, 0 schaltet sie ab */
  scanIntervalMinutes: number;
  /** Wie viele Dateien parallel aus der Nextcloud gelesen werden */
  scanConcurrency: number;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return value;
}

function integer(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Umgebungsvariable ${name} muss eine ganze Zahl >= ${min} sein`);
  }
  return value;
}

export function normalizeMusicPath(path: string): string {
  const segments = path.trim().split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('NEXTCLOUD_MUSIC_PATH darf keine "." oder ".." enthalten');
  }
  return segments.length ? `/${segments.join('/')}` : '';
}

export function loadConfig(env: Env = process.env): Config {
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: integer(env, 'PORT', 3000, 1),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    databasePath: env.DATABASE_PATH?.trim() || './data/library.db',
    adminToken: env.ADMIN_TOKEN?.trim() || undefined,
    webDir: env.WEB_DIR?.trim() || '../web/dist',
    nextcloud: {
      url: required(env, 'NEXTCLOUD_URL').replace(/\/+$/, ''),
      user: required(env, 'NEXTCLOUD_USER'),
      password: required(env, 'NEXTCLOUD_PASSWORD'),
      // Bewusst ohne Standardwert: Welcher Ordner gescannt wird, soll immer ausdrücklich festgelegt sein.
      musicPath: normalizeMusicPath(required(env, 'NEXTCLOUD_MUSIC_PATH')),
    },
    scanIntervalMinutes: integer(env, 'SCAN_INTERVAL_MINUTES', 60),
    scanConcurrency: integer(env, 'SCAN_CONCURRENCY', 4, 1),
  };
}
