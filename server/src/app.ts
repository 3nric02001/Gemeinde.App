import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './api/auth.js';
import { registerRoutes } from './api/routes.js';
import { registerUserAdminRoutes } from './api/users.js';
import { OidcService } from './auth/oidc.js';
import { getBranding, manifest } from './branding.js';
import { livestreamOrigins } from './livestream.js';
import { ensureLocalAdmin } from './auth/users.js';
import type { Config } from './config.js';
import { openDatabase, type DB } from './db.js';
import { applyLibrarySettings } from './library/structure.js';
import { relocateLibrary } from './library/relocate.js';
import { registerChangeLog } from './library/changes.js';
import { LibraryScanner } from './library/scanner.js';
import { CoverThumbnails } from './library/thumbnails.js';
import { NextcloudClient } from './nextcloud/webdav.js';
import { registerSecurityHeaders } from './http/security.js';
import { registerWeb } from './web.js';

export interface AppContext {
  app: FastifyInstance;
  db: DB;
  scanner: LibraryScanner;
}

export async function buildApp(config: Config, options: { fetch?: typeof fetch; logger?: boolean; requestTimeoutMs?: number; streamTimeoutMs?: number } = {}): Promise<AppContext> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    // Hinter einem Reverse Proxy (Traefik, nginx) die echte Client-IP verwenden, aber nur,
    // wenn die Anfrage wirklich vom Proxy kommt (TRUST_PROXY); sonst könnte jeder seine IP fälschen.
    trustProxy: config.trustProxy,
  });
  const db = openDatabase(config.databasePath);
  // Albumbildung und Namen aus dem gespeicherten Regelwerk (Verwaltung → Zuordnung)
  applyLibrarySettings(db);
  const client = new NextcloudClient(config.nextcloud, options.fetch, options.requestTimeoutMs);
  relocateLibrary(db, client.base, config.nextcloud.musicPaths, app.log);
  const scanner = new LibraryScanner(db, client, app.log, config.scanConcurrency);

  await ensureLocalAdmin(
    db,
    {
      password: config.adminPassword,
      reset: config.resetAdminPassword,
      passwordFile: config.databasePath === ':memory:' ? undefined : join(dirname(config.databasePath), 'admin-password.txt'),
    },
    app.log,
  );
  const oidc = new OidcService(db);
  if (oidc.isReady() && !config.publicUrl) {
    app.log.warn('OIDC ist eingeschaltet, aber PUBLIC_URL fehlt: bitte in der .env setzen, sonst stammt die Weiterleitungs-URL aus der Anfrage');
  }

  registerSecurityHeaders(app, () => livestreamOrigins(db));
  // Zuerst: Der Zugriffsschutz muss vor allen API-Routen stehen.
  await registerAuth(app, { db, oidc, publicUrl: config.publicUrl });
  registerChangeLog(app, db);
  await registerRoutes(app, {
    db,
    client,
    scanner,
    thumbnails: new CoverThumbnails(db, client, app.log),
    streamTimeoutMs: options.streamTimeoutMs,
  });
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
