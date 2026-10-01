import { useEffect, useState } from 'preact/hooks';
import { setCoverOverride, streamUrl, type Track } from '../api';
import type { Branding, CurrentUser } from '../auth';
import { saveDataPreferred } from '../preload';
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
  /** Favoriten-Titel, die offline bleiben sollen (neue kommen von selbst dazu); undefined, wenn nicht gewünscht */
  favorites: number[] | undefined;
  /** Titel, die für "Weiterhören" von selbst aufs Gerät kamen und wieder gehen, wenn sie zu Ende gehört sind */
  resume: number[];
  /** "Weiterhören" automatisch bereithalten (Standard: an) */
  keepResume: boolean;
}

/** Auf dem Gerät: was "Weiterhören" selbst geladen hat, was der Hörer davon gelöscht hat, und ob es aus ist */
interface ResumeMeta {
  ids: number[];
  skip: number[];
  off?: boolean;
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
/** Die aktuellen Favoriten-Titel vom Server, für den Abgleich mit den Offline-Kopien */
let favoriteTracks: Track[] | undefined;
/** Die Titel unter "Weiterhören" auf der Startseite, zuletzt vom Server */
let resumeTracks: Track[] | undefined;
/** Vom Hörer gelöschte Weiterhören-Titel; sie kommen nicht von selbst wieder, solange sie in der Liste stehen */
let resumeSkip: number[] = [];
/** Abgleiche nacheinander, damit sich zwei Aufrufe nicht die Liste überschreiben */
let resumeRun: Promise<void> = Promise.resolve();

function empty(): OfflineState {
  return { enabled: false, items: [], ids: new Set(), progress: new Map(), error: undefined, expiresAt: undefined, favorites: undefined, resume: [], keepResume: true };
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
  const favorites = (await idbGet<{ ids: number[] }>('meta', 'favorites'))?.ids;
  const resume = await idbGet<ResumeMeta>('meta', 'resume');
  resumeSkip = resume?.skip ?? [];
  set({
    items,
    enabled: Boolean(profile),
    expiresAt: profile && profile.contactAt + profile.days * DAY_MS,
    favorites,
    resume: resume?.ids ?? [],
    keepResume: !resume?.off,
  });
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
    await applyFavorites();
    await applyResume();
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
  favoriteTracks = undefined;
  resumeTracks = undefined;
  resumeSkip = [];
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

/** Titel für unterwegs speichern; mehrere laufen nacheinander. Vom Hörer gewählt, bleiben sie auch nach dem Weiterhören. */
export function download(tracks: Track[]): void {
  if (!state.enabled) return;
  const claimed = new Set(tracks.map((track) => track.id));
  if (state.resume.some((id) => claimed.has(id))) {
    void saveResume({ resume: state.resume.filter((id) => !claimed.has(id)) }).catch(() => undefined);
  }
  enqueue(tracks);
}

function enqueue(tracks: Track[]): void {
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

function setProgress(trackId: number, value: number, run: number): void {
  // Nach dem Löschen (Abmelden) keinen Fortschritt mehr eintragen, sonst hinge der Titel als "wird geladen" fest.
  if (run !== generation) return;
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
    if (total) setProgress(track.id, Math.min(0.99, size / total), run);
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

/** Vom Hörer gelöscht: Weiterhören-Titel darunter nicht gleich wieder laden */
export async function removeDownloads(trackIds: number[]): Promise<void> {
  const listed = new Set((resumeTracks ?? []).map((track) => track.id));
  const removed = new Set(trackIds);
  if (trackIds.some((id) => listed.has(id) || state.resume.includes(id))) {
    resumeSkip = [...new Set([...resumeSkip, ...trackIds.filter((id) => listed.has(id))])];
    await saveResume({ resume: state.resume.filter((id) => !removed.has(id)) }).catch(() => undefined);
  }
  await deleteCopies(trackIds);
}

async function deleteCopies(trackIds: number[]): Promise<void> {
  for (const id of trackIds) {
    await idbDelete('tracks', id);
    await idbDelete('parts', partsOf(id));
    const url = coverUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    coverUrls.delete(id);
  }
  await loadItems();
}

/**
 * Favoriten offline halten (oder nicht mehr): an lädt alle Favoriten-Titel und künftig jeden neuen,
 * aus löscht ihre Kopien. Die Wahl liegt mit den Kopien auf dem Gerät und verschwindet mit ihnen.
 */
export async function keepFavorites(on: boolean): Promise<void> {
  await ready;
  if (on) {
    if (!state.enabled) return;
    await idbPut('meta', { ids: (favoriteTracks ?? []).map((track) => track.id) }, 'favorites');
    set({ favorites: (favoriteTracks ?? []).map((track) => track.id) });
    await applyFavorites();
    return;
  }
  const ids = state.favorites ?? [];
  await idbDelete('meta', 'favorites').catch(() => undefined);
  set({ favorites: undefined });
  // Was gerade unter "Weiterhören" steht, bleibt und geht später mit dem Weiterhören
  const listed = new Set(state.keepResume ? (resumeTracks ?? []).map((track) => track.id) : []);
  const stay = ids.filter((id) => listed.has(id) || state.resume.includes(id));
  if (stay.length) await saveResume({ resume: [...new Set([...state.resume, ...stay])] }).catch(() => undefined);
  await deleteCopies(ids.filter((id) => !stay.includes(id)));
}

/** Die Favoriten haben sich geändert (geladen, Herz an oder aus): neue Titel mitnehmen, wenn gewünscht. */
export async function syncFavorites(tracks: Track[]): Promise<void> {
  favoriteTracks = tracks;
  await ready;
  await applyFavorites();
}

async function applyFavorites(): Promise<void> {
  if (!state.enabled || !state.favorites || !favoriteTracks) return;
  const ids = favoriteTracks.map((track) => track.id);
  if (ids.join() !== state.favorites.join()) {
    try {
      await idbPut('meta', { ids }, 'favorites');
    } catch {
      return;
    }
    set({ favorites: ids });
  }
  const missing = favoriteTracks.filter((track) => !state.ids.has(track.id) && !state.progress.has(track.id));
  if (missing.length) enqueue(missing);
}

async function saveResume(next: { resume?: number[]; keepResume?: boolean }): Promise<void> {
  const resume = next.resume ?? state.resume;
  const keep = next.keepResume ?? state.keepResume;
  set({ resume, keepResume: keep });
  if (!profile) return;
  await idbPut('meta', { ids: resume, skip: resumeSkip, off: !keep || undefined } satisfies ResumeMeta, 'resume');
}

/**
 * Die Titel unter "Weiterhören" (angefangene Predigten) auf dem Gerät bereithalten, damit sie bei
 * schwachem Netz nicht erst laden müssen. Wer aus der Liste fällt (zu Ende gehört), wird wieder
 * gelöscht, außer der Hörer hat ihn selbst heruntergeladen oder er ist ein offline gehaltener Favorit.
 */
export async function syncResume(tracks: Track[]): Promise<void> {
  resumeTracks = tracks;
  await ready;
  await applyResume();
}

/** "Weiterhören" automatisch bereithalten oder nicht mehr; aus löscht, was davon von selbst kam. */
export async function keepResume(on: boolean): Promise<void> {
  await ready;
  if (!state.enabled) return;
  if (on) resumeSkip = [];
  await saveResume({ keepResume: on }).catch(() => undefined);
  await applyResume();
}

function applyResume(): Promise<void> {
  resumeRun = resumeRun.then(reconcileResume).catch(() => undefined);
  return resumeRun;
}

async function reconcileResume(): Promise<void> {
  if (!state.enabled || !profile) return;
  const tracks = state.keepResume ? resumeTracks : [];
  if (!tracks) return;
  const wanted = new Set(tracks.map((track) => track.id));
  resumeSkip = resumeSkip.filter((id) => wanted.has(id));
  const favorites = new Set(state.favorites ?? []);
  // Noch ladende bleiben vorgemerkt und gehen beim nächsten Abgleich; Favoriten gehören dann den Favoriten.
  const owned = state.resume.filter((id) => wanted.has(id) || (state.progress.has(id) && !favorites.has(id)));
  const dropped = state.resume.filter((id) => !owned.includes(id) && !favorites.has(id));
  // Neues nur laden, wenn nicht gespart werden soll; bei schwachem Netz hilft es dann ohnehin nicht mehr.
  const missing = saveDataPreferred()
    ? []
    : tracks.filter((track) => !state.ids.has(track.id) && !state.progress.has(track.id) && !resumeSkip.includes(track.id));
  const next = [...owned, ...missing.map((track) => track.id).filter((id) => !owned.includes(id))];
  await saveResume({ resume: next });
  if (missing.length) enqueue(missing);
  if (dropped.length) await deleteCopies(dropped);
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
