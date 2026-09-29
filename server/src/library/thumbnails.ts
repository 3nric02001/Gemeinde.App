import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '../db.js';
import type { NextcloudClient } from '../nextcloud/webdav.js';
import type { CoverSource } from './queries.js';

/** Kantenlänge der Vorschau; reicht für Kacheln auf dem Handy (3x) und den großen Player. */
export const THUMB_SIZE = 640;
/** Größere Ordnerbilder werden nicht verkleinert, sondern wie bisher durchgereicht. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Schutz vor „Dekompressionsbomben“: winzige Datei, riesiges Bild. */
const MAX_SOURCE_PIXELS = 60_000_000;
/** Nur diese Formate werden gelesen; sharp könnte sonst z. B. auch SVG oder PDF öffnen. */
const INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);
/** So viele Bilder werden höchstens gleichzeitig verkleinert, damit Streams nicht warten. */
const PARALLEL = 2;

export interface Thumbnail {
  data: Buffer;
  etag: string;
}

/**
 * Verkleinerte Cover als WebP, einmal gerechnet und in der Datenbank gecacht. Ordnerbilder aus der
 * Nextcloud sind oft Fotos oder Druckvorlagen mit mehreren MB; so lädt eine Albenübersicht ein paar
 * KB je Kachel und fragt die Nextcloud nur beim ersten Mal.
 */
export class CoverThumbnails {
  private readonly pending = new Map<string, Promise<Thumbnail | undefined>>();
  /** Quellen, die sich nicht verkleinern ließen; nicht bei jedem Abruf erneut versuchen. */
  private readonly failed = new Set<string>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly db: DB,
    private readonly client: NextcloudClient,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Vorschau zu einer Quelle; undefined, wenn sich das Bild nicht verkleinern lässt (dann das Original zeigen). */
  get(source: CoverSource): Promise<Thumbnail | undefined> {
    const key = 'path' in source ? `file:${source.path}` : `cover:${source.coverId}`;
    const version = 'path' in source ? source.etag : this.coverHash(source.coverId);
    if (version) {
      const cached = this.db.prepare('SELECT data FROM cover_thumbs WHERE source = ? AND version = ?').get(key, version) as
        | { data: Buffer }
        | undefined;
      if (cached) return Promise.resolve({ data: cached.data, etag: etagOf(key, version) });
    }
    const id = `${key}\u0000${version ?? ''}`;
    if (this.failed.has(id)) return Promise.resolve(undefined);
    let job = this.pending.get(id);
    if (!job) {
      job = this.limited(() => this.create(source, key, version))
        .then((thumb) => {
          if (!thumb) {
            if (this.failed.size >= 5000) this.failed.clear();
            this.failed.add(id);
          }
          return thumb;
        })
        .finally(() => this.pending.delete(id));
      this.pending.set(id, job);
    }
    return job;
  }

  private coverHash(id: number): string | undefined {
    return (this.db.prepare('SELECT hash FROM covers WHERE id = ?').get(id) as { hash: string } | undefined)?.hash;
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= PARALLEL) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async create(source: CoverSource, key: string, version: string | null | undefined): Promise<Thumbnail | undefined> {
    try {
      const original = await this.original(source);
      if (!original) return undefined;
      const image = sharp(original, { limitInputPixels: MAX_SOURCE_PIXELS, failOn: 'error' });
      const { format } = await image.metadata();
      if (!format || !INPUT_FORMATS.has(format)) return undefined;
      const data = await image
        .rotate()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      // Ohne Version (Ordnerbild vor dem nächsten Scan) ausliefern, aber nicht cachen.
      if (!version) return { data, etag: etagOf(key, createHash('sha256').update(data).digest('hex')) };
      this.db
        .prepare(
          `INSERT INTO cover_thumbs (source, version, data, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(source) DO UPDATE SET version = excluded.version, data = excluded.data, created_at = excluded.created_at`,
        )
        .run(key, version, data, Date.now());
      return { data, etag: etagOf(key, version) };
    } catch (error) {
      this.log.warn({ err: error, source: key }, 'Cover ließ sich nicht verkleinern, das Original wird gezeigt');
      return undefined;
    }
  }

  private async original(source: CoverSource): Promise<Buffer | undefined> {
    if ('coverId' in source) {
      return (this.db.prepare('SELECT data FROM covers WHERE id = ?').get(source.coverId) as { data: Buffer } | undefined)?.data;
    }
    const res = await this.client.get(source.path, {}, AbortSignal.timeout(30_000));
    if (!res.ok || !res.body) return undefined;
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_SOURCE_BYTES) {
      await res.body.cancel();
      return undefined;
    }
    const data = Buffer.from(await res.arrayBuffer());
    return data.length > MAX_SOURCE_BYTES ? undefined : data;
  }
}

const etagOf = (key: string, version: string) => `"t${createHash('sha256').update(`${key}\u0000${version}`).digest('base64url').slice(0, 27)}"`;
