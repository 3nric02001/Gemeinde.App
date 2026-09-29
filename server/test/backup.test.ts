import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseBackup } from '../src/backup.js';
import { openDatabase, setMeta, type DB } from '../src/db.js';

const log = { info: () => {}, error: () => {} } as never;
let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gemeinde-backup-'));
  db = openDatabase(join(dir, 'library.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Datenbank-Sicherung', () => {
  it('sichert einmal am Tag eine lesbare Kopie', async () => {
    setMeta(db, 'probe', 'vorher');
    const backup = new DatabaseBackup(db, join(dir, 'backups'), 14, log);
    const file = await backup.ensureToday(new Date('2026-09-29T10:00:00Z'));
    expect(file).toBe(join(dir, 'backups', 'library-2026-09-29.db'));
    expect(await backup.ensureToday(new Date('2026-09-29T18:00:00Z'))).toBeUndefined();

    const copy = new Database(file!, { readonly: true });
    expect(copy.prepare("SELECT value FROM meta WHERE key = 'probe'").get()).toEqual({ value: 'vorher' });
    copy.close();
  });

  it('behält nur die neuesten Sicherungen', async () => {
    const backups = join(dir, 'backups');
    const backup = new DatabaseBackup(db, backups, 3, log);
    for (const day of ['01', '02', '03', '04', '05']) await backup.ensureToday(new Date(`2026-09-${day}T12:00:00Z`));
    writeFileSync(join(backups, 'notiz.txt'), 'bleibt');
    await backup.ensureToday(new Date('2026-09-06T12:00:00Z'));
    expect(readdirSync(backups).sort()).toEqual(['library-2026-09-04.db', 'library-2026-09-05.db', 'library-2026-09-06.db', 'notiz.txt']);
  });
});
