import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileStem, parsePath, type PathMeta } from './library/pathMeta.js';
import { foldValue, sortKey } from './library/text.js';

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
  // Eingebettete Cover aus den Musikdateien, gleiche Bilder nur einmal gespeichert.
  `
  CREATE TABLE covers (
    id    INTEGER PRIMARY KEY,
    hash  TEXT NOT NULL UNIQUE,
    mime  TEXT NOT NULL,
    data  BLOB NOT NULL
  );
  ALTER TABLE tracks ADD COLUMN cover_id INTEGER REFERENCES covers(id) ON DELETE SET NULL;
  ALTER TABLE albums ADD COLUMN cover_id INTEGER REFERENCES covers(id) ON DELETE SET NULL;
  CREATE INDEX tracks_cover ON tracks(cover_id);
  -- Bisher wurden Cover beim Scan übersprungen: alle Titel beim nächsten Scan einmal neu lesen.
  UPDATE tracks SET etag = '';
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
  // Regeln, die eigene Alben automatisch füllen ("Titel enthält Predigt").
  `
  CREATE TABLE album_rules (
    id         INTEGER PRIMARY KEY,
    album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    field      TEXT NOT NULL,
    op         TEXT NOT NULL,
    value      TEXT NOT NULL,
    move       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX album_rules_album ON album_rules(album_id);

  -- Titel, die der Admin aus einem Album entfernt hat, obwohl eine Regel sie hineinnimmt.
  CREATE TABLE manual_album_removed (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    path     TEXT NOT NULL,
    PRIMARY KEY (album_id, path)
  ) WITHOUT ROWID;
  `,
  // Regeln als verschachtelte Bedingung (UND/ODER-Gruppen) statt einer einzelnen Bedingung.
  `
  CREATE TABLE album_rules_new (
    id         INTEGER PRIMARY KEY,
    album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    condition  TEXT NOT NULL,
    move       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  INSERT INTO album_rules_new (id, album_id, condition, move, created_at)
    SELECT id, album_id, json_object('field', field, 'op', op, 'value', value), move, created_at FROM album_rules;
  DROP TABLE album_rules;
  ALTER TABLE album_rules_new RENAME TO album_rules;
  CREATE INDEX album_rules_album ON album_rules(album_id);
  `,
  // Frei definierbare Kategorien ("Interpreten", "Musik" ...): alle Tags je Titel und die Zuordnung der Kategorien dazu.
  `
  -- Jeder Tag-Wert eines Titels, auch eigene Felder (TXXX, Vorbis). vkey ist der Vergleichsschlüssel (fold).
  CREATE TABLE track_tags (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    value    TEXT NOT NULL,
    vkey     TEXT NOT NULL
  );
  CREATE INDEX track_tags_track ON track_tags(track_id);
  CREATE INDEX track_tags_tag ON track_tags(tag, vkey);
  -- Vorbelegung aus den bekannten Spalten, bis der nächste Scan alle Felder liest.
  INSERT INTO track_tags (track_id, tag, value, vkey) SELECT id, 'artist', artist, fold(artist) FROM tracks;
  INSERT INTO track_tags (track_id, tag, value, vkey)
    SELECT id, 'albumartist', album_artist, fold(album_artist) FROM tracks WHERE album_artist IS NOT NULL;
  INSERT INTO track_tags (track_id, tag, value, vkey) SELECT id, 'album', album, fold(album) FROM tracks WHERE album IS NOT NULL;
  INSERT INTO track_tags (track_id, tag, value, vkey) SELECT id, 'genre', genre, fold(genre) FROM tracks WHERE genre IS NOT NULL;
  INSERT INTO track_tags (track_id, tag, value, vkey)
    SELECT id, 'year', CAST(year AS TEXT), CAST(year AS TEXT) FROM tracks WHERE year IS NOT NULL;
  UPDATE tracks SET etag = '';

  CREATE TABLE categories (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL UNIQUE,
    position     INTEGER NOT NULL,
    in_nav       INTEGER NOT NULL DEFAULT 1,
    -- 1: nur die zusammengefassten Werte zeigen, alle anderen ausblenden
    grouped_only INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );
  -- Aus welchen Tag-Feldern eine Kategorie ihre Werte nimmt
  CREATE TABLE category_fields (
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    PRIMARY KEY (category_id, tag)
  ) WITHOUT ROWID;
  -- Zusammengefasste Werte: "Musik" <- Musik, Lied
  CREATE TABLE category_groups (
    id          INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    position    INTEGER NOT NULL
  );
  CREATE INDEX category_groups_category ON category_groups(category_id);
  CREATE TABLE category_group_values (
    group_id INTEGER NOT NULL REFERENCES category_groups(id) ON DELETE CASCADE,
    value    TEXT NOT NULL,
    vkey     TEXT NOT NULL,
    PRIMARY KEY (group_id, vkey)
  ) WITHOUT ROWID;

  INSERT INTO categories (id, name, slug, position, in_nav, created_at) VALUES
    (1, 'Interpreten', 'interpreten', 0, 1, unixepoch() * 1000),
    (2, 'Genre', 'genre', 1, 0, unixepoch() * 1000);
  INSERT INTO category_fields (category_id, tag) VALUES (1, 'artist'), (1, 'albumartist'), (2, 'genre');
  `,
  // Benutzer, Sitzungen und OIDC-Gruppen. Der lokale Admin meldet sich mit Passwort an,
  // alle anderen über OIDC; ihre Rolle ergibt sich aus den freigeschalteten Gruppen.
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL,
    username      TEXT,
    password_hash TEXT,
    issuer        TEXT,
    subject       TEXT,
    name          TEXT NOT NULL,
    email         TEXT,
    -- NULL: in keiner freigeschalteten Gruppe, also kein Zugang
    role          TEXT,
    groups        TEXT NOT NULL DEFAULT '[]',
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE UNIQUE INDEX users_local ON users(username) WHERE kind = 'local';
  CREATE UNIQUE INDEX users_oidc ON users(issuer, subject) WHERE kind = 'oidc';

  -- Nur ein Hash der Sitzungs-ID wird gespeichert, damit ein Datenbank-Backup keine gültigen Cookies enthält.
  CREATE TABLE sessions (
    id_hash      TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Gruppen aus dem Identity Provider: beim Login gesehen oder vom Admin eingetragen.
  CREATE TABLE oidc_groups (
    name         TEXT PRIMARY KEY,
    enabled      INTEGER NOT NULL DEFAULT 0,
    role         TEXT NOT NULL DEFAULT 'listener',
    last_seen_at INTEGER
  ) WITHOUT ROWID;

  -- Laufende OIDC-Anmeldungen zwischen Weiterleitung und Rückkehr.
  CREATE TABLE oidc_logins (
    state      TEXT PRIMARY KEY,
    verifier   TEXT NOT NULL,
    nonce      TEXT NOT NULL,
    return_to  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  `,
  // Dateiname (ohne Endung) als Tag-Feld für Kategorien; neue Scans schreiben ihn selbst.
  `
  INSERT INTO track_tags (track_id, tag, value, vkey)
    SELECT id, 'filename', file_stem(path), fold(file_stem(path)) FROM tracks WHERE file_stem(path) <> '';
  `,
  // Hörer-Funktionen: Datum und Predigt-Infos an Alben, eigene Tag-Felder in der Suche,
  // Favoriten und Hörfortschritt je Benutzer.
  `
  -- Datum aus dem Ordnernamen (JJJJ-MM-TT) und Angaben zur Predigt; beim nächsten rebuildAlbums gefüllt.
  ALTER TABLE albums ADD COLUMN date TEXT;
  ALTER TABLE albums ADD COLUMN speaker TEXT;
  ALTER TABLE albums ADD COLUMN passage TEXT;
  ALTER TABLE albums ADD COLUMN description TEXT;
  CREATE INDEX albums_date ON albums(date);
  ALTER TABLE album_overrides ADD COLUMN speaker TEXT;
  ALTER TABLE album_overrides ADD COLUMN passage TEXT;
  ALTER TABLE album_overrides ADD COLUMN description TEXT;

  -- Werte eigener Tag-Felder (Sprecher, Bibelstelle, Dateiname ...) für die Volltextsuche.
  ALTER TABLE tracks ADD COLUMN search_extra TEXT;
  UPDATE tracks SET search_extra = (
    SELECT group_concat(value, ' ') FROM track_tags
    WHERE track_id = tracks.id AND tag NOT IN ('artist', 'albumartist', 'album', 'genre', 'year')
  );
  DROP TRIGGER tracks_ai;
  DROP TRIGGER tracks_ad;
  DROP TRIGGER tracks_au;
  DROP TABLE tracks_fts;
  CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, artist, album, genre, search_extra,
    content='tracks', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, title, artist, album, genre, search_extra)
    VALUES (new.id, new.title, new.artist || ' ' || coalesce(new.album_artist, ''), coalesce(new.album, ''), coalesce(new.genre, ''),
            coalesce(new.search_extra, ''));
  END;
  CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, search_extra)
    VALUES ('delete', old.id, old.title, old.artist || ' ' || coalesce(old.album_artist, ''), coalesce(old.album, ''),
            coalesce(old.genre, ''), coalesce(old.search_extra, ''));
  END;
  CREATE TRIGGER tracks_au AFTER UPDATE OF title, artist, album_artist, album, genre, search_extra ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, search_extra)
    VALUES ('delete', old.id, old.title, old.artist || ' ' || coalesce(old.album_artist, ''), coalesce(old.album, ''),
            coalesce(old.genre, ''), coalesce(old.search_extra, ''));
    INSERT INTO tracks_fts(rowid, title, artist, album, genre, search_extra)
    VALUES (new.id, new.title, new.artist || ' ' || coalesce(new.album_artist, ''), coalesce(new.album, ''), coalesce(new.genre, ''),
            coalesce(new.search_extra, ''));
  END;
  INSERT INTO tracks_fts(rowid, title, artist, album, genre, search_extra)
    SELECT id, title, artist || ' ' || coalesce(album_artist, ''), coalesce(album, ''), coalesce(genre, ''), coalesce(search_extra, '')
    FROM tracks;

  -- Favoriten je Benutzer: Titel oder Alben (kind 'track' / 'album').
  CREATE TABLE favorites (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    item_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, item_id)
  ) WITHOUT ROWID;

  -- Zuletzt gehört und Stelle zum Weiterhören, je Benutzer und Titel.
  CREATE TABLE listening (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position   REAL NOT NULL,
    -- Länge, die der Browser gemessen hat; genauer als der Scan, der nur den Dateianfang liest
    duration   REAL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id)
  ) WITHOUT ROWID;
  CREATE INDEX listening_recent ON listening(user_id, updated_at);
  CREATE INDEX listening_track ON listening(track_id);
  `,
  `
  -- Eingebettete Bilder, die kein Rasterbild sind (z. B. SVG), nicht mehr ausliefern.
  DELETE FROM covers WHERE mime NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif');
  `,
  `
  -- Favoriten verschwinden mit ihrem Titel oder Album. Sonst zeigte ein Favorit, wenn SQLite die ID
  -- später neu vergibt, auf ein ganz anderes Album.
  DELETE FROM favorites WHERE kind = 'album' AND item_id NOT IN (SELECT id FROM albums);
  DELETE FROM favorites WHERE kind = 'track' AND item_id NOT IN (SELECT id FROM tracks);
  CREATE TRIGGER favorites_album_gone AFTER DELETE ON albums BEGIN
    DELETE FROM favorites WHERE kind = 'album' AND item_id = old.id;
  END;
  CREATE TRIGGER favorites_track_gone AFTER DELETE ON tracks BEGIN
    DELETE FROM favorites WHERE kind = 'track' AND item_id = old.id;
  END;
  `,
  `
  -- ETag des Ordnerbilds, damit Vorschaubilder bei einer Änderung neu entstehen (füllt der nächste Scan).
  ALTER TABLE folder_covers ADD COLUMN etag TEXT;
  CREATE INDEX folder_covers_path ON folder_covers(path);
  -- Verkleinerte Cover (WebP), je Quelle: "file:<Pfad>" für Ordnerbilder, "cover:<id>" für eingebettete.
  -- version ist ETag bzw. Hash der Quelle; passt sie nicht mehr, wird neu gerechnet.
  CREATE TABLE cover_thumbs (
    source     TEXT PRIMARY KEY,
    version    TEXT NOT NULL,
    data       BLOB NOT NULL,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  `,
  `
  -- Verdecktes Scoring (library/popularity.ts): Wiedergaben je Titel über alle Hörer, mit Verfall.
  CREATE TABLE track_popularity (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    score    REAL NOT NULL
  );
  -- Wann eine Person einen Titel zuletzt gezählt bekam, für die Sperrfrist.
  CREATE TABLE track_plays (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    counted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id)
  ) WITHOUT ROWID;
  CREATE INDEX track_plays_track ON track_plays(track_id);
  `,
  `
  -- Schlüssel je Benutzer für offline gespeicherte Titel (AES-256, siehe offline.ts). NULL: noch keiner
  -- oder zurückgesetzt, dann sind alte Offline-Kopien nicht mehr zu entschlüsseln.
  ALTER TABLE users ADD COLUMN offline_key BLOB;
  `,
  // Smarte Zuordnung: Titel über die Nextcloud-Datei-ID wiedererkennen, Album je Titel merken,
  // Sortierschlüssel (Umlaute, Zahlen) und das Datum, an dem eine Datei in die Nextcloud kam.
  `
  ALTER TABLE tracks ADD COLUMN file_id TEXT;
  CREATE INDEX tracks_file_id ON tracks(file_id);
  -- Upload-Zeit bzw. Änderungsdatum in der Nextcloud (ms); bis zum nächsten Scan das bisherige "Neu hinzugefügt".
  ALTER TABLE tracks ADD COLUMN added_at INTEGER;
  UPDATE tracks SET added_at = coalesce((SELECT created_at FROM albums WHERE id = tracks.album_id), scanned_at);
  -- Schlüssel des automatischen Albums (library/albums.ts groupTracks), füllt rebuildAlbums.
  ALTER TABLE tracks ADD COLUMN album_key TEXT;
  -- 1: Albumname aus dem Tag, 0: aus dem Ordner abgeleitet, NULL: unbekannt (vor dem nächsten Lesen der Datei)
  ALTER TABLE tracks ADD COLUMN album_tagged INTEGER;
  -- Sortierschlüssel (library/text.ts sortKey) und die Sortier-Tags der Dateien für Alben
  ALTER TABLE tracks ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
  ALTER TABLE tracks ADD COLUMN sort_artist TEXT NOT NULL DEFAULT '';
  ALTER TABLE tracks ADD COLUMN album_sort TEXT;
  ALTER TABLE tracks ADD COLUMN album_artist_sort TEXT;
  UPDATE tracks SET sort_title = sort_key(title), sort_artist = sort_key(artist);
  CREATE INDEX tracks_sort ON tracks(sort_artist, sort_title);
  ALTER TABLE albums ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
  ALTER TABLE albums ADD COLUMN sort_artist TEXT NOT NULL DEFAULT '';
  UPDATE albums SET sort_title = sort_key(title), sort_artist = sort_key(artist);
  CREATE INDEX albums_sort_title ON albums(sort_title);
  CREATE INDEX albums_sort_artist ON albums(sort_artist, year, sort_title);
  CREATE INDEX albums_created ON albums(created_at);
  -- Einmal alle Dateien neu lesen: Sortier-Tags, ob der Albumname aus dem Tag kommt, Sprecher aus dem Dateinamen.
  UPDATE tracks SET etag = '';

  -- Kategorie "Sprecher" aus den Predigt-Feldern; im Menü nur, wenn es schon Sprecher gibt.
  INSERT INTO categories (name, slug, position, in_nav, created_at)
    SELECT 'Sprecher', 'sprecher', coalesce((SELECT max(position) + 1 FROM categories), 0),
           EXISTS (SELECT 1 FROM track_tags WHERE tag IN ('sprecher', 'speaker', 'prediger', 'predigerin', 'referent', 'referentin')),
           unixepoch() * 1000
    WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'sprecher');
  INSERT INTO category_fields (category_id, tag)
    SELECT c.id, t.value FROM categories c, json_each('["sprecher","speaker","prediger","predigerin","referent","referentin"]') t
    WHERE c.slug = 'sprecher' AND NOT EXISTS (SELECT 1 FROM category_fields WHERE category_id = c.id);
  `,
  // Regelwerk für Aufnahmen (library/structure.ts): Anzeige-Titel, Inhalt und Interpret je Titel, Art je Album.
  `
  -- Aus dem Regelwerk abgeleitet (füllt rebuildAlbums); NULL: gescannten Wert zeigen
  ALTER TABLE tracks ADD COLUMN display_title TEXT;
  ALTER TABLE tracks ADD COLUMN display_artist TEXT;
  -- Inhalt einer Aufnahme ("Lied", "Predigt") aus dem Dateinamen
  ALTER TABLE tracks ADD COLUMN content TEXT;
  -- 1: Titel aus einem Tag, 0: aus dem Dateinamen abgeleitet, NULL: unbekannt (vor dem nächsten Lesen)
  ALTER TABLE tracks ADD COLUMN title_tagged INTEGER;
  -- Art einer Aufnahme ("Gottesdienst", "Bibelstunde"); NULL bei Musik
  ALTER TABLE albums ADD COLUMN recording TEXT;
  CREATE INDEX albums_recording ON albums(recording, date);
  -- 1: vom Regelwerk abgeleiteter Wert (Inhalt, Sprecher), den rebuildAlbums selbst pflegt
  ALTER TABLE track_tags ADD COLUMN derived INTEGER NOT NULL DEFAULT 0;

  DROP TRIGGER tracks_ai;
  DROP TRIGGER tracks_ad;
  DROP TRIGGER tracks_au;
  DROP TABLE tracks_fts;
  CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, artist, album, genre, search_extra, structure,
    content='', contentless_delete=1,
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, title, artist, album, genre, search_extra, structure)
    VALUES (new.id, new.title, new.artist || ' ' || coalesce(new.album_artist, ''), coalesce(new.album, ''), coalesce(new.genre, ''),
            coalesce(new.search_extra, ''),
            coalesce(new.display_title, '') || ' ' || coalesce(new.content, '') || ' ' || coalesce(new.display_artist, ''));
  END;
  CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
    DELETE FROM tracks_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER tracks_au AFTER UPDATE OF title, artist, album_artist, album, genre, search_extra, display_title, content, display_artist
  ON tracks BEGIN
    DELETE FROM tracks_fts WHERE rowid = old.id;
    INSERT INTO tracks_fts(rowid, title, artist, album, genre, search_extra, structure)
    VALUES (new.id, new.title, new.artist || ' ' || coalesce(new.album_artist, ''), coalesce(new.album, ''), coalesce(new.genre, ''),
            coalesce(new.search_extra, ''),
            coalesce(new.display_title, '') || ' ' || coalesce(new.content, '') || ' ' || coalesce(new.display_artist, ''));
  END;
  INSERT INTO tracks_fts(rowid, title, artist, album, genre, search_extra, structure)
    SELECT id, title, artist || ' ' || coalesce(album_artist, ''), coalesce(album, ''), coalesce(genre, ''), coalesce(search_extra, ''), ''
    FROM tracks;

  -- Kategorie "Inhalt" (Lied, Predigt …) aus dem Regelwerk, zunächst nicht im Menü
  INSERT INTO categories (name, slug, position, in_nav, created_at)
    SELECT 'Inhalt', 'inhalt', coalesce((SELECT max(position) + 1 FROM categories), 0), 0, unixepoch() * 1000
    WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'inhalt');
  INSERT INTO category_fields (category_id, tag)
    SELECT id, 'inhalt' FROM categories WHERE slug = 'inhalt' AND NOT EXISTS (SELECT 1 FROM category_fields WHERE category_id = categories.id);

  -- "Lied - Großer Gott" in einem Gottesdienst-Ordner ergab bisher den Interpreten "Lied"; einmal neu lesen.
  UPDATE tracks SET etag = '';
  `,
  `
  -- Korrekturen einzelner Titel aus der Verwaltung (Titelname, Sprecher), je Pfad wie die übrigen
  -- Korrekturen. Sie gehen allem vor, was Dateien und Regelwerk ergeben (queries.ts TRACK_COLUMNS).
  CREATE TABLE track_overrides (
    path    TEXT PRIMARY KEY,
    title   TEXT,
    speaker TEXT
  ) WITHOUT ROWID;
  -- Hochgeladenes Titelbild eines Albums; liegt wie eingebettete Bilder in covers.
  ALTER TABLE album_overrides ADD COLUMN cover_id INTEGER REFERENCES covers(id) ON DELETE SET NULL;
  -- Wer hat in der Verwaltung was geändert (library/changes.ts).
  CREATE TABLE changes (
    id        INTEGER PRIMARY KEY,
    at        INTEGER NOT NULL,
    user_id   INTEGER,
    user_name TEXT NOT NULL,
    action    TEXT NOT NULL,
    target    TEXT,
    album_id  INTEGER
  );
  CREATE INDEX changes_album ON changes(album_id, id);
  `,
  `
  -- Die Dauer von MP3 und Ogg kam bisher nur aus dem gelesenen Dateianfang (wenige Sekunden je Titel); einmal neu lesen.
  UPDATE tracks SET etag = ''
    WHERE mime IN ('audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/opus', 'application/ogg')
       OR lower(path) LIKE '%.mp3' OR lower(path) LIKE '%.ogg' OR lower(path) LIKE '%.oga' OR lower(path) LIKE '%.opus';
  `,
  `
  -- Suchbegriffe, nach denen jemand einen Treffer geöffnet hat (library/searches.ts). Je Person und
  -- Begriff eine Zeile, damit "Häufig gesucht" Personen zählt statt Anfragen; nach 90 Tagen gelöscht.
  CREATE TABLE search_log (
    key     TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text    TEXT NOT NULL,
    at      INTEGER NOT NULL,
    PRIMARY KEY (key, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX search_log_at ON search_log(at);
  CREATE INDEX search_log_user ON search_log(user_id);
  `,
  `
  -- Ersetzungen für Tippfehler in Titeln und Albumnamen (library/replacements.ts), z. B. "Tema" → "Thema".
  CREATE TABLE title_replacements (
    id          INTEGER PRIMARY KEY,
    search      TEXT NOT NULL,
    replacement TEXT NOT NULL,
    whole_word  INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  );
  -- Titel aus Datei und Regelwerk vor den Ersetzungen (für deren Vorschau); NULL: wie title. Füllt rebuildAlbums.
  ALTER TABLE tracks ADD COLUMN raw_title TEXT;
  UPDATE tracks SET raw_title = display_title;
  `,
  `
  -- Policies im Regelwerk (library/policies.ts): Player je Titel ('sermon' Predigt-Player, 'music' Musik-Player,
  -- NULL: keine Policy entscheidet, dann nach Länge). Füllt rebuildAlbums.
  ALTER TABLE tracks ADD COLUMN playback TEXT;
  -- 1: gilt laut Policies als Predigt (liefert Sprecher und Bibelstelle des Albums)
  ALTER TABLE tracks ADD COLUMN sermon INTEGER NOT NULL DEFAULT 0;
  -- Was die Policies ohne Korrektur ergeben, mit Namen der Policy (JSON, für die Verwaltung)
  ALTER TABLE tracks ADD COLUMN policy TEXT;
  -- Korrekturen je Titel: gilt als Predigt (1/0) und Player; NULL: nach den Policies
  ALTER TABLE track_overrides ADD COLUMN sermon INTEGER;
  ALTER TABLE track_overrides ADD COLUMN player TEXT;
  -- Art eines Albums von Hand ("Bibelstunde"); '' heißt keine Art, NULL: nach dem Regelwerk
  ALTER TABLE album_overrides ADD COLUMN recording TEXT;
  `,
  // Interpreten zusammenführen (library/artists.ts): ein Name wird überall als ein anderer geführt.
  `
  CREATE TABLE artist_aliases (
    -- artistKey(source): Groß-/Kleinschreibung, Akzente und Satzzeichen spielen keine Rolle
    source_key TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    target     TEXT NOT NULL
  ) WITHOUT ROWID;
  -- Interpret aus Dateiname bzw. Regelwerk vor der Zusammenführung (NULL: der gescannte); display_artist ist danach
  ALTER TABLE tracks ADD COLUMN raw_artist TEXT;
  UPDATE tracks SET raw_artist = display_artist;
  `,
  // Ohne Interpreten und ohne Tags: Titel, Album und alle Zuordnungen kommen aus Ordnern und Dateinamen,
  // Kategorien aus den Feldern, die das Regelwerk daraus liest (library/fields.ts).
  `
  DROP TABLE artist_aliases;

  DROP TRIGGER tracks_ai;
  DROP TRIGGER tracks_ad;
  DROP TRIGGER tracks_au;
  DROP TABLE tracks_fts;
  DROP TRIGGER albums_ai;
  DROP TRIGGER albums_ad;
  DROP TRIGGER albums_au;
  DROP TABLE albums_fts;
  DROP INDEX tracks_artist;
  DROP INDEX tracks_genre;
  DROP INDEX tracks_sort;
  DROP INDEX albums_artist;
  DROP INDEX albums_genre;
  DROP INDEX albums_sort_artist;

  -- Sprecher je Titel aus dem Dateinamen ("Predigt - Titel - Name"), füllt rebuildAlbums
  ALTER TABLE tracks RENAME COLUMN display_artist TO speaker;
  UPDATE tracks SET speaker = NULL;
  ALTER TABLE tracks DROP COLUMN artist;
  ALTER TABLE tracks DROP COLUMN album_artist;
  ALTER TABLE tracks DROP COLUMN raw_artist;
  ALTER TABLE tracks DROP COLUMN genre;
  ALTER TABLE tracks DROP COLUMN compilation;
  ALTER TABLE tracks DROP COLUMN sort_artist;
  ALTER TABLE tracks DROP COLUMN album_sort;
  ALTER TABLE tracks DROP COLUMN album_artist_sort;
  ALTER TABLE tracks DROP COLUMN album_tagged;
  ALTER TABLE tracks DROP COLUMN title_tagged;
  ALTER TABLE albums DROP COLUMN artist;
  ALTER TABLE albums DROP COLUMN genre;
  ALTER TABLE albums DROP COLUMN sort_artist;
  ALTER TABLE album_overrides DROP COLUMN artist;
  ALTER TABLE album_overrides DROP COLUMN genre;

  -- Was bisher aus den Tags kam, gleich aus dem Pfad; die Dauer und eingebettete Bilder bleiben.
  UPDATE tracks SET title = path_meta(path, 'title'), album = path_meta(path, 'album'), track_no = path_meta(path, 'trackNo'),
    disc_no = path_meta(path, 'discNo'), year = path_meta(path, 'year'),
    search_extra = (SELECT nullif(trim(coalesce(o.title, '') || ' ' || coalesce(o.speaker, '')), '') FROM track_overrides o WHERE o.path = tracks.path);
  UPDATE tracks SET sort_title = sort_key(coalesce(display_title, title));
  CREATE INDEX tracks_sort ON tracks(sort_title);
  DELETE FROM track_tags WHERE derived = 0;

  CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, album, search_extra, structure,
    content='', contentless_delete=1,
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, title, album, search_extra, structure)
    VALUES (new.id, new.title, coalesce(new.album, ''), coalesce(new.search_extra, ''),
            coalesce(new.display_title, '') || ' ' || coalesce(new.content, '') || ' ' || coalesce(new.speaker, ''));
  END;
  CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
    DELETE FROM tracks_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER tracks_au AFTER UPDATE OF title, album, search_extra, display_title, content, speaker ON tracks BEGIN
    DELETE FROM tracks_fts WHERE rowid = old.id;
    INSERT INTO tracks_fts(rowid, title, album, search_extra, structure)
    VALUES (new.id, new.title, coalesce(new.album, ''), coalesce(new.search_extra, ''),
            coalesce(new.display_title, '') || ' ' || coalesce(new.content, '') || ' ' || coalesce(new.speaker, ''));
  END;
  INSERT INTO tracks_fts(rowid, title, album, search_extra, structure)
    SELECT id, title, coalesce(album, ''), coalesce(search_extra, ''),
           coalesce(display_title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(speaker, '')
    FROM tracks;

  -- Alben: Titel und Sprecher durchsuchbar
  CREATE VIRTUAL TABLE albums_fts USING fts5(
    title, speaker,
    content='', contentless_delete=1,
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER albums_ai AFTER INSERT ON albums BEGIN
    INSERT INTO albums_fts(rowid, title, speaker) VALUES (new.id, new.title, coalesce(new.speaker, ''));
  END;
  CREATE TRIGGER albums_ad AFTER DELETE ON albums BEGIN
    DELETE FROM albums_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER albums_au AFTER UPDATE OF title, speaker ON albums BEGIN
    DELETE FROM albums_fts WHERE rowid = old.id;
    INSERT INTO albums_fts(rowid, title, speaker) VALUES (new.id, new.title, coalesce(new.speaker, ''));
  END;
  INSERT INTO albums_fts(rowid, title, speaker) SELECT id, title, coalesce(speaker, '') FROM albums;
  CREATE INDEX albums_sort_year ON albums(year, sort_title);

  -- Kategorien nur noch aus Feldern des Regelwerks; Kategorien aus Tag-Feldern (Interpreten, Genre) entfallen.
  UPDATE OR IGNORE category_fields SET tag = 'sprecher' WHERE tag IN ('speaker', 'prediger', 'predigerin', 'referent', 'referentin');
  DELETE FROM category_fields WHERE tag NOT IN ('art', 'inhalt', 'sprecher', 'anlass', 'jahr');
  DELETE FROM categories WHERE id NOT IN (SELECT category_id FROM category_fields);
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
  db.function('fold', { deterministic: true }, (value) => (typeof value === 'string' ? foldValue(value) : value));
  db.function('file_stem', { deterministic: true }, (value) => (typeof value === 'string' ? fileStem(value) : value));
  db.function('sort_key', { deterministic: true }, (value) => (typeof value === 'string' ? sortKey(value) : ''));
  // Titel, Album, Nummer oder Jahr aus dem Pfad (für die Migration weg von den Tags)
  db.function('path_meta', { deterministic: true }, (path, field) =>
    typeof path === 'string' && typeof field === 'string' ? (parsePath(path)[field as keyof PathMeta] ?? null) : null,
  );
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
