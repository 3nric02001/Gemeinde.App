import { getMeta, setMeta, type DB } from './db.js';

/**
 * Livestream: eine fremde Seite (z. B. Owncast unter /embed/video/), die die App auf /live einbettet.
 * Im Admin-Bereich unter "Anmeldung" ein- und ausschaltbar; die Adresse gibt auch frame-src in der CSP frei.
 */
export interface Livestream {
  enabled: boolean;
  /** Adresse zum Einbetten, nur https */
  url: string;
  /** Überschrift der Seite und Name der Kachel auf der Startseite */
  title: string;
}

export const DEFAULT_LIVESTREAM: Livestream = {
  enabled: true,
  url: 'https://vortrag.mbg-bielefeld-brake.de/embed/video/',
  title: 'Livestream',
};

/** Ungültige Eingabe in der Verwaltung, wird als 400 gemeldet */
export class LivestreamError extends Error {
  readonly statusCode = 400;
}

/** Nur vollständige https-Adressen ohne Zugangsdaten; sonst undefined. */
export function parseStreamUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function getLivestream(db: DB): Livestream {
  try {
    const saved = JSON.parse(getMeta(db, 'livestream') ?? '{}') as Partial<Livestream>;
    const url = typeof saved.url === 'string' ? saved.url : DEFAULT_LIVESTREAM.url;
    return {
      // Ohne gültige Adresse gibt es nichts einzubetten
      enabled: (saved.enabled ?? DEFAULT_LIVESTREAM.enabled) && Boolean(parseStreamUrl(url)),
      url,
      title: saved.title?.trim() || DEFAULT_LIVESTREAM.title,
    };
  } catch {
    return DEFAULT_LIVESTREAM;
  }
}

export function saveLivestream(db: DB, patch: Partial<Livestream>): Livestream {
  const next = { ...getLivestream(db), ...patch };
  next.url = next.url.trim();
  next.title = next.title.trim();
  if (next.url && !parseStreamUrl(next.url)) throw new LivestreamError('Bitte eine vollständige Adresse mit https:// angeben');
  if (next.enabled && !next.url) throw new LivestreamError('Zum Einschalten fehlt die Adresse des Streams');
  setMeta(db, 'livestream', JSON.stringify(next));
  return getLivestream(db);
}

/** Für die Hörer: nur, was die Seite braucht, und nur, wenn eingeschaltet. */
export function publicLivestream(db: DB): { url: string; title: string } | null {
  const live = getLivestream(db);
  return live.enabled ? { url: live.url, title: live.title } : null;
}

/** Herkunft (https://host) für frame-src in der CSP der Seiten, solange der Stream eingeschaltet ist. */
export function livestreamOrigin(db: DB): string | undefined {
  const live = getLivestream(db);
  return live.enabled ? parseStreamUrl(live.url)?.origin : undefined;
}

/** So lange gilt eine Antwort des Stream-Servers, bevor die App wieder fragt */
export const LIVE_STATUS_MAX_AGE_MS = 60_000;
const LIVE_STATUS_TIMEOUT_MS = 4_000;

/**
 * Sendet der Stream gerade? Owncast beantwortet das unter /api/status ({"online": true}). Die App fragt höchstens
 * einmal pro Minute nach, egal wie viele Hörer die Startseite offen haben. Andere Stream-Server oder ein Fehler
 * ergeben null (unbekannt); dann zeigt die App die Kachel wie ohne Status.
 */
export class LiveStatus {
  private last: { url: string; live: boolean | null; at: number } | undefined;
  private pending: Promise<boolean | null> | undefined;

  constructor(
    private readonly db: DB,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxAgeMs = LIVE_STATUS_MAX_AGE_MS,
  ) {}

  /** null: ausgeschaltet oder unbekannt */
  async get(): Promise<boolean | null> {
    const stream = getLivestream(this.db);
    const origin = stream.enabled ? parseStreamUrl(stream.url)?.origin : undefined;
    if (!origin) return null;
    const last = this.last?.url === origin ? this.last : undefined;
    if (last && Date.now() - last.at < this.maxAgeMs) return last.live;
    this.pending ??= this.check(origin).finally(() => (this.pending = undefined));
    // Mit altem Stand nicht warten; der neue gilt ab der nächsten Anfrage.
    return last ? last.live : this.pending;
  }

  private async check(origin: string): Promise<boolean | null> {
    let live: boolean | null = null;
    try {
      const res = await this.fetchImpl(`${origin}/api/status`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(LIVE_STATUS_TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.ok) {
        const body = (await res.json()) as { online?: unknown };
        if (typeof body.online === 'boolean') live = body.online;
      }
    } catch {
      live = null;
    }
    this.last = { url: origin, live, at: Date.now() };
    return live;
  }
}
