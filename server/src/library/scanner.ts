import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { setMeta, type DB } from '../db.js';
import { WebDavError, type NextcloudClient, type RemoteEntry } from '../nextcloud/webdav.js';
import { rebuildAlbums } from './albums.js';
import { extractMetadata, searchExtra, tagSpan, type TrackMeta } from './metadata.js';
import { basename, coverRank, dirname, isAudioFile } from './pathMeta.js';
import { foldValue } from './text.js';

/** So viel vom Dateianfang lesen wir zuerst für Tags; reicht für ID3v2, FLAC und Ogg ohne großes Cover. */
export const HEAD_BYTES = 256 * 1024;
/** Größere Tag-Blöcke (meist wegen eines eingebetteten Covers) werden bis zu dieser Größe nachgeladen. */
export const MAX_TAG_BYTES = 8 * 1024 * 1024;
const WRITE_BATCH = 50;
/**
 * Fehlen auf einmal mehr Titel als das (mindestens REMOVAL_MIN, sonst dieser Anteil der Bibliothek),
 * oder ist ein ganzer Musikordner leer, entfernt der Scan nichts, bis es in der Verwaltung bestätigt wird.
 * So löscht ein kurz nicht eingehängter Speicher nicht Favoriten und Weiterhören aller Hörer.
 */
export const REMOVAL_MIN = 20;
export const REMOVAL_SHARE = 0.2;

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
  /** Titel, die in der Nextcloud fehlen, aber zur Sicherheit nicht entfernt wurden */
  heldBack: number;
  /** Warum der Scan abgebrochen ist, oder bei einzelnen unlesbaren Dateien die erste Ursache */
  lastError: string | null;
}

interface FolderCover {
  path: string;
  etag: string;
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
    heldBack: 0,
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

  /**
   * Startet einen Scan; läuft schon einer, wird dessen Promise zurückgegeben.
   * `removeMissing` entfernt fehlende Titel auch dann, wenn es ungewöhnlich viele sind.
   */
  scan(options: { removeMissing?: boolean } = {}): Promise<ScanStatus> {
    if (!this.current) {
      this.current = this.run(options.removeMissing ?? false).finally(() => {
        this.current = null;
      });
    }
    return this.current;
  }

