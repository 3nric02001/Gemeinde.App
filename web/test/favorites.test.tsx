import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Album, Track } from '../src/api';
import { loadMe, resetMe } from '../src/me';
import { Favorites } from '../src/pages/Favorites';
import { Home } from '../src/pages/Home';
import { player } from '../src/player';

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
const hymn: Track = { ...song, id: 43, title: 'Choral', albumId: 6, album: 'Chor' };
const album: Album = { id: 5, title: 'Lieder', year: 2020, trackCount: 1, duration: 240, hasCover: false };

let requested: string[] = [];

beforeEach(() => {
  resetMe();
  requested = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === '/api/me/favorites') return json({ tracks: [song, hymn], albums: [album] });
    if (url === '/api/me/progress') return json({ items: [] });
    if (url === '/api/me/home') return json({ resume: [], recent: [] });
    if (url.startsWith('/api/dates')) return json({ items: [], total: 0 });
    if (url === '/api/facets') return json({ totals: { albums: 3, tracks: 9, duration: 1000 }, decades: [], recordings: [] });
    return json({ items: [], total: 0 });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Favoriten', () => {
  it('stehen auf der Startseite statt "Neue Musik", vorne die Playlist', async () => {
    await loadMe();
    render(<Home />);
    await waitFor(() => expect(screen.getByText('Deine Favoriten')).toBeTruthy());
    expect(screen.queryByText('Neue Musik')).toBeNull();
    expect(screen.getByText('Playlist · 2 Titel')).toBeTruthy();
    const cards = [...document.querySelectorAll('.shelf-row .card-title')].map((el) => el.textContent);
    expect(cards).toEqual(['Favoriten', 'Lieder']);
    expect(requested.some((url) => url.includes('sort=recent'))).toBe(false);
  });

  it('lassen sich als Playlist abspielen und führen dorthin zurück', async () => {
    await loadMe();
    const playList = vi.spyOn(player, 'playList').mockImplementation(() => undefined);
    render(<Favorites />);
    expect(screen.getByText('Playlist')).toBeTruthy();
    fireEvent.click(screen.getByText('Abspielen'));
    expect(playList).toHaveBeenCalledWith([song, hymn], 0, { shuffle: false, from: { title: 'Favoriten', href: '/favoriten' } });
    expect(screen.getByText('Alben')).toBeTruthy();
  });
});

describe('Weiterhören auf der Startseite', () => {
  it('zeigt höchstens 3, lässt sich schließen und meldet es dem Server', async () => {
    const sermons = [44, 45, 46, 47].map((id) => ({ ...song, id, albumId: id, title: `Predigt ${id}`, duration: 2400, position: 600 }));
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      requested.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/me/favorites') return json({ tracks: [], albums: [] });
      if (url === '/api/me/progress') return json({ items: sermons.map((t) => ({ trackId: t.id, position: 600, duration: 2400 })) });
      if (url === '/api/me/home') return json({ resume: sermons, recent: [] });
      if (url.startsWith('/api/dates')) return json({ items: [], total: 0 });
      if (url === '/api/facets') return json({ totals: { albums: 3, tracks: 9, duration: 1000 }, decades: [], recordings: [] });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ items: [], total: 0 });
    });
    await loadMe();
    render(<Home />);
    await waitFor(() => expect(screen.getByText('Weiterhören')).toBeTruthy());
    const titles = () => [...document.querySelectorAll('.track-title')].map((el) => el.textContent);
    expect(titles()).toEqual(['Predigt 44', 'Predigt 45', 'Predigt 46']);
    fireEvent.click(screen.getByLabelText('Predigt 44 schließen'));
    expect(titles()).toEqual(['Predigt 45', 'Predigt 46', 'Predigt 47']);
    await waitFor(() => expect(requested).toContain('DELETE /api/me/resume/44'));
  });
});
