import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const USER = 'musik-dienst';
export const PASSWORD = 'app-passwort';

interface FakeFile {
  data: Buffer;
  etag: string;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Ein Nextcloud-Imitat mit genau den WebDAV-Funktionen, die der Scanner nutzt:
 * PROPFIND mit Depth 1 und GET mit Range. Dateien liegen im Speicher.
 */
export class FakeNextcloud {
  readonly files = new Map<string, FakeFile>();
  /** Ordner, deren Auflistung mit 500 fehlschlägt */
  readonly brokenDirs = new Set<string>();
  /** Dateien, deren Download mit 500 fehlschlägt */
  readonly brokenFiles = new Set<string>();
  /** Dateien, deren Download nach den ersten Bytes stehen bleibt */
  readonly stalledFiles = new Set<string>();
  /** Dateien, auf die gar keine Antwort kommt (nicht einmal die Header) */
  readonly hangingFiles = new Set<string>();
  readonly requests: Array<{ method: string; path: string; range?: string }> = [];
  ignoreRange = false;
  private server: Server | undefined;
  url = '';
  readonly root: string;

  constructor(readonly musicPath = '/Musik') {
    this.root = `/remote.php/dav/files/${USER}${musicPath}`;
  }

  put(path: string, data: Buffer): void {
    this.files.set(path, { data, etag: createHash('md5').update(data).update(path).digest('hex') });
  }

  delete(path: string): void {
    this.files.delete(path);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  gets(): string[] {
    return this.requests.filter((r) => r.method === 'GET').map((r) => r.path);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (!pathname.startsWith(this.root)) {
      res.writeHead(404).end();
      return;
    }
    const path = pathname.slice(this.root.length).replace(/^\/+|\/+$/g, '');
    this.requests.push({ method: req.method ?? '', path, range: req.headers.range });
    // Body konsumieren, damit die Verbindung sauber bleibt
    req.resume();
    if (req.method === 'PROPFIND') this.propfind(path, req, res);
    else if (req.method === 'GET') this.get(path, req, res);
    else res.writeHead(405).end();
  }

  private isDir(path: string): boolean {
    if (path === '') return true;
    for (const file of this.files.keys()) if (file.startsWith(`${path}/`)) return true;
    return false;
  }

  private propfind(path: string, req: IncomingMessage, res: ServerResponse): void {
    if (req.headers.depth !== '1') {
      res.writeHead(400).end();
      return;
    }
    if (this.brokenDirs.has(path)) {
      res.writeHead(500).end();
      return;
    }
    if (!this.isDir(path)) {
      res.writeHead(404).end();
      return;
    }
    const children = new Map<string, FakeFile | null>();
    const prefix = path ? `${path}/` : '';
    for (const [file, data] of this.files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) children.set(file, data);
      else children.set(prefix + rest.slice(0, slash), null);
    }
    const href = (p: string, dir: boolean) =>
      escapeXml(
        `${this.root}/${p}`
          .split('/')
          .map((s) => encodeURIComponent(s))
          .join('/') + (dir ? '/' : ''),
      );
    const responses = [`<d:response><d:href>${href(path, true)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>"dir"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`];
    for (const [child, file] of children) {
      if (file === null) {
        responses.push(
          `<d:response><d:href>${href(child, true)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>"d-${escapeXml(child)}"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontentlength/><d:getcontenttype/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`,
        );
      } else {
        const type = child.endsWith('.flac') ? 'audio/flac' : child.endsWith('.mp3') ? 'audio/mpeg' : 'image/jpeg';
        responses.push(
          `<d:response><d:href>${href(child, false)}</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>&quot;${file.etag}&quot;</d:getetag><d:getcontentlength>${file.data.length}</d:getcontentlength><d:getcontenttype>${type}</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
        );
      }
    }
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${responses.join('')}</d:multistatus>`);
  }

  private get(path: string, req: IncomingMessage, res: ServerResponse): void {
    const file = this.files.get(path);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    const type = path.endsWith('.flac') ? 'audio/flac' : path.endsWith('.mp3') ? 'audio/mpeg' : 'image/jpeg';
    if (this.brokenFiles.has(path)) {
      res.writeHead(500).end();
      return;
    }
    if (this.hangingFiles.has(path)) return;
    if (this.stalledFiles.has(path)) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': file.data.length });
      res.write(file.data.subarray(0, 16));
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && !this.ignoreRange) {
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : file.data.length - 1, file.data.length - 1);
      if (start >= file.data.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${file.data.length}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${file.data.length}`,
        'Accept-Ranges': 'bytes',
        ETag: `"${file.etag}"`,
      });
      res.end(file.data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': file.data.length,
      'Accept-Ranges': 'bytes',
      ETag: `"${file.etag}"`,
    });
    res.end(file.data);
  }
}
