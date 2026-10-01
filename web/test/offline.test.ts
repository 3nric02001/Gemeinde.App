import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackCoverUrl, type Track } from '../src/api';
import { getAuth, loadAuth, logout } from '../src/auth';
import { importKey, seal, unseal } from '../src/offline/crypto';
import { idbGetAll } from '../src/offline/idb';
import {
  connectOffline,
  download,
  getOffline,
  keepFavorites,
  keepResume,
  offlineProfile,
  readDownload,
  removeDownloads,
  syncFavorites,
  syncResume,
  wipeOffline,
} from '../src/offline';

const KEY_A = Buffer.alloc(32, 1).toString('base64url');
const KEY_B = Buffer.alloc(32, 2).toString('base64url');
const user = { id: 7, name: 'Anna', role: 'listener' as const, kind: 'oidc' as const };
const track: Track = {
  id: 41,
  title: 'Predigt',
  album: null,
  albumId: null,
  trackNo: null,
  discNo: null,
  year: null,
  duration: 2400,
  mimeType: 'audio/mpeg',
  hasCover: true,
};
// Etwas mehr als ein Stück (1 MiB), damit auch das Zerlegen geprüft ist
const audio = new Uint8Array(1024 * 1024 + 5000).map((_, i) => (i * 7) % 251);
const cover = new Uint8Array([1, 2, 3, 4]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let key = KEY_A;
let enabled = true;
let status: { user: typeof user | null } | 'down' = { user };

beforeEach(() => {
  key = KEY_A;
  enabled = true;
  status = { user };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/auth/status') {
      if (status === 'down') throw new TypeError('Failed to fetch');
      return json({ ...status, oidc: null, branding: { name: 'MBG', welcome: '' } });
    }
    if (url === '/api/me/offline') {
      return json(enabled ? { enabled, days: 30, key, keyId: key.slice(0, 8) } : { enabled: false, days: 30 });
    }
    if (url === '/api/tracks/41/stream') {
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(audio.length) } });
    }
    if (url === '/api/tracks/43/stream') return new Response(new Uint8Array([5, 6, 7]), { headers: { 'content-type': 'audio/mpeg' } });
    if (url === '/api/tracks/41/cover') return new Response(cover, { headers: { 'content-type': 'image/webp' } });
    if (url === '/api/auth/logout') return new Response(null, { status: 204 });
    return json({}, 404);
  });
});

