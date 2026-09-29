import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCache } from '../src/api';
import { Albums } from '../src/pages/Albums';

afterEach(() => {
  cleanup();
  clearCache();
  vi.restoreAllMocks();
});

function renderAlbums(search: string) {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ items: [], total: 0, limit: 50, offset: 0, genres: [], decades: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
  render(<Albums params={new URLSearchParams(search)} />);
  return () => fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/albums'));
}

describe('Albenseite', () => {
  it('zeigt ohne Auswahl nur Musik, nach Interpret sortiert', async () => {
    const urls = renderAlbums('');
    await vi.waitFor(() => expect(urls()[0]).toContain('dated=false'));
    expect(urls()[0]).toContain('sort=artist');
    expect(screen.getByRole('radio', { name: 'Musik' }).getAttribute('aria-checked')).toBe('true');
  });

  it('zeigt Gottesdienste nach Datum', async () => {
    const urls = renderAlbums('art=gottesdienste');
    await vi.waitFor(() => expect(urls()[0]).toContain('dated=true'));
    expect(urls()[0]).toContain('sort=date');
  });

  it('zeigt bei einem Genre alles, damit nichts fehlt', async () => {
    const urls = renderAlbums('genre=Predigt');
    await vi.waitFor(() => expect(urls()[0]).toContain('genre=Predigt'));
    expect(urls()[0]).not.toContain('dated=');
    expect(screen.getByRole('radio', { name: 'Alle' }).getAttribute('aria-checked')).toBe('true');
  });
});
