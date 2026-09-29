import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Admin } from '../src/admin/Admin';
import { adminRequest, setToken } from '../src/admin/api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setToken(null);
});

describe('Verwaltung', () => {
  it('schickt das Admin-Token mit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ok: true }));
    setToken('geheim');
    await adminRequest('PATCH', '/api/admin/albums/1', { hidden: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer geheim');
    expect(init!.body).toBe('{"hidden":true}');
  });

  it('meldet sich mit dem Token an und zeigt die Alben', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/admin/session') return json({ ok: true });
      if (url.startsWith('/api/admin/albums')) {
        return json({
          items: [{ id: 5, title: 'Predigten', artist: 'Pastor Meier', trackCount: 2, kind: 'manual', hidden: false, hasCover: false }],
          total: 1,
          limit: 100,
          offset: 0,
        });
      }
      return json({ error: 'unerwartet' }, 500);
    });
    render(<Admin location={{ path: '/admin', params: new URLSearchParams() }} />);
    fireEvent.input(screen.getByLabelText('Admin-Token'), { target: { value: 'geheim' } });
    fireEvent.click(screen.getByText('Anmelden'));
    await waitFor(() => expect(screen.getByText('Predigten')).toBeTruthy());
    expect(screen.getByText('Eigenes')).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => (init!.headers as Record<string, string>).authorization === 'Bearer geheim')).toBe(true);
  });

  it('fragt bei abgelaufenem Token erneut danach', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'Admin-Token fehlt oder ist falsch' }, 401));
    setToken('alt');
    render(<Admin location={{ path: '/admin', params: new URLSearchParams() }} />);
    await waitFor(() => expect(screen.getByText('Das Admin-Token ist nicht (mehr) gültig.')).toBeTruthy());
  });
});
