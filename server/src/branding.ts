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
