import { useEffect, useState } from 'preact/hooks';
import { setCoverOverride, streamUrl, type Track } from '../api';
import type { Branding, CurrentUser } from '../auth';
import { importKey, seal, unseal, type Sealed } from './crypto';
import { idbClear, idbDelete, idbGet, idbGetAll, idbPut, idbSupported, partsOf } from './idb';

/**
 * Offline hören: Titel werden verschlüsselt in IndexedDB abgelegt und beim Abspielen im Speicher
 * entschlüsselt. Es gibt keinen Datei-Download. Die Kopien gehören dem angemeldeten Benutzer und
 * verschwinden beim Abmelden, bei Sperrung oder Rollenverlust, wenn der Admin Offline abschaltet
 * oder die App zu lange keinen Kontakt zum Server hatte.
 */

interface Profile {
  user: CurrentUser;
  branding?: Branding;
  key: CryptoKey;
  keyId: string;
  days: number;
  /** Letzter erfolgreicher Abruf des Schlüssels */
  contactAt: number;
}

export interface SavedTrack {
  id: number;
  track: Track;
  mime: string;
  size: number;
  parts: number;
  hasCover: boolean;
  savedAt: number;
}

export interface OfflineState {
  /** Browser kann es und der Admin erlaubt es */
  enabled: boolean;
  items: SavedTrack[];
  ids: Set<number>;
  /** Laufende und wartende Downloads mit Anteil 0..1 */
  progress: Map<number, number>;
  error: string | undefined;
  /** Bis dahin bleiben die Kopien ohne Serverkontakt abspielbar */
  expiresAt: number | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Größe der einzeln verschlüsselten Stücke; klein genug für wenig Speicher beim Laden */
const PART_SIZE = 1024 * 1024;
const COVER_PART = -1;

let profile: Profile | undefined;
let state: OfflineState = empty();
/** Wechselt beim Löschen, damit laufende Downloads danach nichts mehr ablegen */
let generation = 0;
const listeners = new Set<() => void>();
const coverUrls = new Map<number, string>();
const queue: Track[] = [];
let working = false;

function empty(): OfflineState {
  return { enabled: false, items: [], ids: new Set(), progress: new Map(), error: undefined, expiresAt: undefined };
}

function set(next: Partial<OfflineState>): void {
  state = { ...state, ...next };
  if (next.items) state.ids = new Set(next.items.map((item) => item.id));
  listeners.forEach((listener) => listener());
}

export function getOffline(): OfflineState {
  return state;
}

export function useOffline(): OfflineState {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    const update = () => setCurrent(state);
    listeners.add(update);
    update();
    return () => listeners.delete(update);
  }, []);
  return current;
}

const expired = (p: Profile, now = Date.now()) => now - p.contactAt > p.days * DAY_MS;

/** Gespeichertes beim Start laden; abgelaufene Kopien sofort löschen. */
export const ready: Promise<void> = (async () => {
  if (!idbSupported()) return;
  try {
    const saved = await idbGet<Profile>('meta', 'profile');
    if (!saved) return;
    if (expired(saved)) {
      await wipeOffline();
      return;
    }
    profile = saved;
    await loadItems();
  } catch {
    // Kein IndexedDB (z. B. privates Fenster): dann eben ohne Offline.
  }
})();

async function loadItems(): Promise<void> {
  // Erst hier, nicht beim Laden des Moduls: api.ts ist dann sicher fertig (Importkreis über auth.ts).
  setCoverOverride((trackId) => coverUrls.get(trackId));
  const items = (await idbGetAll<SavedTrack>('tracks')).sort((a, b) => b.savedAt - a.savedAt);
  for (const item of items) {
    if (!item.hasCover || coverUrls.has(item.id) || !profile) continue;
    try {
      const sealed = await idbGet<Sealed & { type: string }>('parts', [item.id, COVER_PART]);
      if (sealed) {
        const data = await unseal(profile.key, profile.keyId, item.id, COVER_PART, sealed);
        coverUrls.set(item.id, URL.createObjectURL(new Blob([data], { type: sealed.type })));
      }
    } catch {
      // Cover fehlt, dann der Platzhalter
    }
  }
  set({ items, enabled: Boolean(profile), expiresAt: profile && profile.contactAt + profile.days * DAY_MS });
}

/**
 * Nach erfolgreicher Anmeldung (online): Schlüssel holen und damit die Frist verlängern.
 * Anderer Benutzer, neuer Schlüssel oder abgeschaltet: vorhandene Kopien löschen.
 */
