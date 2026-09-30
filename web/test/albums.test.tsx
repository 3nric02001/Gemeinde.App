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
    .mockImplementation(async () => new Response(JSON.stringify({ items: [], total: 0, limit: 50, offset: 0, decades: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
  render(<Albums params={new URLSearchParams(search)} />);
  return () => fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/albums'));
}

describe('Albenseite', () => {
  it('zeigt ohne Auswahl nur Musik, nach Titel sortiert', async () => {
    const urls = renderAlbums('');
    await vi.waitFor(() => expect(urls()[0]).toContain('section=music'));
    expect(urls()[0]).not.toContain('dated=');
    expect(urls()[0]).toContain('sort=title');
    expect(screen.queryByRole('option', { name: 'Interpret' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Musik' }).getAttribute('aria-checked')).toBe('true');
  });

  it('zeigt Sonstiges nur, wenn es Alben ohne Zuordnung gibt', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const body = String(input).startsWith('/api/facets')
        ? { decades: [], totals: { tracks: 0, albums: 0, duration: 0 }, recordings: [], music: 3, other: 2 }
        : { items: [], total: 0, limit: 50, offset: 0 };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    render(<Albums params={new URLSearchParams('art=sonstiges')} />);
    expect(await screen.findByRole('radio', { name: 'Sonstiges' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Sonstiges' }).getAttribute('aria-checked')).toBe('true');
    const url = fetch.mock.calls.map(([u]) => String(u)).find((u) => u.startsWith('/api/albums'))!;
    expect(url).toContain('section=other');
    expect(url).toContain('sort=title');
  });

  it('zeigt Gottesdienste nach Datum', async () => {
    const urls = renderAlbums('art=gottesdienste');
    await vi.waitFor(() => expect(urls()[0]).toContain('dated=true'));
    expect(urls()[0]).toContain('sort=date');
  });

  it('zeigt bei einem Jahrzehnt alles, damit nichts fehlt', async () => {
    const urls = renderAlbums('decade=2020');
    await vi.waitFor(() => expect(urls()[0]).toContain('decade=2020'));
    expect(urls()[0]).not.toContain('dated=');
    expect(screen.getByRole('radio', { name: 'Alle' }).getAttribute('aria-checked')).toBe('true');
  });

  it('filtert Aufnahmen je Art aus der Zuordnung', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const body = String(input).startsWith('/api/facets')
        ? { decades: [], totals: { tracks: 0, albums: 0, duration: 0 }, recordings: [
            { name: 'Bibelstunde', plural: 'Bibelstunden', count: 2 },
            { name: 'Gottesdienst', plural: 'Gottesdienste', count: 5 },
          ] }
        : { items: [], total: 0, limit: 50, offset: 0 };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    render(<Albums params={new URLSearchParams('art=Bibelstunde')} />);
    expect(await screen.findByRole('radio', { name: 'Bibelstunden' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Bibelstunden' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Gottesdienste' })).toBeTruthy();
    const url = fetch.mock.calls.map(([u]) => String(u)).find((u) => u.startsWith('/api/albums'))!;
    expect(url).toContain('recording=Bibelstunde');
    expect(url).toContain('dated=true');
    expect(url).toContain('sort=date');
  });
});
