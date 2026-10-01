import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../src/api';
import { PlaylistPicker } from '../src/components/PlaylistPicker';
import { TrackList } from '../src/components/TrackList';
import { Home } from '../src/pages/Home';
import { Playlists } from '../src/pages/Playlists';
import { UserPlaylist } from '../src/pages/UserPlaylist';
import { loadMe, resetMe, saveProgress } from '../src/me';
import { player } from '../src/player';
import { closePlaylistDialog, loadPlaylists, resetPlaylists, type PlaylistDetail, type PlaylistSummary } from '../src/playlists';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const song: Track = {
  id: 42,
  title: 'Lobpreis',
  album: 'Lieder',
  albumId: 5,
  trackNo: 1,
  discNo: null,
  year: 2020,
  duration: 240,
  mimeType: 'audio/mpeg',
  hasCover: false,
};
const hymn: Track = { ...song, id: 43, title: 'Choral' };

const summary = (over: Partial<PlaylistSummary>): PlaylistSummary => ({
  id: 1,
  title: 'Sonntag',
  trackCount: 2,
  duration: 480,
  mine: true,
  owner: 'Anna',
  shared: 0,
  coverTrackId: null,
  updatedAt: 1,
  ...over,
});
const own = summary({});
const fromBen = summary({ id: 2, title: 'Chorprobe', mine: false, owner: 'Ben' });

let calls: Array<{ url: string; method: string; body?: unknown }> = [];
let detail: PlaylistDetail;

beforeEach(() => {
  resetMe();
  resetPlaylists();
  closePlaylistDialog();
  calls = [];
  detail = { ...own, tracks: [song, hymn], sharedWith: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/me/playlists' && method === 'GET') return json({ own: [own], shared: [fromBen] });
    if (url === '/api/me/playlists/1' && method === 'GET') return json(detail);
    if (url === '/api/me/playlists/2' && method === 'GET') return json({ ...fromBen, tracks: [song], sharedWith: [] });
    if (url === '/api/me/playlists/1/tracks' && method === 'POST') return json({ added: 1 });
    if (url === '/api/me/home')
      return json({
        resume: [],
        recent: [{ id: 5, title: 'Lieder', year: 2020, trackCount: 1, duration: 240, hasCover: false, kind: 'auto', section: 'music', playedAt: 10 }],
        recentPlaylists: [{ ...own, playedAt: 20 }],
        favoritesPlayedAt: 30,
      });
    if (url === '/api/me/favorites') return json({ tracks: [song], albums: [] });
    if (url === '/api/facets') return json({ totals: { albums: 3, tracks: 9, duration: 1000 }, decades: [], recordings: [] });
    if (url === '/api/me/people') return json({ items: [{ id: 7, name: 'Ben' }, { id: 8, name: 'Carla' }] });
    if (url === '/api/me/playlists/1/shares') return json({ sharedWith: [{ id: 7, name: 'Ben' }] });
    if (method !== 'GET') return new Response(null, { status: 204 });
    return json({ items: [], total: 0 });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('eigene Playlists', () => {
  it('Titel lassen sich über das Menü zu einer Playlist hinzufügen', async () => {
    await loadPlaylists();
    render(
      <>
        <TrackList tracks={[song]} />
        <PlaylistPicker />
      </>,
    );
    fireEvent.click(screen.getByLabelText('Weitere Aktionen für Lobpreis'));
    fireEvent.click(screen.getByText('Zur Playlist hinzufügen …'));
    fireEvent.click(await screen.findByText('Sonntag'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/me/playlists/1/tracks')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ trackIds: [42] });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('zeigt eigene und geteilte getrennt', async () => {
    render(<Playlists />);
    await screen.findByText('Sonntag');
    expect(screen.getByText('Geteilt mit mir')).toBeTruthy();
    expect(screen.getByText('Chorprobe')).toBeTruthy();
    expect(screen.getByText('Von Ben')).toBeTruthy();
  });

  it('der Besitzer teilt sie mit ausgewählten Personen', async () => {
    render(<UserPlaylist id={1} />);
    await screen.findByText('Nur für dich');
    fireEvent.click(screen.getByText('Teilen'));
    fireEvent.click(await screen.findByText('Ben'));
    fireEvent.click(screen.getByText('Speichern'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/me/playlists/1/shares')).toBe(true));
    expect(calls.find((c) => c.url === '/api/me/playlists/1/shares')!.body).toEqual({ userIds: [7] });
    await waitFor(() => expect(document.querySelector('.hero-sub')?.textContent).toBe('Geteilt mit Ben'));
  });

  it('der Besitzer entfernt Titel, die Reihenfolge geht an den Server', async () => {
    render(<UserPlaylist id={1} />);
    await screen.findByText('Lobpreis');
    fireEvent.click(screen.getByLabelText('Weitere Aktionen für Lobpreis'));
    fireEvent.click(screen.getByText('Aus der Playlist entfernen'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/me/playlists/1/tracks')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ trackIds: [43] });
    expect(screen.queryByText('Lobpreis')).toBeNull();
  });

  it('Empfänger hören nur zu und können sie aus ihrer Liste entfernen', async () => {
    const playList = vi.spyOn(player, 'playList').mockImplementation(() => undefined);
    render(<UserPlaylist id={2} />);
    await screen.findByText('Von Ben');
    expect(screen.getByText('Geteilte Playlist')).toBeTruthy();
    expect(screen.queryByText('Teilen')).toBeNull();
    fireEvent.click(screen.getByText('Abspielen'));
    expect(playList).toHaveBeenCalledWith([song], 0, { shuffle: false, from: { title: 'Chorprobe', href: '/playlist/2' } });
    fireEvent.click(screen.getByLabelText('Weitere Aktionen für Chorprobe'));
    expect(screen.getByText('Aus meiner Liste entfernen')).toBeTruthy();
    expect(screen.queryByText('Umbenennen')).toBeNull();
    fireEvent.click(screen.getByLabelText('Weitere Aktionen für Lobpreis'));
    expect(screen.queryByText('Aus der Playlist entfernen')).toBeNull();
  });

  it('stehen mit den Favoriten unter "Zuletzt gehört" zwischen den Alben, nach Zeit geordnet und immer frisch', async () => {
    await loadMe();
    const { unmount } = render(<Home />);
    await screen.findByText('Zuletzt gehört');
    const shelf = () => screen.getByText('Zuletzt gehört').closest('.shelf')!;
    await waitFor(() =>
      expect([...shelf().querySelectorAll('.card-title')].map((el) => el.textContent)).toEqual(['Favoriten', 'Sonntag', 'Lieder']),
    );
    // Zurück auf die Startseite: neu laden, nicht den Stand von eben zeigen
    unmount();
    render(<Home />);
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/me/home')).toHaveLength(2));
  });

  it('der Hörstand nennt die Playlist, aus der ein Titel läuft', async () => {
    saveProgress({ id: 42, duration: 240 }, 30, '/playlist/1');
    saveProgress({ id: 43, duration: 240 }, 30, '/suche');
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/me/progress/'))).toHaveLength(2));
    const bodies = calls.filter((c) => c.url.startsWith('/api/me/progress/')).map((c) => c.body);
    expect(bodies).toEqual([
      { position: 30, duration: 240, context: '/playlist/1' },
      { position: 30, duration: 240 },
    ]);
  });
});
