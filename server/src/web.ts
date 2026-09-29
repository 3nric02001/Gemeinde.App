import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Liefert die gebaute Weboberfläche aus. Dateien unter /assets tragen einen Hash im Namen und
 * dürfen lange gecacht werden; index.html nie, damit ein Update sofort ankommt.
 * Unbekannte Pfade außerhalb von /api bekommen index.html, damit Links wie /album/12 funktionieren.
 */
export async function registerWeb(app: FastifyInstance, webDir: string): Promise<boolean> {
  const root = resolve(webDir);
  if (!existsSync(join(root, 'index.html'))) return false;
  const assets = join(root, 'assets') + sep;

  await app.register(fastifyStatic, {
    root,
    index: ['index.html'],
    setHeaders(reply, path) {
      reply.header('cache-control', path.startsWith(assets) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  app.setNotFoundHandler((request, reply) => {
    const isPage = (request.method === 'GET' || request.method === 'HEAD') && !request.url.startsWith('/api');
    if (!isPage) return reply.code(404).send({ error: 'Nicht gefunden' });
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });
  return true;
}
