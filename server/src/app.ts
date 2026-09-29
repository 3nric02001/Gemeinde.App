import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './api/auth.js';
import { registerRoutes } from './api/routes.js';
import { registerUserAdminRoutes } from './api/users.js';
import { OidcService } from './auth/oidc.js';
import { getBranding, manifest } from './branding.js';
import { ensureLocalAdmin } from './auth/users.js';
import type { Config } from './config.js';
import { openDatabase, type DB } from './db.js';
import { relocateLibrary } from './library/relocate.js';
import { LibraryScanner } from './library/scanner.js';
import { NextcloudClient } from './nextcloud/webdav.js';
import { registerSecurityHeaders } from './http/security.js';
import { registerWeb } from './web.js';

export interface AppContext {
  app: FastifyInstance;
  db: DB;
  scanner: LibraryScanner;
}

export async function buildApp(config: Config, options: { fetch?: typeof fetch; logger?: boolean; requestTimeoutMs?: number } = {}): Promise<AppContext> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    // Hinter einem Reverse Proxy (Traefik, nginx) die echte Client-IP verwenden.
    trustProxy: true,
  });
  const db = openDatabase(config.databasePath);
  const client = new NextcloudClient(config.nextcloud, options.fetch, options.requestTimeoutMs);
  relocateLibrary(db, client.base, config.nextcloud.musicPaths, app.log);
  const scanner = new LibraryScanner(db, client, app.log, config.scanConcurrency);

  await ensureLocalAdmin(db, { password: config.adminPassword, reset: config.resetAdminPassword }, app.log);
  const oidc = new OidcService(db);

  registerSecurityHeaders(app);
  // Zuerst: Der Zugriffsschutz muss vor allen API-Routen stehen.
  await registerAuth(app, { db, oidc, publicUrl: config.publicUrl });
  await registerRoutes(app, { db, client, scanner });
  await registerUserAdminRoutes(app, { db, oidc, publicUrl: config.publicUrl });
  app.get('/manifest.webmanifest', async (_request, reply) =>
    reply.type('application/manifest+json').header('cache-control', 'no-cache').send(manifest(getBranding(db))),
  );
  if (!(await registerWeb(app, config.webDir))) {
    app.log.info({ webDir: config.webDir }, 'Keine Weboberfläche gefunden, nur die API ist erreichbar');
  }
  app.addHook('onClose', async () => db.close());
  return { app, db, scanner };
}
