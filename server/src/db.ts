import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/**
 * Jede Migration läuft genau einmal; der Stand steht in PRAGMA user_version.
 * Neue Migrationen nur anhängen, bestehende nie ändern.
 */
export const migrations: string[] = [
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
  // Manuelle Alben und Korrekturen an automatischen Alben. Alles, was ein Admin festlegt,
  // steht in eigenen Tabellen (nach Dateipfad bzw. Albumschlüssel) und übersteht so jeden Scan.
  // albums/album_tracks/tracks.album_id sind dagegen abgeleitet und werden von rebuildAlbums neu berechnet.
  `
  ALTER TABLE albums ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE albums ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

  -- Welche Titel in welchem Album stehen, in Abspielreihenfolge. Ein Titel kann in mehreren Alben sein;
  -- tracks.album_id bleibt sein Hauptalbum (für Cover und "Zum Album").
  CREATE TABLE album_tracks (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (album_id, track_id)
  ) WITHOUT ROWID;
  CREATE INDEX album_tracks_track ON album_tracks(track_id);
  INSERT INTO album_tracks (album_id, track_id, position)
    SELECT album_id, id, row_number() OVER (
      PARTITION BY album_id ORDER BY coalesce(disc_no, 1), track_no IS NULL, track_no, path
    ) FROM tracks WHERE album_id IS NOT NULL;

  -- Bestes Coverbild je Ordner, damit Alben auch außerhalb eines Scans neu gebildet werden können.
  CREATE TABLE folder_covers (
    folder TEXT PRIMARY KEY,
    path   TEXT NOT NULL
  ) WITHOUT ROWID;
  INSERT OR IGNORE INTO folder_covers (folder, path)
    SELECT substr(dir, 1, max(length(dir) - 1, 0)), cover_path
    FROM (SELECT rtrim(cover_path, replace(cover_path, '/', '')) AS dir, cover_path FROM albums WHERE cover_path IS NOT NULL);

  -- Vom Admin festgelegte Werte je Albumschlüssel; NULL heißt "automatisch".
  CREATE TABLE album_overrides (
    key    TEXT PRIMARY KEY,
    title  TEXT,
    artist TEXT,
    year   INTEGER,
    genre  TEXT,
    hidden INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;

  -- Titel, die ein Admin aus ihrem automatischen Album herausgenommen hat.
  CREATE TABLE track_exclusions (
    path      TEXT NOT NULL,
    album_key TEXT NOT NULL,
    PRIMARY KEY (path, album_key)
  ) WITHOUT ROWID;

  -- Inhalt manueller Alben. Über den Pfad statt die Titel-ID, damit ein Titel, der beim Scan
  -- kurz fehlt und wieder auftaucht, wieder im Album landet.
  CREATE TABLE manual_album_tracks (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    path     TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (album_id, path)
  ) WITHOUT ROWID;
  CREATE INDEX manual_album_tracks_path ON manual_album_tracks(path);

  -- Albumtitel durchsuchbar machen, auch wenn sie nicht aus den Tags stammen.
  CREATE VIRTUAL TABLE albums_fts USING fts5(
    title, artist,
    content='albums', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER albums_ai AFTER INSERT ON albums BEGIN
    INSERT INTO albums_fts(rowid, title, artist) VALUES (new.id, new.title, new.artist);
  END;
  CREATE TRIGGER albums_ad AFTER DELETE ON albums BEGIN
    INSERT INTO albums_fts(albums_fts, rowid, title, artist) VALUES ('delete', old.id, old.title, old.artist);
  END;
  CREATE TRIGGER albums_au AFTER UPDATE OF title, artist ON albums BEGIN
    INSERT INTO albums_fts(albums_fts, rowid, title, artist) VALUES ('delete', old.id, old.title, old.artist);
    INSERT INTO albums_fts(rowid, title, artist) VALUES (new.id, new.title, new.artist);
  END;
  INSERT INTO albums_fts(albums_fts) VALUES ('rebuild');
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