afterEach(async () => {
  await wipeOffline();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function downloaded(): Promise<void> {
  await connectOffline(user);
  download([track]);
  await vi.waitFor(() => expect(getOffline().ids.has(track.id)).toBe(true));
}

describe('Verschlüsselung', () => {
  it('entschlüsselt nur mit passendem Schlüssel und am richtigen Platz', async () => {
    const k = await importKey(KEY_A);
    const sealed = await seal(k, 'id', 41, 0, new Uint8Array([9, 8, 7]));
    expect(new Uint8Array(await unseal(k, 'id', 41, 0, sealed))).toEqual(new Uint8Array([9, 8, 7]));
    await expect(unseal(k, 'id', 41, 1, sealed)).rejects.toThrow();
    await expect(unseal(await importKey(KEY_B), 'id', 41, 0, sealed)).rejects.toThrow();
  });

  it('lässt den Schlüssel nicht exportieren', async () => {
    const k = await importKey(KEY_A);
    expect(k.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', k)).rejects.toThrow();
  });
});

describe('Offline-Kopien', () => {
  it('speichert Titel verschlüsselt und spielt sie unverändert ab', async () => {
    await downloaded();
    const stored = await idbGetAll<{ data: ArrayBuffer }>('parts');
    expect(stored).toHaveLength(3); // zwei Stücke Audio und das Cover
    const first = new Uint8Array(stored[1]!.data).slice(0, 64);
    expect(first).not.toEqual(audio.slice(0, 64));

    const blob = await readDownload(track.id);
    expect(blob?.type).toBe('audio/mpeg');
    // Byteweiser Vergleich über Buffer: toEqual braucht für 1 MiB mehrere Sekunden
    expect(Buffer.from(await blob!.arrayBuffer()).equals(Buffer.from(audio))).toBe(true);
    expect(trackCoverUrl(track)).toMatch(/^blob:/);
    expect(getOffline().items[0]).toMatchObject({ id: 41, size: audio.length, parts: 2 });
  });

  it('löscht alles bei neuem Schlüssel', async () => {
    await downloaded();
    key = KEY_B;
    await connectOffline(user);
    expect(getOffline().ids.size).toBe(0);
    expect(await idbGetAll('parts')).toHaveLength(0);
  });

  it('löscht alles, wenn der Admin Offline abschaltet', async () => {
    await downloaded();
    enabled = false;
    await connectOffline(user);
    expect(getOffline()).toMatchObject({ enabled: false });
    expect(await idbGetAll('tracks')).toHaveLength(0);
  });

  it('löscht alles für einen anderen Benutzer', async () => {
    await downloaded();
    await connectOffline({ ...user, id: 8 });
    expect(getOffline().ids.size).toBe(0);
  });

  it('verfällt nach der Frist ohne Serverkontakt', async () => {
    await downloaded();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 29 * 24 * 3600 * 1000);
    expect((await offlineProfile())?.user.id).toBe(7);
    vi.setSystemTime(Date.now() + 2 * 24 * 3600 * 1000);
    expect(await readDownload(track.id)).toBeUndefined();
    expect(await offlineProfile()).toBeUndefined();
    expect(await idbGetAll('tracks')).toHaveLength(0);
  });
});

describe('Favoriten offline', () => {
  const song: Track = { ...track, id: 43, title: 'Lobpreis', hasCover: false };

  it('lädt die Favoriten und künftig jeden neuen Favoriten', async () => {
    await connectOffline(user);
    await syncFavorites([track]);
    await keepFavorites(true);
    await vi.waitFor(() => expect(getOffline().ids.has(41)).toBe(true));
    expect(getOffline().favorites).toEqual([41]);

    await syncFavorites([song, track]);
    await vi.waitFor(() => expect(getOffline().ids.has(43)).toBe(true));
    expect(getOffline().favorites).toEqual([43, 41]);
  });

  it('lädt nichts, solange es nicht gewünscht ist', async () => {
    await connectOffline(user);
    await syncFavorites([track]);
    expect(getOffline().progress.size).toBe(0);
    expect(getOffline().favorites).toBeUndefined();
  });

  it('löscht die Kopien beim Abwählen und vergisst die Wahl beim Abmelden', async () => {
    await connectOffline(user);
    await syncFavorites([track]);
    await keepFavorites(true);
    await vi.waitFor(() => expect(getOffline().ids.has(41)).toBe(true));
    await keepFavorites(false);
    expect(getOffline()).toMatchObject({ favorites: undefined });
    expect(getOffline().ids.size).toBe(0);

    await keepFavorites(true);
    await wipeOffline();
    await connectOffline(user);
    expect(getOffline().favorites).toBeUndefined();
  });
});

describe('Weiterhören bereithalten', () => {
  const song: Track = { ...track, id: 43, title: 'Lobpreis', hasCover: false };

  it('lädt die Titel unter Weiterhören und löscht sie, wenn sie herausfallen', async () => {
    await connectOffline(user);
    await syncResume([track, song]);
    await vi.waitFor(() => expect(getOffline().ids).toEqual(new Set([41, 43])));
    expect(getOffline().resume).toEqual([41, 43]);

    await syncResume([song]);
    expect(getOffline().ids).toEqual(new Set([43]));
    expect(getOffline().resume).toEqual([43]);
  });

  it('wartet auf den Schlüssel, wenn die Liste vor der Anmeldung kommt', async () => {
    await syncResume([song]);
    expect(getOffline().ids.size).toBe(0);
    await connectOffline(user);
    await vi.waitFor(() => expect(getOffline().ids.has(43)).toBe(true));
  });

  it('lässt selbst heruntergeladene und offline gehaltene Favoriten liegen', async () => {
    await connectOffline(user);
    await syncResume([track, song]);
    await vi.waitFor(() => expect(getOffline().ids.size).toBe(2));
    download([song]);
    await syncFavorites([track]);
    await keepFavorites(true);

    await syncResume([]);
    expect(getOffline().ids).toEqual(new Set([41, 43]));
    expect(getOffline().resume).toEqual([]);
  });

  it('lädt vom Hörer Gelöschtes nicht gleich wieder', async () => {
    await connectOffline(user);
    await syncResume([song]);
    await vi.waitFor(() => expect(getOffline().ids.has(43)).toBe(true));
    await removeDownloads([43]);
    await syncResume([song]);
    expect(getOffline().progress.size).toBe(0);
    expect(getOffline().ids.size).toBe(0);
  });

  it('lässt sich ausschalten und merkt sich das auf dem Gerät', async () => {
    await connectOffline(user);
    await syncResume([song]);
    await vi.waitFor(() => expect(getOffline().ids.has(43)).toBe(true));
    await keepResume(false);
    expect(getOffline()).toMatchObject({ keepResume: false, resume: [] });
    expect(getOffline().ids.size).toBe(0);

    await connectOffline(user);
    await syncResume([song]);
    expect(getOffline().progress.size).toBe(0);

    await keepResume(true);
    await vi.waitFor(() => expect(getOffline().ids.has(43)).toBe(true));
  });

  it('lädt im Datensparmodus nichts Neues', async () => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
    try {
      await connectOffline(user);
      await syncResume([song]);
      expect(getOffline().progress.size).toBe(0);
    } finally {
      delete (navigator as { connection?: unknown }).connection;
    }
  });
});

describe('Anmeldung ohne Netz', () => {
  it('lässt mit Offline-Kopien weiterhören und löscht sie beim Abmelden', async () => {
    await downloaded();
    status = 'down';
    await loadAuth();
    expect(getAuth()).toMatchObject({ user: { id: 7 }, offline: true });

    await logout();
    expect(await idbGetAll('tracks')).toHaveLength(0);
    expect(await offlineProfile()).toBeUndefined();
  });

  it('löscht die Kopien, wenn der Server keine Sitzung mehr kennt', async () => {
    await downloaded();
    status = { user: null };
    await loadAuth();
    await vi.waitFor(async () => expect(await idbGetAll('tracks')).toHaveLength(0));
  });

  it('ohne Kopien und ohne Server bleibt es bei der Anmeldeseite', async () => {
    status = 'down';
    await loadAuth();
    expect(getAuth()).toMatchObject({ user: null, notice: 'Der Server ist gerade nicht erreichbar.' });
  });
});