  private async run(removeMissing: boolean): Promise<ScanStatus> {
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
      heldBack: 0,
      lastError: null,
    };
    try {
      await this.sync(removeMissing);
      // Zurückgehaltene Titel brauchen eine Entscheidung; bis dahin gilt der Scan nicht als erfolgreich.
      this.status.state = this.status.heldBack > 0 ? 'failed' : 'idle';
      if (this.status.heldBack === 0) setMeta(this.db, 'lastScanAt', new Date().toISOString());
    } catch (error) {
      this.status.state = 'failed';
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.log.error({ err: error }, 'Bibliotheks-Scan fehlgeschlagen');
    }
    this.status.finishedAt = new Date().toISOString();
    this.log.info({ scan: this.status }, 'Bibliotheks-Scan beendet');
    return this.getStatus();
  }

  private async walk(): Promise<{ files: RemoteEntry[]; covers: Map<string, FolderCover>; unreadable: string[] }> {
    const files: RemoteEntry[] = [];
    const bestCover = new Map<string, FolderCover & { rank: number }>();
    const unreadable: string[] = [];
    const roots = new Set(this.client.roots);
    const queue = [...this.client.roots];
    while (queue.length > 0) {
      const batch = queue.splice(0, this.concurrency);
      await Promise.all(
        batch.map(async (dir) => {
          let entries: RemoteEntry[];
          try {
            entries = await this.client.list(dir);
          } catch (error) {
            // Fehlt ein Musikordner, bricht der Scan ab, statt dessen Titel zu löschen.
            if (roots.has(dir)) {
              if (error instanceof WebDavError && error.status === 404) {
                throw new Error(`Musikordner nicht gefunden: ${this.client.absolute(dir)} (NEXTCLOUD_MUSIC_PATH prüfen)`);
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
              // Versteckte Ordner (.trash, .git …) auslassen; ihre Eltern sind schon geprüft.
              if (!basename(entry.path).startsWith('.')) queue.push(entry.path);
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
              bestCover.set(folder, { path: entry.path, etag: entry.etag, rank });
            }
          }
        }),
      );
    }
    const covers = new Map([...bestCover].map(([folder, { path, etag }]) => [folder, { path, etag }]));
    return { files, covers, unreadable };
  }

  private async sync(removeMissing: boolean): Promise<void> {
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
    const setSearchExtra = this.db.prepare('UPDATE tracks SET search_extra = ? WHERE id = ? AND search_extra IS NOT ?');
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
        const extra = searchExtra(meta.tags);
        setSearchExtra.run(extra, id, extra);
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
    let gone = [...known.keys()].filter((path) => !remotePaths.has(path) && !isUnderUnreadable(path));
    const emptyRoots = this.client.roots.filter((root) => {
      const inRoot = (path: string) => root === '' || path.startsWith(`${root}/`);
      return !files.some((file) => inRoot(file.path)) && [...known.keys()].some(inRoot);
    });
    const limit = Math.max(REMOVAL_MIN, Math.floor(known.size * REMOVAL_SHARE));
    let keepCovers = isUnderUnreadable;
    if (!removeMissing && gone.length > 0 && (gone.length > limit || emptyRoots.length > 0)) {
      this.status.heldBack = gone.length;
      this.status.lastError = emptyRoots.length
        ? `Musikordner ist leer: ${emptyRoots.map((root) => this.client.absolute(root)).join(', ')}. ` +
          `${gone.length} Titel wurden nicht entfernt, bis das in der Verwaltung bestätigt wird.`
        : `${gone.length} von ${known.size} Titeln fehlen in der Nextcloud. ` +
          'Sie wurden zur Sicherheit nicht entfernt, bis das in der Verwaltung bestätigt wird.';
      this.log.warn({ missing: gone.length, known: known.size, emptyRoots }, 'Scan entfernt fehlende Titel nicht ohne Bestätigung');
      gone = [];
      keepCovers = () => true;
    }
    const remove = this.db.prepare('DELETE FROM tracks WHERE path = ?');
    this.db.transaction(() => {
      for (const path of gone) remove.run(path);
    })();
    this.status.removed = gone.length;

    this.saveCovers(covers, keepCovers);
    rebuildAlbums(this.db);
    // Bilder, auf die kein Titel mehr zeigt, wegräumen, ebenso Vorschaubilder verschwundener Quellen.
    this.db.prepare('DELETE FROM covers WHERE id NOT IN (SELECT cover_id FROM tracks WHERE cover_id IS NOT NULL)').run();
    this.db
      .prepare(
        `DELETE FROM cover_thumbs WHERE source NOT IN (SELECT 'file:' || path FROM folder_covers)
           AND source NOT IN (SELECT 'cover:' || id FROM covers)`,
      )
      .run();
  }

  private saveCovers(covers: Map<string, FolderCover>, isUnderUnreadable: (path: string) => boolean): void {
    const upsert = this.db.prepare(
      `INSERT INTO folder_covers (folder, path, etag) VALUES (?, ?, ?)
       ON CONFLICT(folder) DO UPDATE SET path = excluded.path, etag = excluded.etag`,
    );
    const remove = this.db.prepare('DELETE FROM folder_covers WHERE folder = ?');
    const known = this.db.prepare('SELECT folder, path FROM folder_covers').all() as Array<{ folder: string; path: string }>;
    this.db.transaction(() => {
      for (const { folder, path } of known) if (!covers.has(folder) && !isUnderUnreadable(path)) remove.run(folder);
      for (const [folder, { path, etag }] of covers) upsert.run(folder, path, etag || null);
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
