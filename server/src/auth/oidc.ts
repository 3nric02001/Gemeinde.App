import * as client from 'openid-client';
import { getMeta, setMeta, type DB } from '../db.js';
import { AuthError, type OidcIdentity } from './users.js';

export interface OidcSettings {
  enabled: boolean;
  /** Issuer-URL des Identity Providers, z. B. https://login.gemeinde.de/realms/gemeinde */
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Claim mit den Gruppen, auch verschachtelt wie realm_access.roles */
  groupsClaim: string;
  /** Beschriftung des Anmeldeknopfs */
  label: string;
}

export const DEFAULT_OIDC: OidcSettings = {
  enabled: false,
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  groupsClaim: 'groups',
  label: 'Mit Gemeinde-Konto anmelden',
};

const META_KEY = 'oidc';
// Zeit, die jemand beim Identity Provider für die Anmeldung hat.
const LOGIN_TTL_MS = 10 * 60 * 1000;

export function readOidcSettings(db: DB): OidcSettings {
  const raw = getMeta(db, META_KEY);
  return { ...DEFAULT_OIDC, ...(raw ? (JSON.parse(raw) as Partial<OidcSettings>) : {}) };
}

/** Nur über http erreichbare Identity Provider auf dem eigenen Rechner (Entwicklung, Tests). */
function isLocalHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function validateIssuer(issuer: string): string {
  let url: URL;
  try {
    url = new URL(issuer.trim());
  } catch {
    throw new AuthError(400, 'Die Issuer-URL ist keine gültige Adresse');
  }
  if (url.protocol !== 'https:' && !isLocalHttp(url)) throw new AuthError(400, 'Die Issuer-URL muss mit https:// beginnen');
  // Wie eingegeben speichern: Manche Identity Provider (z. B. Authentik) führen den Issuer mit
  // Schrägstrich am Ende, andere ohne; beim Abruf wird notfalls die andere Schreibweise versucht.
  return url.href;
}

/** Dieselbe Adresse mit bzw. ohne Schrägstrich am Ende. */
function toggleTrailingSlash(url: URL): URL {
  const other = new URL(url.href);
  other.pathname = other.pathname.endsWith('/') ? other.pathname.replace(/\/+$/, '') || '/' : `${other.pathname}/`;
  return other;
}

/** Liest einen Claim, auch verschachtelt ("realm_access.roles"). */
export function claimValues(claims: Record<string, unknown>, path: string): string[] | undefined {
  let value: unknown = claims;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))];
}

export class OidcService {
  private discovered: { key: string; config: Promise<client.Configuration> } | undefined;

  constructor(private readonly db: DB) {}

  settings(): OidcSettings {
    return readOidcSettings(this.db);
  }

  isReady(settings = this.settings()): boolean {
    return settings.enabled && Boolean(settings.issuer && settings.clientId);
  }

  save(patch: Partial<OidcSettings>): OidcSettings {
    const next = { ...this.settings(), ...patch };
    if (next.issuer) next.issuer = validateIssuer(next.issuer);
    next.clientId = next.clientId.trim();
    next.scopes = next.scopes.trim() || DEFAULT_OIDC.scopes;
    if (!next.scopes.split(/\s+/).includes('openid')) next.scopes = `openid ${next.scopes}`;
    next.groupsClaim = next.groupsClaim.trim() || DEFAULT_OIDC.groupsClaim;
    next.label = next.label.trim() || DEFAULT_OIDC.label;
    if (next.enabled && (!next.issuer || !next.clientId)) {
      throw new AuthError(400, 'Zum Einschalten braucht es Issuer-URL und Client-ID');
    }
    setMeta(this.db, META_KEY, JSON.stringify(next));
    this.discovered = undefined;
    return next;
  }

  private configuration(settings: OidcSettings): Promise<client.Configuration> {
    const key = JSON.stringify([settings.issuer, settings.clientId, settings.clientSecret]);
    if (this.discovered?.key !== key) {
      const issuer = new URL(settings.issuer);
      const discover = (url: URL) =>
        client.discovery(
          url,
          settings.clientId,
          undefined,
          settings.clientSecret ? client.ClientSecretPost(settings.clientSecret) : client.None(),
          isLocalHttp(url) ? { execute: [client.allowInsecureRequests] } : undefined,
        );
      const config = discover(issuer)
        // Der Issuer in den Metadaten muss Zeichen für Zeichen passen; ein fehlender oder
        // überzähliger Schrägstrich am Ende ist der häufigste Grund, dass er es nicht tut.
        .catch((error: unknown) => {
          const alternative = toggleTrailingSlash(issuer);
          if (alternative.href === issuer.href) throw error;
          return discover(alternative).catch(() => {
            throw error;
          });
        })
        .catch((error: unknown) => {
          // Beim nächsten Versuch neu abfragen, statt den Fehler zu behalten.
          if (this.discovered?.config === config) this.discovered = undefined;
          throw error;
        });
      this.discovered = { key, config };
    }
    return this.discovered.config;
  }

