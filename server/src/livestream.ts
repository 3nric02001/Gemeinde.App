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
  /**
   * Direkte Adresse des Streams (HLS, .m3u8) für den Player der App, nur https. Leer: bei Owncast
   * (Adresse /embed/video/) automatisch https://host/hls/stream.m3u8, sonst kein Hören im Player.
   */
  audioUrl: string;
}

export const DEFAULT_LIVESTREAM: Livestream = {
  enabled: true,
  url: 'https://vortrag.mbg-bielefeld-brake.de/embed/video/',
  title: 'Livestream',
  audioUrl: '',
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
      audioUrl: typeof saved.audioUrl === 'string' ? saved.audioUrl : DEFAULT_LIVESTREAM.audioUrl,
    };
  } catch {
    return DEFAULT_LIVESTREAM;
  }
}

export function saveLivestream(db: DB, patch: Partial<Livestream>): Livestream {
  const next = { ...getLivestream(db), ...patch };
  next.url = next.url.trim();
  next.title = next.title.trim();
  next.audioUrl = next.audioUrl.trim();
  if (next.url && !parseStreamUrl(next.url)) throw new LivestreamError('Bitte eine vollständige Adresse mit https:// angeben');
  if (next.audioUrl && !parseStreamUrl(next.audioUrl)) {
    throw new LivestreamError('Bitte für den Player eine vollständige Adresse mit https:// angeben oder das Feld leer lassen');
  }
  if (next.enabled && !next.url) throw new LivestreamError('Zum Einschalten fehlt die Adresse des Streams');
  setMeta(db, 'livestream', JSON.stringify(next));
  return getLivestream(db);
}

/**
 * Adresse, die der Player der App abspielt (HLS). Eingetragen oder bei Owncast abgeleitet: Owncast liefert unter
 * /embed/video/ die Seite zum Einbetten und unter /hls/stream.m3u8 den Stream selbst.
 */
export function streamAudioUrl(live: Livestream): string | undefined {
  if (live.audioUrl) return parseStreamUrl(live.audioUrl)?.href;
  const page = parseStreamUrl(live.url);
  return page && /^\/embed\/video\/?$/.test(page.pathname) ? `${page.origin}/hls/stream.m3u8` : undefined;
}

/** Für die Hörer: nur, was die Seite braucht, und nur, wenn eingeschaltet. */
export function publicLivestream(db: DB): { url: string; title: string; audio?: string } | null {
  const live = getLivestream(db);
  if (!live.enabled) return null;
  const audio = streamAudioUrl(live);
  return audio ? { url: live.url, title: live.title, audio } : { url: live.url, title: live.title };
}

/**
 * Herkünfte (https://host) für die CSP der Seiten, solange der Stream eingeschaltet ist: `frame` für die
 * eingebettete Seite (frame-src), `media` für den Stream im Player (media-src).
 */
export function livestreamOrigins(db: DB): { frame?: string; media?: string } {
  const live = getLivestream(db);
  if (!live.enabled) return {};
  const audio = streamAudioUrl(live);
  return { frame: parseStreamUrl(live.url)?.origin, media: audio ? new URL(audio).origin : undefined };
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
