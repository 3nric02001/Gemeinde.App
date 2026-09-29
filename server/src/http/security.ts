import type { FastifyInstance } from 'fastify';

/** Für die Weboberfläche: nur eigene Skripte, keine Einbettung in fremde Seiten. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Preact setzt einzelne style-Attribute (z. B. Farbton der Platzhalter).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/** Für alles unter /api: Direkt geöffnet darf eine Antwort (Cover, Stream, JSON) nie etwas ausführen. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/**
 * Sicherheits-Header für jede Antwort. Schon gesetzte Header (etwa von einer Route) bleiben stehen.
 * HSTS nur, wenn die Anfrage per https kam; sonst würde ein Test über http den Browser aussperren.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const set = (name: string, value: string) => {
      if (!reply.hasHeader(name)) reply.header(name, value);
    };
    const isApi = request.url.startsWith('/api/') || request.url === '/api';
    set('content-security-policy', isApi ? API_CSP : PAGE_CSP);
    set('x-content-type-options', 'nosniff');
    set('x-frame-options', 'DENY');
    set('referrer-policy', 'same-origin');
    set('cross-origin-opener-policy', 'same-origin');
    set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (request.protocol === 'https') set('strict-transport-security', 'max-age=31536000');
    return payload;
  });
}
