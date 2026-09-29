export interface NextcloudConfig {
  /** Basis-URL der Nextcloud, z. B. https://cloud.example.org */
  url: string;
  user: string;
  /** App-Passwort des Service-Accounts (nicht das Login-Passwort) */
  password: string;
  /** Ordner innerhalb des Accounts, der die Musik enthält, z. B. /Musik */
  musicPath: string;
}

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  databasePath: string;
  adminToken: string | undefined;
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
  const trimmed = path.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

export function loadConfig(env: Env = process.env): Config {
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: integer(env, 'PORT', 3000, 1),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    databasePath: env.DATABASE_PATH?.trim() || './data/library.db',
    adminToken: env.ADMIN_TOKEN?.trim() || undefined,
    nextcloud: {
      url: required(env, 'NEXTCLOUD_URL').replace(/\/+$/, ''),
      user: required(env, 'NEXTCLOUD_USER'),
      password: required(env, 'NEXTCLOUD_PASSWORD'),
      musicPath: normalizeMusicPath(env.NEXTCLOUD_MUSIC_PATH ?? '/Music'),
    },
    scanIntervalMinutes: integer(env, 'SCAN_INTERVAL_MINUTES', 60),
    scanConcurrency: integer(env, 'SCAN_CONCURRENCY', 4, 1),
  };
}
