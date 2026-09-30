import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../src/api';
import { Player } from '../src/player';
import { PRELOAD_MAX_BYTES, Preloader, saveDataPreferred } from '../src/preload';
import { Queue } from '../src/queue';

const audioBytes = new Uint8Array(2000).map((_, i) => i % 251);
const stream = (size = audioBytes.length, body: Uint8Array<ArrayBuffer> = audioBytes) =>
  new Response(body, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(size) } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function preloader(options: { offline?: number[]; saveData?: boolean; fetch?: typeof fetch } = {}) {
  const readDownload = vi.fn(async (id: number) => new Blob([`offline ${id}`], { type: 'audio/mpeg' }));
  const fetchMock = vi.fn(options.fetch ?? (async () => stream()));
  const instance = new Preloader({
    isDownloaded: (id) => options.offline?.includes(id) ?? false,
    readDownload,
    fetch: fetchMock as unknown as typeof fetch,
    saveData: () => options.saveData ?? false,
  });
  return { instance, readDownload, fetchMock };
}

describe('Vorladen', () => {
  it('holt den nächsten Titel aus dem Netz und gibt ihn einmal heraus', async () => {
    const { instance, fetchMock } = preloader();
    instance.want(7);
    instance.want(7);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/tracks/7/stream');
    expect(instance.take(8)).toBeUndefined();
    const blob = instance.take(7);
    expect(blob?.type).toBe('audio/mpeg');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(audioBytes);
    expect(instance.take(7)).toBeUndefined();
  });

  it('entschlüsselt Offline-Kopien vorab, auch im Datensparmodus', async () => {
    const { instance, readDownload, fetchMock } = preloader({ offline: [3], saveData: true });
    instance.want(3);
    await flush();
    expect(readDownload).toHaveBeenCalledWith(3);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await instance.take(3)?.text()).toBe('offline 3');
  });

  it('lädt im Datensparmodus nichts aus dem Netz', async () => {
    const { instance, fetchMock } = preloader({ saveData: true });
    instance.want(7);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(instance.take(7)).toBeUndefined();
  });

  it('lässt zu große oder fehlerhafte Antworten aus und versucht es nicht dauernd neu', async () => {
    const big = preloader({ fetch: async () => stream(PRELOAD_MAX_BYTES + 1) });
    big.instance.want(7);
    await flush();
    big.instance.want(7);
    expect(big.instance.take(7)).toBeUndefined();
    expect(big.fetchMock).toHaveBeenCalledTimes(1);

    const broken = preloader({ fetch: async () => new Response('weg', { status: 502 }) });
    broken.instance.want(7);
    await flush();
    expect(broken.instance.take(7)).toBeUndefined();

    const offline = preloader({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    offline.instance.want(7);
    await flush();
    expect(offline.instance.take(7)).toBeUndefined();
  });

  it('bricht ab, wenn ein anderer Titel dran ist', async () => {
    const signals: AbortSignal[] = [];
    const { instance } = preloader({
      fetch: async (_input, init) => {
        signals.push(init!.signal!);
        return stream();
      },
    });
    instance.want(7);
    instance.want(8);
    expect(signals[0]!.aborted).toBe(true);
    await flush();
    expect(instance.take(7)).toBeUndefined();
    expect(instance.take(8)).toBeDefined();
    instance.want(9);
    instance.clear();
    expect(signals[2]!.aborted).toBe(true);
    expect(instance.trackId).toBeUndefined();
  });

  it('erkennt Datensparmodus und 2G', () => {
    const nav = (connection?: object) => ({ connection }) as unknown as Navigator;
    expect(saveDataPreferred(nav())).toBe(false);
    expect(saveDataPreferred(nav({ saveData: true }))).toBe(true);
    expect(saveDataPreferred(nav({ effectiveType: '2g' }))).toBe(true);
    expect(saveDataPreferred(nav({ effectiveType: '4g', saveData: false }))).toBe(false);
  });

  it('weiß, welcher Titel als Nächstes kommt, ohne weiterzuschalten', () => {
    const q = new Queue<{ id: number }>();
    expect(q.peekNext()).toBeUndefined();
    q.set([{ id: 1 }, { id: 2 }], 0);
    expect(q.peekNext()?.id).toBe(2);
    expect(q.current?.id).toBe(1);
    q.jump(1);
    expect(q.peekNext()).toBeUndefined();
    q.cycleRepeat(); // alle
    expect(q.peekNext()?.id).toBe(1);
    q.cycleRepeat(); // einen
    expect(q.peekNext(true)?.id).toBe(2);
    expect(q.peekNext(false)?.id).toBe(1);
  });
});

describe('Player mit Vorladen', () => {
  const track = (id: number): Track => ({
    id, title: `Titel ${id}`, album: null, albumId: null, trackNo: null,
    discNo: null, year: null, duration: 200, mimeType: 'audio/mpeg',
  });

  afterEach(() => vi.restoreAllMocks());

  it('lädt kurz vor dem Ende den nächsten Titel und spielt ihn ohne Stream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input) === '/api/tracks/2/stream' ? stream() : new Response(null, { status: 204 }),
    );
    const audio = new Audio();
    let duration = NaN;
    Object.defineProperty(audio, 'duration', { get: () => duration });
    Object.defineProperty(audio, 'paused', { get: () => false });
    vi.spyOn(audio, 'play').mockResolvedValue(undefined);
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:vorab');
    const p = new Player(audio);
    p.playList([track(1), track(2)], 0, { shuffle: false });
    await flush();
    expect(audio.src).toContain('/api/tracks/1/stream');

    duration = 200;
    audio.currentTime = 100;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/tracks/2/stream')).toBe(false);

    audio.currentTime = 175;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/tracks/2/stream')).toHaveLength(1);
    await flush();

    audio.dispatchEvent(new Event('ended'));
    expect(created).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('blob:vorab');
    expect(p.getState().current?.id).toBe(2);
    p.reset();
  });
});
