import { XMLParser } from 'fast-xml-parser';
import type { NextcloudConfig } from '../config.js';

export interface RemoteEntry {
  /** Pfad relativ zum Musikordner, ohne führenden Slash, z. B. "Interpret/Album/01 Titel.mp3" */
  path: string;
  isDirectory: boolean;
  etag: string;
  size: number;
  contentType: string | undefined;
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
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
    <d:getcontentlength/>
    <d:getcontenttype/>
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

/**
 * Minimaler WebDAV-Client für genau das, was der Scanner braucht:
 * Ordner auflisten (Depth 1, weil viele Server Depth infinity sperren)
 * und Dateien ganz oder in Teilen lesen.
 */
export class NextcloudClient {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly authorization: string;

  constructor(
    config: NextcloudConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = `${config.url}/remote.php/dav/files/${encodeURIComponent(config.user)}/${encodePath(config.musicPath)}`.replace(
      /\/+$/,
      '',
    );
    this.basePath = decodeURIComponent(new URL(this.baseUrl).pathname).replace(/\/+$/, '');
    this.authorization = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
  }

  fileUrl(path: string): string {
    const encoded = encodePath(path);
    return encoded ? `${this.baseUrl}/${encoded}` : this.baseUrl;
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const url = this.fileUrl(dir) + '/';
    const res = await this.fetchImpl(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: this.authorization,
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
    });
    if (res.status !== 207) {
      throw new WebDavError(`PROPFIND ${dir || '/'} fehlgeschlagen: HTTP ${res.status}`, res.status);
    }
    const self = dir.replace(/^\/+|\/+$/g, '');
    return this.parseMultistatus(await res.text()).filter((entry) => entry.path !== self);
  }

  /** Liest die ersten `length` Bytes einer Datei (für Tags reicht meist der Dateianfang). */
  async readHead(path: string, length: number): Promise<Buffer> {
    const res = await this.get(path, { Range: `bytes=0-${length - 1}` });
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
      entries.push({
        path,
        isDirectory,
        etag: String(okProps.getetag ?? '').replace(/"/g, ''),
        size: Number(okProps.getcontentlength ?? 0),
        contentType: okProps.getcontenttype ? String(okProps.getcontenttype) : undefined,
      });
    }
    return entries;
  }
}
