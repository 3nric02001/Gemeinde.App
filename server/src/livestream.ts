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
