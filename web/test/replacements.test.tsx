import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplacementsPanel, type Replacement } from '../src/admin/Replacements';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Schreibweisen in der Verwaltung', () => {
  it('zeigt eine Vorschau, speichert eine Ersetzung und löscht sie wieder', async () => {
    let items: Replacement[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/admin/replacements' && method === 'GET') return json({ items });
      if (url === '/api/admin/replacements/preview') {
        return json({
          tracks: { total: 1, items: [{ id: 1, before: 'Tema der Woche', after: 'Thema der Woche' }] },
          albums: { total: 0, items: [] },
        });
      }
      if (url === '/api/admin/replacements' && method === 'POST') {
        items = [{ id: 7, ...JSON.parse(String(init!.body)) }];
        return json(items[0], 201);
      }
      if (url === '/api/admin/replacements/7' && method === 'DELETE') {
        items = [];
        return new Response(null, { status: 204 });
      }
      return json({ error: 'unerwartet' }, 500);
    });
    render(<ReplacementsPanel />);

    fireEvent.input(await screen.findByLabelText('Falsch geschrieben'), { target: { value: 'Tema' } });
    fireEvent.input(screen.getByLabelText('Richtig'), { target: { value: 'Thema' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vorschau' }));
    expect(await screen.findByText('Thema der Woche')).toBeTruthy();
    expect(screen.getByText('1 Titel ändert sich')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Speichern und anwenden' }));
    expect(await screen.findByText(/Gespeichert/)).toBeTruthy();
    expect(screen.getByText('Tema → Thema')).toBeTruthy();
    const posted = fetch.mock.calls.find(([url, init]) => url === '/api/admin/replacements' && init?.method === 'POST');
    expect(JSON.parse(String(posted![1]!.body))).toEqual({ search: 'Tema', replacement: 'Thema', wholeWord: true });
    expect((screen.getByLabelText('Falsch geschrieben') as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: '„Tema“ löschen' }));
    await waitFor(() => expect(screen.queryByText('Tema → Thema')).toBeNull());
  });

  it('zeigt Fehler des Servers an', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'GET') return json({ items: [] });
      return json({ error: 'Für „Tema“ gibt es schon eine Ersetzung' }, 409);
    });
    render(<ReplacementsPanel />);
    fireEvent.input(await screen.findByLabelText('Falsch geschrieben'), { target: { value: 'Tema' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und anwenden' }));
    expect((await screen.findByRole('alert')).textContent).toContain('gibt es schon');
  });
});
