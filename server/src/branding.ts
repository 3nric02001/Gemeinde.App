import { getMeta, setMeta, type DB } from './db.js';

/** Name und Begrüßung der Gemeinde, im Admin-Bereich unter "Anmeldung" einstellbar. */
export interface Branding {
  /** Name in der Seitenleiste, im Browser-Tab und auf der Anmeldeseite */
  name: string;
  /** Ein Satz unter "Anmelden", z. B. "Predigten und Musik der MBG Bielefeld-Brake" */
  welcome: string;
}

export const DEFAULT_BRANDING: Branding = { name: 'Gemeinde.App', welcome: '' };

export function getBranding(db: DB): Branding {
  try {
    const saved = JSON.parse(getMeta(db, 'branding') ?? '{}') as Partial<Branding>;
    return { name: saved.name?.trim() || DEFAULT_BRANDING.name, welcome: saved.welcome?.trim() ?? '' };
  } catch {
    return DEFAULT_BRANDING;
  }
}

export function saveBranding(db: DB, branding: Partial<Branding>): Branding {
  const next = { ...getBranding(db), ...branding };
  setMeta(db, 'branding', JSON.stringify({ name: next.name.trim(), welcome: next.welcome.trim() }));
  return getBranding(db);
}

/**
 * Web-App-Manifest für "Zum Home-Bildschirm": vom Server, damit das Symbol den eingestellten
 * Gemeindenamen trägt. Öffentlich, weil der Browser es ohne Anmeldung abruft.
 */
export function manifest(branding: Branding) {
  return {
    name: branding.name,
    short_name: branding.name.length > 14 ? branding.name.slice(0, 14).trim() : branding.name,
    description: branding.welcome || 'Predigten und Musik der Gemeinde',
    lang: 'de',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