export async function connectOffline(user: CurrentUser, branding?: Branding): Promise<void> {
  await ready;
  if (!idbSupported()) return;
  let data: { enabled: boolean; days: number; key?: string; keyId?: string };
  try {
    const res = await fetch('/api/me/offline', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  if (!data.enabled || !data.key || !data.keyId) {
    await wipeOffline();
    return;
  }
  if (profile && (profile.user.id !== user.id || profile.keyId !== data.keyId)) await wipeOffline();
  try {
    const next: Profile = {
      user,
      branding,
      key: profile?.keyId === data.keyId ? profile.key : await importKey(data.key),
      keyId: data.keyId,
      days: data.days,
      contactAt: Date.now(),
    };
    await idbPut('meta', next, 'profile');
    profile = next;
    await loadItems();
  } catch {
    set({ enabled: false });
  }
}

/** Ohne Server: Wer mit gültigen Offline-Kopien angemeldet war, darf sie weiter hören. */
export async function offlineProfile(): Promise<{ user: CurrentUser; branding?: Branding } | undefined> {
  await ready;
  if (!profile) return undefined;
  if (expired(profile)) {
    await wipeOffline();
    return undefined;
  }
  return { user: profile.user, branding: profile.branding };
}

/** Beim Abmelden und immer, wenn der Server den Zugang verneint */
export async function wipeOffline(): Promise<void> {
  generation++;
  queue.length = 0;
  profile = undefined;
  for (const url of coverUrls.values()) URL.revokeObjectURL(url);
  coverUrls.clear();
  state = empty();
  listeners.forEach((listener) => listener());
  if (!idbSupported()) return;
  try {
    await idbClear();
  } catch {
    // Nichts gespeichert oder IndexedDB gesperrt
  }
}

export const isDownloaded = (trackId: number) => state.ids.has(trackId);

/** Titel für unterwegs speichern; mehrere laufen nacheinander. */
export function download(tracks: Track[]): void {
  if (!state.enabled) return;
  const progress = new Map(state.progress);
  for (const track of tracks) {
    if (state.ids.has(track.id) || progress.has(track.id)) continue;
    queue.push(track);
    progress.set(track.id, 0);
  }
  set({ progress, error: undefined });
  // Einmal um dauerhaften Speicher bitten, damit der Browser nicht bei Platzmangel aufräumt.
  void navigator.storage?.persist?.().catch(() => undefined);
  void work();
}

async function work(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (let track = queue.shift(); track; track = queue.shift()) {
      const run = generation;
      try {
        await save(track, run);
      } catch (error) {
        await idbDelete('parts', partsOf(track.id)).catch(() => undefined);
        if (run === generation) {
          const full = (error as DOMException).name === 'QuotaExceededError';
          set({ error: full ? 'Kein Speicherplatz mehr auf dem Gerät' : `„${track.title}“ konnte nicht gespeichert werden` });
        }
      }
      if (run !== generation) continue;
      const progress = new Map(state.progress);
      progress.delete(track.id);
      set({ progress });
    }
  } finally {
    working = false;
  }
}

function setProgress(trackId: number, value: number): void {
  const progress = new Map(state.progress);
  progress.set(trackId, value);
  set({ progress });
}

async function save(track: Track, run: number): Promise<void> {
  const current = profile;
  if (!current) throw new Error('Kein Schlüssel');
  const res = await fetch(streamUrl(track.id), { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`Fehler ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  let buffered: Uint8Array[] = [];
  let bufferedSize = 0;
  let size = 0;
  let parts = 0;
  /** Gepuffertes in Stücke von PART_SIZE zerlegen und ablegen; am Ende auch den Rest. */
  const flush = async (final: boolean) => {
    if (run !== generation) return;
    const data = new Uint8Array(bufferedSize);
    let offset = 0;
    for (const piece of buffered) {
      data.set(piece, offset);
      offset += piece.length;
    }
    offset = 0;
    while (data.length - offset >= PART_SIZE || (final && offset < data.length)) {
      const piece = data.subarray(offset, offset + PART_SIZE);
      offset += piece.length;
      await idbPut('parts', await seal(current.key, current.keyId, track.id, parts, piece), [track.id, parts]);
      parts++;
    }
    buffered = offset < data.length ? [data.slice(offset)] : [];
    bufferedSize = data.length - offset;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (run !== generation) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    if (done) break;
    buffered.push(value);
    bufferedSize += value.length;
    size += value.length;
    if (bufferedSize >= PART_SIZE) await flush(false);
    if (total) setProgress(track.id, Math.min(0.99, size / total));
  }
  await flush(true);

  let hasCover = false;
  if (track.hasCover !== false) {
    const cover = await fetch(`/api/tracks/${track.id}/cover`).catch(() => undefined);
    if (cover?.ok) {
      const type = cover.headers.get('content-type') ?? 'image/webp';
      const sealed = await seal(current.key, current.keyId, track.id, COVER_PART, await cover.arrayBuffer());
      await idbPut('parts', { ...sealed, type }, [track.id, COVER_PART]);
      hasCover = true;
    }
  }
  if (run !== generation) return;
  const mime = res.headers.get('content-type') ?? track.mimeType ?? 'audio/mpeg';
  await idbPut('tracks', { id: track.id, track, mime, size, parts, hasCover, savedAt: Date.now() } satisfies SavedTrack);
  await loadItems();
}

export async function removeDownloads(trackIds: number[]): Promise<void> {
  for (const id of trackIds) {
    await idbDelete('tracks', id);
    await idbDelete('parts', partsOf(id));
    const url = coverUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    coverUrls.delete(id);
  }
  await loadItems();
}

/** Entschlüsselter Titel als Blob, nur im Speicher; undefined, wenn nicht (mehr) vorhanden. */
export async function readDownload(trackId: number): Promise<Blob | undefined> {
  await ready;
  const current = profile;
  if (!current || !state.ids.has(trackId)) return undefined;
  if (expired(current)) {
    await wipeOffline();
    return undefined;
  }
  const item = await idbGet<SavedTrack>('tracks', trackId);
  if (!item) return undefined;
  try {
    const sealed = await idbGetAll<Sealed>('parts', IDBKeyRange.bound([trackId, 0], [trackId, Infinity]));
    if (sealed.length !== item.parts) throw new Error('Unvollständig');
    const parts = await Promise.all(sealed.map((part, index) => unseal(current.key, current.keyId, trackId, index, part)));
    return new Blob(parts, { type: item.mime });
  } catch {
    // Beschädigt oder mit altem Schlüssel: weg damit, der Player nimmt dann den Stream.
    await removeDownloads([trackId]);
    return undefined;
  }
}

/** Belegter und verfügbarer Speicher laut Browser */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | undefined> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.quota ? { usage: estimate.usage ?? 0, quota: estimate.quota } : undefined;
  } catch {
    return undefined;
  }
}

/** App-Oberfläche offline bereithalten (nur im fertigen Build, siehe web/sw/sw.js) */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
