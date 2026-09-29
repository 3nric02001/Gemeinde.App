import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from './db.js';

const NAME = /^library-(\d{4}-\d{2}-\d{2})\.db$/;

/** Dateiname der Sicherung eines Tages, z. B. library-2026-09-29.db */
export const backupName = (date: Date) => `library-${date.toISOString().slice(0, 10)}.db`;

/**
 * Tägliche Sicherung der Datenbank. SQLite schreibt sie per Online-Backup, also konsistent auch
 * während Scans und Anfragen laufen (ein Kopieren der Datei im WAL-Betrieb wäre das nicht).
 * Es bleiben die letzten `keep` Tage liegen.
 */
export class DatabaseBackup {
  private running: Promise<string | undefined> | undefined;

  constructor(
    private readonly db: DB,
    private readonly dir: string,
    private readonly keep: number,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Sichert, falls es für heute noch keine Sicherung gibt; liefert den Pfad einer neuen Sicherung. */
  ensureToday(now = new Date()): Promise<string | undefined> {
    this.running ??= this.run(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(now: Date): Promise<string | undefined> {
    const target = join(this.dir, backupName(now));
    if (existsSync(target)) return undefined;
    try {
      mkdirSync(this.dir, { recursive: true });
      const partial = `${target}.partial`;
      rmSync(partial, { force: true });
      await this.db.backup(partial);
      renameSync(partial, target);
      this.prune();
      this.log.info({ file: target }, 'Datenbank gesichert');
      return target;
    } catch (error) {
      this.log.error({ err: error, dir: this.dir }, 'Datenbank-Sicherung fehlgeschlagen');
      return undefined;
    }
  }

  /** Nur die neuesten `keep` Sicherungen behalten. */
  private prune(): void {
    const files = readdirSync(this.dir)
      .filter((name) => NAME.test(name))
      .sort()
      .reverse();
    for (const name of files.slice(this.keep)) rmSync(join(this.dir, name), { force: true });
  }
}
