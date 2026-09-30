import { useEffect, useState } from 'preact/hooks';
import type { Track } from './api';
import { sessionExpired } from './auth';
import type { PlaybackContext } from './player';

/**
 * Eigene Playlists des Hörers und die, die andere mit ihm teilen. Liegen auf dem Server; hier ein Abbild für
 * Menüs ("Zur Playlist hinzufügen") und Startseite. Die Playlists der Verwaltung sind Alben (kind 'manual').
 */

export interface PlaylistSummary {
  id: number;
  title: string;
  trackCount: number;
  duration: number;
  /** Eigene Playlist; sonst von `owner` geteilt */
  mine: boolean;
  owner: string;
  /** Mit wie vielen geteilt (nur bei eigenen) */
  shared: number;
  coverTrackId: number | null;
  updatedAt: number;
}

export interface Person {
  id: number;
  name: string;
}

export interface PlaylistDetail extends PlaylistSummary {
  tracks: Track[];
  /** Mit wem geteilt (nur für den Besitzer) */
  sharedWith: Person[];
}

interface State {
  own: PlaylistSummary[];
  shared: PlaylistSummary[];
  loaded: boolean;
}

const empty = (): State => ({ own: [], shared: [], loaded: false });
let state = empty();
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function usePlaylists(): State {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    const update = () => setCurrent(state);
    listeners.add(update);
    update();
    return () => listeners.delete(update);
  }, []);
  return current;
}

export const getPlaylists = (): State => state;

export const playlistHref = (id: number) => `/playlist/${id}`;
export const playlistContext = (playlist: Pick<PlaylistSummary, 'id' | 'title'>): PlaybackContext => ({
  title: playlist.title,
  href: playlistHref(playlist.id),
});

async function request<T = void>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) sessionExpired();
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Fehler ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Nach der Anmeldung und nach jeder Änderung; Fehler: bleibt beim alten Stand */
export async function loadPlaylists(): Promise<void> {
  const data = await request<{ own: PlaylistSummary[]; shared: PlaylistSummary[] }>('GET', '/api/me/playlists').catch(() => undefined);
  if (data && Array.isArray(data.own)) set({ own: data.own, shared: data.shared ?? [], loaded: true });
}

export function resetPlaylists(): void {
  state = empty();
  listeners.forEach((listener) => listener());
}

export const fetchPlaylist = (id: number) => request<PlaylistDetail>('GET', `/api/me/playlists/${id}`);

export async function createPlaylist(title: string, trackIds: number[] = []): Promise<PlaylistDetail> {
  const playlist = await request<PlaylistDetail>('POST', '/api/me/playlists', { title, trackIds });
  await loadPlaylists();
  return playlist;
}

/** Hängt Titel an; gibt zurück, wie viele neu dazukamen (schon enthaltene zählen nicht). */
export async function addToPlaylist(id: number, trackIds: number[]): Promise<number> {
  const { added } = await request<{ added: number }>('POST', `/api/me/playlists/${id}/tracks`, { trackIds });
  await loadPlaylists();
  return added;
}

export async function setPlaylistTracks(id: number, trackIds: number[]): Promise<void> {
  await request('PUT', `/api/me/playlists/${id}/tracks`, { trackIds });
  await loadPlaylists();
}

export async function renamePlaylist(id: number, title: string): Promise<void> {
  await request('PATCH', `/api/me/playlists/${id}`, { title });
  await loadPlaylists();
}

/** Eigene Playlist löschen bzw. eine geteilte aus der eigenen Liste entfernen */
export async function removePlaylist(id: number): Promise<void> {
  await request('DELETE', `/api/me/playlists/${id}`);
  await loadPlaylists();
}

export async function sharePlaylist(id: number, userIds: number[]): Promise<Person[]> {
  const { sharedWith } = await request<{ sharedWith: Person[] }>('PUT', `/api/me/playlists/${id}/shares`, { userIds });
  await loadPlaylists();
  return sharedWith;
}

export const fetchPeople = async () => (await request<{ items: Person[] }>('GET', '/api/me/people')).items;

/** "Zur Playlist hinzufügen" öffnet die Auswahl über der ganzen App (siehe PlaylistPicker). */
let pickerTracks: Track[] | undefined;
const pickerListeners = new Set<() => void>();

export function addToPlaylistDialog(tracks: Track[]): void {
  if (!tracks.length) return;
  pickerTracks = tracks;
  pickerListeners.forEach((listener) => listener());
  if (!state.loaded) void loadPlaylists();
}

export function closePlaylistDialog(): void {
  pickerTracks = undefined;
  pickerListeners.forEach((listener) => listener());
}

export function usePickerTracks(): Track[] | undefined {
  const [current, setCurrent] = useState(pickerTracks);
  useEffect(() => {
    const update = () => setCurrent(pickerTracks);
    pickerListeners.add(update);
    update();
    return () => pickerListeners.delete(update);
  }, []);
  return current;
}
