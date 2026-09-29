import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/**
 * Jede Migration läuft genau einmal; der Stand steht in PRAGMA user_version.
 * Neue Migrationen nur anhängen, bestehende nie ändern.
 */
const migrations: string[] = [
  `
  CREATE TABLE albums (
    id          INTEGER PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    artist      TEXT NOT NULL,
    year        INTEGER,
    genre       TEXT,
    folder      TEXT NOT NULL,
    cover_path  TEXT,
    track_count INTEGER NOT NULL DEFAULT 0,
    duration    REAL NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX albums_artist ON albums(artist COLLATE NOCASE);
  CREATE INDEX albums_year ON albums(year);
  CREATE INDEX albums_genre ON albums(genre COLLATE NOCASE);

  CREATE TABLE tracks (
    id            INTEGER PRIMARY KEY,
    path          TEXT NOT NULL UNIQUE,
    etag          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    mime          TEXT,
    title         TEXT NOT NULL,
    artist        TEXT NOT NULL,
    album_artist  TEXT,
    album         TEXT,
    album_id      INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    track_no      INTEGER,
    disc_no       INTEGER,
    year          INTEGER,
    genre         TEXT,
    duration      REAL,
    compilation   INTEGER NOT NULL DEFAULT 0,
    scanned_at    INTEGER NOT NULL
  );
  CREATE INDEX tracks_album ON tracks(album_id, disc_no, track_no);
  CREATE INDEX tracks_artist ON tracks(artist COLLATE NOCASE);
  CREATE INDEX tracks_genre ON tracks(genre COLLATE NOCASE);
  CREATE INDEX tracks_year ON tracks(year);

  CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, artist, album, genre,
    content='tracks', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, title, artist, album, genre)
    VALUES (new.id, new.title, new.artist || ' ' || coalesce(new.album_artist, ''), coalesce(new.album, ''), coalesce(new.genre, ''));
  END;
  CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre)
    VALUES ('delete', old.id, old.title, old.artist || ' ' || coalesce(old.album_artist, ''), coalesce(old.album, ''), coalesce(old.genre, ''));
  END;
  CREATE TRIGGER tracks_au AFTER UPDATE OF title, artist, album_artist, album, genre ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre)
    VALUES ('delete', old.id, old.title, old.artist || ' ' || coalesce(old.album_artist, ''), coalesce(old.album, ''), coalesce(old.genre, ''));
    INSERT INTO tracks_fts(rowid, title, artist, album, genre)
    VALUES (new.id, new.title, new.artist || ' ' || coalesce(new.album_artist, ''), coalesce(new.album, ''), coalesce(new.genre, ''));
  END;

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // WAL erlaubt viele gleichzeitige Leser, während ein Scan schreibt.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < migrations.length; version++) {
    db.transaction(() => {
      db.exec(migrations[version]!);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}
