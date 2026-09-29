export interface NextcloudConfig {
  /** Basis-URL der Nextcloud, z. B. https://cloud.example.org */
  url: string;
  user: string;
  /** App-Passwort des Service-Accounts (nicht das Login-Passwort) */
  password: string;
  /**
   * Ordner innerhalb des Accounts, die gescannt werden, z. B. ["/Gemeinde/Medien/Musik", "/Gemeinde/Predigten"].
   * Nur diese Ordner und ihre Unterordner landen in der Bibliothek; "" (also "/") wäre der ganze Account.
   */
  musicPaths: string[];
}

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  databasePath: string;
  /** Startpasswort des lokalen Admins; ohne Angabe wird beim ersten Start eines erzeugt und geloggt */
  adminPassword: string | undefined;
  /** Setzt das Passwort des lokalen Admins beim Start zurück (vergessenes Passwort) */
  resetAdminPassword: boolean;
  /** Öffentliche Adresse, z. B. https://musik.gemeinde.de; sonst aus der Anfrage abgeleitet */
  publicUrl: string | undefined;
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

/**
 * Mehrere Ordner durch Komma, Semikolon oder Zeilenumbruch getrennt. Doppelte und solche,
 * die schon in einem anderen angegebenen Ordner liegen, fallen weg; die Reihenfolge bleibt.
 */
export function parseMusicPaths(raw: string): string[] {
  const paths = raw
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeMusicPath);
  const inside = (path: string, parent: string) => parent === '' || path === parent || path.startsWith(`${parent}/`);
  return paths.filter(
    (path, index) => !paths.some((other, j) => (other === path ? j < index : inside(path, other))),
  );
}

function publicUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_URL muss eine vollständige Adresse sein, z. B. https://musik.gemeinde.de');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('PUBLIC_URL muss mit https:// beginnen');
  return url.origin;
}

function musicPaths(raw: string): string[] {
  const paths = parseMusicPaths(raw);
  if (paths.length === 0) throw new Error('Umgebungsvariable NEXTCLOUD_MUSIC_PATH fehlt');
  return paths;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: integer(env, 'PORT', 3000, 1),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    databasePath: env.DATABASE_PATH?.trim() || './data/library.db',
    // Ohne Leerzeichen/Zeilenende am Rand, die beim Bearbeiten der .env (z. B. unter Windows) mitrutschen.
    adminPassword: env.ADMIN_PASSWORD?.trim() || undefined,
    resetAdminPassword: ['1', 'true', 'ja', 'yes'].includes(env.RESET_ADMIN_PASSWORD?.trim().toLowerCase() ?? ''),
    publicUrl: publicUrl(env.PUBLIC_URL),
    webDir: env.WEB_DIR?.trim() || '../web/dist',
    nextcloud: {
      url: required(env, 'NEXTCLOUD_URL').replace(/\/+$/, ''),
      user: required(env, 'NEXTCLOUD_USER'),
      password: required(env, 'NEXTCLOUD_PASSWORD'),
      // Bewusst ohne Standardwert: Welcher Ordner gescannt wird, soll immer ausdrücklich festgelegt sein.
      musicPaths: musicPaths(required(env, 'NEXTCLOUD_MUSIC_PATH')),
    },
    scanIntervalMinutes: integer(env, 'SCAN_INTERVAL_MINUTES', 60),
    scanConcurrency: integer(env, 'SCAN_CONCURRENCY', 4, 1),
  };
}
