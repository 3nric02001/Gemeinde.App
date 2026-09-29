import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { setMeta, type DB } from '../db.js';
import { WebDavError, type NextcloudClient, type RemoteEntry } from '../nextcloud/webdav.js';
import { rebuildAlbums } from './albums.js';
import { extractMetadata, tagSpan, type TrackMeta } from './metadata.js';
import { coverRank, dirname, isAudioFile } from './pathMeta.js';
import { foldValue } from './text.js';

/** So viel vom Dateianfang lesen wir zuerst für Tags; reicht für ID3v2, FLAC und Ogg ohne großes Cover. */
export const HEAD_BYTES = 256 * 1024;
/** Größere Tag-Blöcke (meist wegen eines eingebetteten Covers) werden bis zu dieser Größe nachgeladen. */
export const MAX_TAG_BYTES = 8 * 1024 * 1024;
const WRITE_BATCH = 50;

export interface ScanStatus {
  state: 'idle' | 'running' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  /** Gefundene Audiodateien in der Nextcloud */
  filesSeen: number;
  /** Neue oder geänderte Dateien, deren Tags dieser Scan liest */
  toRead: number;
  /** Davon schon gelesen (auch fehlgeschlagene) */
  read: number;
  added: number;
  updated: number;
  removed: number;
  failed: number;
  /** Warum der Scan abgebrochen ist, oder bei einzelnen unlesbaren Dateien die erste Ursache */
  lastError: string | null;
}

