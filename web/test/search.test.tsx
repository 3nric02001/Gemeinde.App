import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Album } from '../src/api';
import { clearCache } from '../src/api';
import { loadAuth } from '../src/auth';
import { Search } from '../src/pages/Search';
import { clearSearches, recentSearches } from '../src/searchHistory';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[]) => ({ items, total: items.length, limit: 20, offset: 0 });

const album: Album = {
  id: 3, title: 'Let There Be Light', year: 2016, trackCount: 1, duration: 240, hasCover: false, date: null,
};

const playlist: Album = { ...album, id: 9, title: 'Lieblingslieder', kind: 'manual', year: null, trackCount: 12 };
let tracks: unknown[] = [];

let counted: string[] = [];

beforeEach(async () => {
  counted = [];
  tracks = [];
  clearCache();
  clearSearches();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/auth/status') return json({ user: { id: 7, name: 'Anna', role: 'listener', kind: 'oidc' } });
    if (url === '/api/search/suggestions') return json({ searches: ['Pastor Meier', 'Psalm 23'], albums: [album] });
    if (url === '/api/me/searches') {
      counted.push((JSON.parse(String(init?.body)) as { q: string }).q);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/albums')) {
      if (!url.includes('q=')) return json(page([]));
      return json(page(url.includes('kind=manual') ? [playlist] : [album]));
    }
    if (url.startsWith('/api/tracks')) return json({ ...page(tracks), total: 34 });
    if (url.startsWith('/api/artists')) return json(page([]));
    if (url === '/api/facets') return json({ genres: [], decades: [], totals: { tracks: 1, albums: 1, duration: 240 }, recordings: [] });
    if (url === '/api/categories') return json({ items: [] });
    return json({});
  });
  await loadAuth();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Suchseite ohne Suchbegriff', () => {
  it('zeigt häufige Suchen und oft Gehörtes; ein Klick sucht danach', async () => {
    render(<Search params={new URLSearchParams()} />);
    await screen.findByText('Häufig gesucht');
    expect(screen.getByText('Oft gehört')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Psalm 23' }));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Psalm 23');
  });

  it('merkt sich einen Begriff erst, wenn ein Treffer geöffnet wird', async () => {
    render(<Search params={new URLSearchParams()} />);
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'Hillsong' } });
    await screen.findByRole('heading', { name: 'Alben' });
    const card = screen.getByText('Let There Be Light');
    expect(counted).toEqual([]);
    expect(recentSearches(7)).toEqual([]);
    fireEvent.click(card);
    fireEvent.click(card);
    await waitFor(() => expect(counted).toEqual(['Hillsong']));
    expect(recentSearches(7)).toEqual(['Hillsong']);
    // Einer anderen Person auf demselben Gerät gehört der Verlauf nicht
    expect(recentSearches(8)).toEqual([]);
  });

  it('zeigt den eigenen Verlauf und löscht ihn auf Wunsch', async () => {
    const { rememberSearch } = await import('../src/searchHistory');
    rememberSearch(7, 'Taufe');
    rememberSearch(7, 'Erntedank');
    rememberSearch(7, 'taufe');
    render(<Search params={new URLSearchParams()} />);
    expect(screen.getByText('Zuletzt gesucht')).toBeTruthy();
    expect(recentSearches(7)).toEqual(['taufe', 'Erntedank']);
    fireEvent.click(screen.getByRole('button', { name: 'Verlauf löschen' }));
    expect(screen.queryByText('Zuletzt gesucht')).toBeNull();
  });
});

describe('Suchtreffer', () => {
  it('zeigen Playlists getrennt von Alben und zuerst nur wenige Titel', async () => {
    tracks = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1, title: `Lied ${i + 1}`, album: 'Zion', albumId: 3, trackNo: i + 1, duration: 200, hasCover: false,
    }));
    render(<Search params={new URLSearchParams()} />);
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'Lied' } });
    await screen.findByRole('heading', { name: 'Playlists' });
    expect(screen.getByRole('heading', { name: 'Alben' })).toBeTruthy();
    expect(screen.getByText('Lieblingslieder')).toBeTruthy();
    expect(screen.getByText('Playlist · 12 Titel')).toBeTruthy();
    expect(screen.queryByText('Lied 6')).toBeNull();
    expect(screen.getByText('Lied 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mehr anzeigen' }));
    expect(screen.getByText('Lied 20')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mehr anzeigen' })).toBeNull();
    expect(screen.getByRole('link', { name: '34 Titel anzeigen' })).toBeTruthy();
  });
});