  /** Prüft, ob der Identity Provider erreichbar ist und sich beschreibt (Discovery). */
  async test(): Promise<{ issuer: string }> {
    const settings = this.settings();
    if (!settings.issuer || !settings.clientId) throw new AuthError(400, 'Issuer-URL und Client-ID fehlen');
    try {
      const config = await this.configuration(settings);
      return { issuer: config.serverMetadata().issuer };
    } catch (error) {
      const reported = await this.reportedIssuer(settings.issuer);
      const hint =
        reported && reported !== settings.issuer
          ? ` (eingetragen: ${settings.issuer}, der Identity Provider meldet: ${reported})`
          : '';
      throw new AuthError(502, `Identity Provider nicht erreichbar: ${(error as Error).message}${hint}`);
    }
  }

  /** Issuer laut Discovery-Dokument, damit eine Abweichung in der Fehlermeldung sichtbar wird. */
  private async reportedIssuer(issuer: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as { issuer?: unknown };
      return typeof data.issuer === 'string' ? data.issuer : undefined;
    } catch {
      return undefined;
    }
  }

  /** Beginnt die Anmeldung; liefert die Adresse beim Identity Provider und den state für das Cookie. */
  async start(redirectUri: string, returnTo: string): Promise<{ url: string; state: string }> {
    const settings = this.settings();
    if (!this.isReady(settings)) throw new AuthError(404, 'Anmeldung über OIDC ist nicht eingerichtet');
    const config = await this.configuration(settings);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const now = Date.now();
    this.db.prepare('DELETE FROM oidc_logins WHERE created_at < ?').run(now - LOGIN_TTL_MS);
    this.db
      .prepare('INSERT INTO oidc_logins (state, verifier, nonce, return_to, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, verifier, nonce, returnTo, now);
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: settings.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, state };
  }

  /**
   * Schließt die Anmeldung ab. `cookieState` stammt aus dem Cookie des Browsers, der die Anmeldung
   * begonnen hat; so kann niemand einem anderen seine eigene Anmeldung unterschieben.
   */
  async finish(
    redirectUri: string,
    callback: URL,
    cookieState: string | undefined,
  ): Promise<{ identity: OidcIdentity; returnTo: string }> {
    const settings = this.settings();
    if (!this.isReady(settings)) throw new AuthError(404, 'Anmeldung über OIDC ist nicht eingerichtet');
    const state = callback.searchParams.get('state') ?? '';
    const login = this.db.prepare('SELECT verifier, nonce, return_to, created_at FROM oidc_logins WHERE state = ?').get(state) as
      | { verifier: string; nonce: string; return_to: string; created_at: number }
      | undefined;
    if (login) this.db.prepare('DELETE FROM oidc_logins WHERE state = ?').run(state);
    if (!login || !cookieState || cookieState !== state || Date.now() - login.created_at > LOGIN_TTL_MS) {
      throw new AuthError(400, 'Die Anmeldung ist abgelaufen oder ungültig, bitte erneut versuchen');
    }

    const config = await this.configuration(settings);
    // Die Rückkehr-Adresse muss für den Token-Abruf genau der redirect_uri entsprechen.
    const current = new URL(redirectUri);
    current.search = callback.search;
    const tokens = await client.authorizationCodeGrant(config, current, {
      pkceCodeVerifier: login.verifier,
      expectedState: state,
      expectedNonce: login.nonce,
      idTokenExpected: true,
    });
    const idClaims = tokens.claims()!;
    let claims: Record<string, unknown> = idClaims;
    // Manche Identity Provider liefern Gruppen, Name oder E-Mail nur über den Userinfo-Endpunkt.
    if (claimValues(claims, settings.groupsClaim) === undefined || !claims.name) {
      if (config.serverMetadata().userinfo_endpoint) {
        const info = await client.fetchUserInfo(config, tokens.access_token, idClaims.sub);
        claims = { ...info, ...idClaims };
      }
    }

    const text = (key: string) => (typeof claims[key] === 'string' && (claims[key] as string).trim()) || undefined;
    return {
      identity: {
        issuer: config.serverMetadata().issuer,
        subject: idClaims.sub,
        name: text('name') ?? text('preferred_username') ?? text('email') ?? idClaims.sub,
        email: text('email') ?? null,
        groups: claimValues(claims, settings.groupsClaim) ?? [],
      },
      returnTo: login.return_to,
    };
  }
}
