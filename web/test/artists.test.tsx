import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminNav } from '../src/admin/Access';
import { ArtistsPanel } from '../src/admin/Artists';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const state = {
  items: [
    { name: 'A. Schulz', trackCount: 1, target: null },
    { name: 'Anna Schulz', trackCount: 2, target: null },
    { name: 'Kinder Chor', trackCount: 1, target: null },
    { name: 'Kinderchor', trackCount: 1, target: null },
  ],
  suggestions: [
    { names: ['Anna Schulz', 'A. Schulz'], target: 'Anna Schulz' },
    { names: ['Kinder Chor', 'Kinderchor'], target: 'Kinder Chor' },
  ],
  aliases: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Verwaltung → Interpreten', () => {
  const mock = () =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === '/api/admin/artists') return json(state);
      const body = JSON.parse(String(init?.body ?? '{}'));
      return json({
        ...state,
        items: state.items.map((i) => (body.sources?.includes(i.name) ? { ...i, target: body.target } : i)),
        suggestions: [],
        aliases: (body.sources ?? []).map((source: string) => ({ source, target: body.target })),
      });
    });

  it('führt einen Vorschlag unter dem gewählten Namen zusammen', async () => {
    const fetch = mock();
    render(<ArtistsPanel />);
    // Statt „Kinder Chor“ den Namen ohne Leerzeichen wählen
    fireEvent.click(await screen.findByRole('radio', { name: /^Kinderchor/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Unter „Kinderchor“ zusammenführen' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Unter „Kinderchor“ zusammengeführt'));
    const call = fetch.mock.calls.find(([url]) => String(url) === '/api/admin/artists/merge')!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ sources: ['Kinder Chor'], target: 'Kinderchor' });
    // Danach sind die Namen unter „Zusammengeführt“ zu sehen und lassen sich wieder trennen
    expect(screen.getByRole('button', { name: '„Kinder Chor“ wieder trennen' })).toBeTruthy();
  });

  it('benennt einen einzelnen ausgewählten Namen um', async () => {
    const fetch = mock();
    render(<ArtistsPanel />);
    fireEvent.click(await screen.findByLabelText('A. Schulz auswählen'));
    const input = screen.getByLabelText('„A. Schulz“ umbenennen in') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Anna Schulz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('heißt jetzt „Anna Schulz“'));
    const call = fetch.mock.calls.find(([url]) => String(url) === '/api/admin/artists/merge')!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ sources: ['A. Schulz'], target: 'Anna Schulz' });
  });
});

describe('Navigation der Verwaltung', () => {
  it('gruppiert die Bereiche und zeigt Zugang und Verlauf nur Admins', () => {
    render(<AdminNav path="/admin/album/5" admin={false} />);
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Inhalte', 'Automatik']);
    // Im Album-Editor ist „Alben“ aktiv
    expect(screen.getByRole('link', { name: 'Alben' }).getAttribute('aria-current')).toBe('page');
    cleanup();
    render(<AdminNav path="/admin/interpreten" admin />);
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Inhalte', 'Automatik', 'Zugang', 'Verlauf']);
    expect(screen.getByRole('link', { name: 'Interpreten' }).getAttribute('aria-current')).toBe('page');
  });
});
