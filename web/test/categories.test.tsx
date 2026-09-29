import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Admin } from '../src/admin/Admin';
import { clearCache } from '../src/api';
import { loadAuth } from '../src/auth';
import { Sidebar } from '../src/components/Nav';
import { Category } from '../src/pages/Category';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearCache();
});

/** Verwaltung braucht mindestens die Rolle Manager. */
async function signInAsManager() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ user: { id: 2, name: 'Max', role: 'manager', kind: 'oidc' }, oidc: null }));
  await loadAuth();
  vi.restoreAllMocks();
}

const tagFields = {
  items: [
    { tag: 'genre', trackCount: 3, valueCount: 3, samples: ['Lied', 'Musik', 'Predigt'] },
    { tag: 'kategorie', trackCount: 2, valueCount: 2, samples: ['Musik'] },
  ],
};

describe('Kategorien in der Verwaltung', () => {
  it('legt eine Kategorie mit zusammengefassten Werten an', async () => {
    await signInAsManager();
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/admin/tag-fields') return json(tagFields);
      if (url === '/api/admin/categories/preview') {
        return json({ total: 2, items: [{ value: 'Musik', trackCount: 3, grouped: true, sources: ['Musik', 'Lied'] }, { value: 'Predigt', trackCount: 1, grouped: false }] });
      }
      if (url === '/api/admin/categories' && method === 'POST') return json({ id: 3 }, 201);
      if (url === '/api/admin/categories') return json({ items: [] });
      return json({ error: 'unerwartet' }, 500);
    });
    render(<Admin location={{ path: '/admin/kategorie/neu', params: new URLSearchParams() }} />);

    await waitFor(() => expect(screen.getByText('Genre')).toBeTruthy());
    expect(screen.getByText('3 Titel · z. B. Lied, Musik, Predigt')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Art' } });
    fireEvent.click(screen.getByLabelText(/Genre/));
    fireEvent.click(screen.getByText('+ Zusammenfassung'));
    fireEvent.input(screen.getByLabelText('Anzeigen als'), { target: { value: 'Musik' } });
    fireEvent.input(screen.getByLabelText('Tag-Werte, mit Komma getrennt'), { target: { value: 'Musik, Lied' } });

    await waitFor(() => expect(screen.getByText('Predigt')).toBeTruthy());
    const preview = calls.filter((c) => c.url === '/api/admin/categories/preview').at(-1)!;
    expect(preview.body).toEqual({ fields: ['genre'], groups: [{ label: 'Musik', values: ['Musik', 'Lied'] }], groupedOnly: false });

    fireEvent.click(screen.getByText('Kategorie anlegen'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/admin/categories')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/admin/categories')!.body).toEqual({
      name: 'Art',
      fields: ['genre'],
      groups: [{ label: 'Musik', values: ['Musik', 'Lied'] }],
      inNav: true,
      groupedOnly: false,
    });
  });

  it('zeigt den Inhalt eines Tag-Felds und übernimmt Werte in eine Zusammenfassung', async () => {
    await signInAsManager();
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === '/api/admin/tag-fields') return json(tagFields);
      if (url.startsWith('/api/admin/tag-fields/genre/values')) {
        const all = [{ value: 'Lied', trackCount: 2 }, { value: 'Musik', trackCount: 1 }, { value: 'Predigt', trackCount: 1 }];
        const q = new URL(url, 'http://x').searchParams.get('q');
        const items = q ? all.filter((v) => v.value.toLowerCase().includes(q)) : all;
        return json({ total: items.length, items });
      }
      if (url === '/api/admin/categories/preview') return json({ total: 0, items: [] });
      return json({ error: 'unerwartet' }, 500);
    });
    render(<Admin location={{ path: '/admin/kategorie/neu', params: new URLSearchParams() }} />);

    await waitFor(() => expect(screen.getByText('Inhalt anzeigen (3 Werte)')).toBeTruthy());
    fireEvent.click(screen.getByText('Inhalt anzeigen (3 Werte)'));
    await waitFor(() => expect(screen.getByText('Predigt')).toBeTruthy());
    expect(screen.getByText('Lied').nextSibling!.textContent).toBe('2');

    fireEvent.input(screen.getByLabelText('Werte filtern'), { target: { value: 'pre' } });
    await waitFor(() => expect(screen.queryByText('Lied')).toBeNull());
    expect(urls).toContain('/api/admin/tag-fields/genre/values?q=pre&limit=300');
    fireEvent.input(screen.getByLabelText('Werte filtern'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByText('Lied')).toBeTruthy());

    // Mit einer Zusammenfassung wird ein Klick auf einen Wert übernommen.
    fireEvent.click(screen.getByText('+ Zusammenfassung'));
    fireEvent.input(screen.getByLabelText('Anzeigen als'), { target: { value: 'Musik' } });
    fireEvent.click(screen.getByText('Lied'));
    fireEvent.click(screen.getByText('Musik', { selector: '.value-chip span' }));
    fireEvent.click(screen.getByText('Lied'));
    expect((screen.getByLabelText('Tag-Werte, mit Komma getrennt') as HTMLInputElement).value).toBe('Lied, Musik');
  });

  it('ändert die Reihenfolge', async () => {
    await signInAsManager();
    const categories = [
      { id: 1, name: 'Interpreten', slug: 'interpreten', position: 0, inNav: true, groupedOnly: false, fields: ['artist', 'albumartist'], groups: [] },
      { id: 2, name: 'Genre', slug: 'genre', position: 1, inNav: false, groupedOnly: false, fields: ['genre'], groups: [] },
    ];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') return json({ items: [categories[1], categories[0]] });
      if (String(input) === '/api/admin/categories') return json({ items: categories });
      return json({ error: 'unerwartet' }, 500);
    });
    render(<Admin location={{ path: '/admin/kategorien', params: new URLSearchParams() }} />);
    await waitFor(() => expect(screen.getByText('Interpret, Album-Interpret')).toBeTruthy());
    expect(screen.getByText('Nicht im Menü')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Genre nach oben'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ ids: [2, 1] });
  });
});

describe('Kategorien im Player', () => {
  it('zeigt Kategorien im Menü und ihre Werte', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/categories') {
        return json({ items: [{ id: 3, name: 'Art', slug: 'art', inNav: true }, { id: 2, name: 'Genre', slug: 'genre', inNav: false }] });
      }
      if (url === '/api/categories/art/values') {
        return json({
          category: { id: 3, name: 'Art', slug: 'art', inNav: true },
          items: [{ value: 'Musik', trackCount: 3, grouped: true }, { value: 'Predigt', trackCount: 1, grouped: false }],
        });
      }
      return json({ error: 'unerwartet' }, 500);
    });
    render(<Sidebar path="/kategorie/art" />);
    await waitFor(() => expect(screen.getByText('Art')).toBeTruthy());
    expect(screen.queryByText('Genre')).toBeNull();
    expect(screen.getByText('Art').closest('a')!.getAttribute('aria-current')).toBe('page');
    cleanup();

    render(<Category slug="art" />);
    await waitFor(() => expect(screen.getByText('Musik')).toBeTruthy());
    expect(screen.getByText('Musik').closest('a')!.getAttribute('href')).toBe('/kategorie/art/Musik');
    expect(screen.getByText('2 Einträge')).toBeTruthy();
  });
});
