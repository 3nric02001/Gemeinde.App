import { XMLParser } from 'fast-xml-parser';
import type { NextcloudConfig } from '../config.js';

export interface RemoteEntry {
  /** Pfad relativ zum Musikordner, ohne führenden Slash, z. B. "Interpret/Album/01 Titel.mp3" */
  path: string;
  isDirectory: boolean;
  etag: string;
  size: number;
  contentType: string | undefined;
  /** Nextcloud-Datei-ID; bleibt beim Umbenennen und Verschieben gleich */
  fileId?: string;
  /** Wann die Datei hochgeladen (Nextcloud 28+) bzw. zuletzt geändert wurde, in ms */
  addedAt?: number;
}

export class WebDavError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WebDavError';
  }
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <oc:fileid/>
    <nc:upload_time/>
  </d:prop>
</d:propfind>`;

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === 'response' || name === 'propstat',
});

function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** So lange darf eine einzelne Anfrage des Scanners an die Nextcloud dauern, bevor sie abgebrochen wird. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Verständliche Meldung für Netzwerkfehler und Zeitüberschreitungen statt "fetch failed". */
function networkError(error: unknown, what: string, timeoutMs: number): Error {
  if (error instanceof WebDavError) return error;
  const name = (error as { name?: string }).name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new WebDavError(`${what}: Nextcloud hat nicht innerhalb von ${Math.ceil(timeoutMs / 1000)} s geantwortet`, 0);
  }
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
  return new WebDavError(`${what}: Nextcloud nicht erreichbar (${detail}, NEXTCLOUD_URL prüfen)`, 0);
}

/**
 * Minimaler WebDAV-Client für genau das, was der Scanner braucht:
 * Ordner auflisten (Depth 1, weil viele Server Depth infinity sperren)
 * und Dateien ganz oder in Teilen lesen.
 */
/** Gemeinsamer Elternordner mehrerer Musikordner, z. B. /Gemeinde für /Gemeinde/Musik und /Gemeinde/Predigten. */
export function commonBase(paths: string[]): string {
  const [first = [], ...rest] = paths.map((path) => path.split('/').filter(Boolean));
  let length = first.length;
  for (const segments of rest) {
    let i = 0;
    while (i < length && i < segments.length && segments[i] === first[i]) i++;
    length = i;
  }
  return length ? `/${first.slice(0, length).join('/')}` : '';
}

export class NextcloudClient {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly authorization: string;
  /**
   * Ordner, auf den sich alle Pfade in der Bibliothek beziehen: bei einem Musikordner dieser selbst,
   * bei mehreren ihr gemeinsamer Elternordner.
   */
  readonly base: string;
  /** Die Musikordner relativ zu `base` ("" ist base selbst) */
  readonly roots: string[];
  readonly musicPaths: string[];

  constructor(
    config: NextcloudConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.musicPaths = config.musicPaths;
    this.base = commonBase(config.musicPaths);
    this.roots = config.musicPaths.map((path) => path.slice(this.base.length).replace(/^\/+/, ''));
    this.baseUrl = `${config.url}/remote.php/dav/files/${encodeURIComponent(config.user)}/${encodePath(this.base)}`.replace(
      /\/+$/,
      '',
    );
    this.basePath = decodeURIComponent(new URL(this.baseUrl).pathname).replace(/\/+$/, '');
    this.authorization = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
  }

  /** Vollständiger Ordner in der Nextcloud zu einem Pfad der Bibliothek, für Meldungen */
  absolute(path: string): string {
    return `${this.base}/${path}`.replace(/\/+$/, '') || '/';
  }

  fileUrl(path: string): string {
    const encoded = encodePath(path);
    return encoded ? `${this.baseUrl}/${encoded}` : this.baseUrl;
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const url = this.fileUrl(dir) + '/';
    const what = `PROPFIND ${dir || '/'}`;
    let xml: string;
    try {
      const res = await this.fetchImpl(url, {
        method: 'PROPFIND',
        headers: {
          Authorization: this.authorization,
          Depth: '1',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body: PROPFIND_BODY,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 401) {
        throw new WebDavError(`${what}: Nextcloud lehnt die Anmeldung ab (NEXTCLOUD_USER/NEXTCLOUD_PASSWORD prüfen)`, 401);
      }
      if (res.status !== 207) throw new WebDavError(`${what} fehlgeschlagen: HTTP ${res.status}`, res.status);
      xml = await res.text();
    } catch (error) {
      throw networkError(error, what, this.timeoutMs);
    }
    const self = dir.replace(/^\/+|\/+$/g, '');
    return this.parseMultistatus(xml).filter((entry) => entry.path !== self);
  }

  /** Liest die ersten `length` Bytes einer Datei (für Tags reicht meist der Dateianfang). */
  async readHead(path: string, length: number): Promise<Buffer> {
    try {
      return await this.fetchHead(path, length);
    } catch (error) {
      throw networkError(error, `GET ${path}`, this.timeoutMs);
    }
  }

  private async fetchHead(path: string, length: number): Promise<Buffer> {
    // Das Zeitlimit gilt für die ganze Anfrage samt Lesen, damit eine stockende Übertragung den Scan nicht aufhält.
    const res = await this.get(path, { Range: `bytes=0-${length - 1}` }, AbortSignal.timeout(this.timeoutMs));
    if (res.status !== 206 && res.status !== 200) {
      throw new WebDavError(`GET ${path} fehlgeschlagen: HTTP ${res.status}`, res.status);
    }
    if (res.status === 206 || !res.body) return Buffer.from(await res.arrayBuffer());
    // Server ignoriert Range: nur so viel lesen wie nötig und dann abbrechen.
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    while (total < length) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
    await reader.cancel();
    return Buffer.concat(chunks).subarray(0, length);
  }

  /** Rohes GET, z. B. für Streaming mit durchgereichtem Range-Header. */
  get(path: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(this.fileUrl(path), {
      method: 'GET',
      headers: { Authorization: this.authorization, ...headers },
      signal,
    });
  }

  private parseMultistatus(xml: string): RemoteEntry[] {
    const doc = parser.parse(xml) as { multistatus?: { response?: unknown[] } };
    const responses = (doc.multistatus?.response ?? []) as Array<{
      href?: string;
      propstat?: Array<{ status?: string; prop?: Record<string, unknown> }>;
    }>;
    const entries: RemoteEntry[] = [];
    for (const response of responses) {
      if (!response.href) continue;
      const okProps = response.propstat?.find((p) => p.status?.includes(' 200'))?.prop ?? {};
      const href = decodeURIComponent(new URL(response.href, this.baseUrl).pathname).replace(/\/+$/, '');
      if (!href.startsWith(this.basePath)) continue;
      const path = href.slice(this.basePath.length).replace(/^\/+/, '');
      const resourcetype = okProps.resourcetype;
      const isDirectory = typeof resourcetype === 'object' && resourcetype !== null && 'collection' in resourcetype;
      const fileId = okProps.fileid !== undefined && okProps.fileid !== '' ? String(okProps.fileid) : undefined;
      // upload_time ist 0, wenn Nextcloud sie nicht kennt (ältere Dateien); dann gilt das Änderungsdatum.
      const uploaded = Number(okProps.upload_time ?? 0) * 1000;
      const modified = okProps.getlastmodified ? Date.parse(String(okProps.getlastmodified)) : NaN;
      const addedAt = uploaded > 0 ? uploaded : Number.isFinite(modified) ? modified : undefined;
      entries.push({
        path,
        isDirectory,
        etag: String(okProps.getetag ?? '').replace(/"/g, ''),
        size: Number(okProps.getcontentlength ?? 0),
        contentType: okProps.getcontenttype ? String(okProps.getcontenttype) : undefined,
        ...(fileId ? { fileId } : {}),
        ...(addedAt !== undefined ? { addedAt } : {}),
      });
    }
    return entries;
  }
}
