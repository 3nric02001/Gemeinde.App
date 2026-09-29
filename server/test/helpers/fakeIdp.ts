import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

export const CLIENT_ID = 'gemeinde-app';
export const CLIENT_SECRET = 'idp-secret';

interface PendingCode {
  nonce: string;
  challenge: string;
  redirectUri: string;
  claims: Record<string, unknown>;
}

/**
 * Minimaler OpenID-Provider für Tests: meldet bei /authorize sofort den eingestellten Benutzer an
 * und prüft beim Token-Abruf Client-Secret, redirect_uri und PKCE.
 */
export class FakeIdp {
  url = '';
  /** Claims des nächsten Logins (sub ist Pflicht) */
  user: Record<string, unknown> = { sub: 'u1', name: 'Anna Beispiel', email: 'anna@example.org', groups: ['musik'] };
  /** Zusätzliche Claims nur über den Userinfo-Endpunkt */
  userinfo: Record<string, unknown> = {};
  private server: Server | undefined;
  private key: CryptoKey | undefined;
  private jwk: JWK | undefined;
  private readonly codes = new Map<string, PendingCode>();

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.key = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url!, this.url);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/authorize`,
        token_endpoint: `${this.url}/token`,
        userinfo_endpoint: `${this.url}/userinfo`,
        jwks_uri: `${this.url}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [this.jwk] });

    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== CLIENT_ID || p.get('code_challenge_method') !== 'S256')
        return json(400, { error: 'invalid_request' });
      const code = randomBytes(8).toString('hex');
      this.codes.set(code, {
        nonce: p.get('nonce')!,
        challenge: p.get('code_challenge')!,
        redirectUri: p.get('redirect_uri')!,
        claims: { ...this.user },
      });
      const target = new URL(p.get('redirect_uri')!);
      target.searchParams.set('code', code);
      target.searchParams.set('state', p.get('state')!);
      target.searchParams.set('iss', this.url);
      res.writeHead(302, { location: target.href });
      return void res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        !pending ||
        form.get('client_id') !== CLIENT_ID ||
        form.get('client_secret') !== CLIENT_SECRET ||
        form.get('redirect_uri') !== pending.redirectUri ||
        challenge !== pending.challenge
      ) {
        return json(400, { error: 'invalid_grant' });
      }
      const idToken = await new SignJWT({ ...pending.claims, nonce: pending.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(this.url)
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.key!);
      return json(200, { access_token: `at-${pending.claims.sub}`, token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }

    if (url.pathname === '/userinfo') {
      const sub = (req.headers.authorization ?? '').replace(/^Bearer at-/, '');
      return json(200, { sub, ...this.userinfo });
    }

    json(404, { error: 'not_found' });
  }
}