interface ScanResult {
  entry: RemoteEntry;
  meta: TrackMeta;
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) await worker(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * Gleicht den Musikordner der Nextcloud mit der lokalen Datenbank ab.
 * Inkrementell: nur neue Dateien und solche mit geändertem ETag werden gelesen.
 */
export class LibraryScanner {
  private status: ScanStatus = {
    state: 'idle',
    startedAt: null,
    finishedAt: null,
    filesSeen: 0,
    toRead: 0,
    read: 0,
    added: 0,
    updated: 0,
    removed: 0,
    failed: 0,
    lastError: null,
  };
  private current: Promise<ScanStatus> | null = null;

  constructor(
    private readonly db: DB,
    private readonly client: NextcloudClient,
    private readonly log: FastifyBaseLogger,
    private readonly concurrency = 4,
  ) {}

  getStatus(): ScanStatus {
    return { ...this.status };
  }

  isRunning(): boolean {
    return this.current !== null;
  }

  /** Startet einen Scan; läuft schon einer, wird dessen Promise zurückgegeben. */
  scan(): Promise<ScanStatus> {
    if (!this.current) {
      this.current = this.run().finally(() => {
        this.current = null;
      });
    }
    return this.current;
  }

  private async run(): Promise<ScanStatus> {
    this.status = {
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      filesSeen: 0,
      toRead: 0,
      read: 0,
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
      lastError: null,
    };
    try {
      await this.sync();
      this.status.state = 'idle';
      setMeta(this.db, 'lastScanAt', new Date().toISOString());
    } catch (error) {
      this.status.state = 'failed';
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.log.error({ err: error }, 'Bibliotheks-Scan fehlgeschlagen');
    }
    this.status.finishedAt = new Date().toISOString();
    this.log.info({ scan: this.status }, 'Bibliotheks-Scan beendet');
    return this.getStatus();
  }

  private async walk(): Promise<{ files: RemoteEntry[]; covers: Map<string, string>; unreadable: string[] }> {
    const files: RemoteEntry[] = [];
    const bestCover = new Map<string, { path: string; rank: number }>();
    const unreadable: string[] = [];
    const queue = [''];
    while (queue.length > 0) {
      const batch = queue.splice(0, this.concurrency);
      await Promise.all(
        batch.map(async (dir) => {
          let entries: RemoteEntry[];
          try {
            entries = await this.client.list(dir);
          } catch (error) {
            // Ohne Wurzelordner gibt es nichts abzugleichen; das ist ein echter Fehler.
            if (dir === '') {
              if (error instanceof WebDavError && error.status === 404) {
                throw new Error(`Musikordner nicht gefunden: ${this.client.musicPath || '/'} (NEXTCLOUD_MUSIC_PATH prüfen)`);
              }
              throw error;
            }
            this.log.warn({ err: error, dir }, 'Ordner konnte nicht gelesen werden, wird übersprungen');
            this.status.lastError ??= error instanceof Error ? error.message : String(error);
            unreadable.push(dir);
            return;
          }
          for (const entry of entries) {
            if (entry.isDirectory) {
              if (!entry.path.split('/').some((segment) => segment.startsWith('.'))) queue.push(entry.path);
              continue;
            }
            if (isAudioFile(entry.path)) {
              files.push(entry);
              continue;
            }
            const rank = coverRank(entry.path);
            if (rank === undefined) continue;
            const folder = dirname(entry.path);
            const known = bestCover.get(folder);
            if (!known || rank < known.rank || (rank === known.rank && entry.path < known.path)) {
              bestCover.set(folder, { path: entry.path, rank });
            }
          }
        }),
      );
    }
    const covers = new Map([...bestCover].map(([folder, { path }]) => [folder, path]));
    return { files, covers, unreadable };
  }

  private async sync(): Promise<void> {
    const { files, covers, unreadable } = await this.walk();
    this.status.filesSeen = files.length;

    const known = new Map(
      (this.db.prepare('SELECT path, etag FROM tracks').all() as Array<{ path: string; etag: string }>).map((row) => [
        row.path,
        row.etag,
      ]),
    );
    const remotePaths = new Set(files.map((f) => f.path));
    const changed = files.filter((file) => known.get(file.path) !== file.etag || !file.etag);
    this.status.toRead = changed.length;
    if (changed.length > 0) this.log.info({ files: files.length, toRead: changed.length }, 'Bibliotheks-Scan liest Dateien');

    const upsert = this.db.prepare(`
      INSERT INTO tracks (path, etag, size, mime, title, artist, album_artist, album, track_no, disc_no, year, genre, duration, compilation, cover_id, scanned_at)
      VALUES (@path, @etag, @size, @mime, @title, @artist, @albumArtist, @album, @trackNo, @discNo, @year, @genre, @duration, @compilation, @coverId, @now)
      ON CONFLICT(path) DO UPDATE SET
        etag = excluded.etag, size = excluded.size, mime = excluded.mime, title = excluded.title,
        artist = excluded.artist, album_artist = excluded.album_artist, album = excluded.album,
        track_no = excluded.track_no, disc_no = excluded.disc_no, year = excluded.year, genre = excluded.genre,
        duration = excluded.duration, compilation = excluded.compilation, cover_id = excluded.cover_id,
        scanned_at = excluded.scanned_at
      RETURNING id
    `);
    const clearTags = this.db.prepare('DELETE FROM track_tags WHERE track_id = ?');
    const addTag = this.db.prepare('INSERT INTO track_tags (track_id, tag, value, vkey) VALUES (?, ?, ?, ?)');
    const saveCover = this.db.prepare(`
      INSERT INTO covers (hash, mime, data) VALUES (?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET mime = excluded.mime
      RETURNING id
    `);
    const flush = this.db.transaction((results: ScanResult[]) => {
      const now = Date.now();
      for (const { entry, meta } of results) {
        let coverId: number | null = null;
        if (meta.picture) {
          const hash = createHash('sha256').update(meta.picture.data).digest('hex');
          coverId = (saveCover.get(hash, meta.picture.mime, meta.picture.data) as { id: number }).id;
        }
        const { id } = upsert.get({
          path: entry.path,
          etag: entry.etag,
          size: entry.size,
          mime: entry.contentType ?? null,
          title: meta.title,
          artist: meta.artist,
          albumArtist: meta.albumArtist ?? null,
          album: meta.album ?? null,
          trackNo: meta.trackNo ?? null,
          discNo: meta.discNo ?? null,
          year: meta.year ?? null,
          genre: meta.genre ?? null,
          duration: meta.duration ?? null,
          compilation: meta.compilation ? 1 : 0,
          coverId,
          now,
        }) as { id: number };
        clearTags.run(id);
        for (const [tag, value] of meta.tags) addTag.run(id, tag, value, foldValue(value));
        if (known.has(entry.path)) this.status.updated++;
        else this.status.added++;
      }
    });

    let pending: ScanResult[] = [];
    await mapLimit(changed, this.concurrency, async (entry) => {
      try {
        const head = await this.readTags(entry.path);
        pending.push({ entry, meta: await extractMetadata(entry.path, head, entry.contentType) });
      } catch (error) {
        this.status.failed++;
        // Die erste Ursache reicht für die Anzeige in der Verwaltung; alle stehen im Log.
        this.status.lastError ??= `${entry.path}: ${error instanceof Error ? error.message : String(error)}`;
        this.log.warn({ err: error, path: entry.path }, 'Datei konnte nicht gelesen werden');
      }
      this.status.read++;
      if (pending.length >= WRITE_BATCH) {
        const batch = pending;
        pending = [];
        flush(batch);
      }
    });
    flush(pending);

    // Nur löschen, was sicher weg ist: Titel in unlesbaren Ordnern bleiben erhalten.
    const isUnderUnreadable = (path: string) => unreadable.some((dir) => path.startsWith(`${dir}/`));
    const gone = [...known.keys()].filter((path) => !remotePaths.has(path) && !isUnderUnreadable(path));
    const remove = this.db.prepare('DELETE FROM tracks WHERE path = ?');
    this.db.transaction(() => {
      for (const path of gone) remove.run(path);
    })();
    this.status.removed = gone.length;

    this.saveCovers(covers, isUnderUnreadable);
    rebuildAlbums(this.db);
    // Bilder, auf die kein Titel mehr zeigt, wegräumen.
    this.db.prepare('DELETE FROM covers WHERE id NOT IN (SELECT cover_id FROM tracks WHERE cover_id IS NOT NULL)').run();
  }

  private saveCovers(covers: Map<string, string>, isUnderUnreadable: (path: string) => boolean): void {
    const upsert = this.db.prepare(
      'INSERT INTO folder_covers (folder, path) VALUES (?, ?) ON CONFLICT(folder) DO UPDATE SET path = excluded.path',
    );
    const remove = this.db.prepare('DELETE FROM folder_covers WHERE folder = ?');
    const known = this.db.prepare('SELECT folder, path FROM folder_covers').all() as Array<{ folder: string; path: string }>;
    this.db.transaction(() => {
      for (const { folder, path } of known) if (!covers.has(folder) && !isUnderUnreadable(path)) remove.run(folder);
      for (const [folder, path] of covers) upsert.run(folder, path);
    })();
  }

  /** Liest den Dateianfang; ist der Tag-Block (z. B. wegen eines großen Covers) länger, wird nachgeladen. */
  private async readTags(path: string): Promise<Buffer> {
    let requested = HEAD_BYTES;
    let head = await this.client.readHead(path, requested);
    for (let round = 0; round < 4; round++) {
      const needed = tagSpan(head);
      // Datei kürzer als angefragt: mehr gibt es nicht.
      if (needed === undefined || needed <= head.length || head.length < requested) break;
      requested = Math.min(needed, MAX_TAG_BYTES);
      if (requested <= head.length) break;
      head = await this.client.readHead(path, requested);
    }
    return head;
  }
}
