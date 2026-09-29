import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from './api/routes.js';
import type { Config } from './config.js';
import { openDatabase, type DB } from './db.js';
import { LibraryScanner } from './library/scanner.js';
import { NextcloudClient } from './nextcloud/webdav.js';

export interface AppContext {
  app: FastifyInstance;
  db: DB;
  scanner: LibraryScanner;
}

export async function buildApp(config: Config, options: { fetch?: typeof fetch; logger?: boolean } = {}): Promise<AppContext> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    // Hinter einem Reverse Proxy (Traefik, nginx) die echte Client-IP verwenden.
    trustProxy: true,
  });
  const db = openDatabase(config.databasePath);
  const client = new NextcloudClient(config.nextcloud, options.fetch);
  const scanner = new LibraryScanner(db, client, app.log, config.scanConcurrency);

  await registerRoutes(app, { db, client, scanner, adminToken: config.adminToken });
  app.addHook('onClose', async () => db.close());
  return { app, db, scanner };
}
