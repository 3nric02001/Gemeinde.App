import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Admin } from '../src/admin/Admin';
import { adminRequest } from '../src/admin/api';
import { getAuth, loadAuth, type CurrentUser } from '../src/auth';
import { Login } from '../src/pages/Login';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const albums = {
  items: [{ id: 5, title: 'Predigten', artist: 'Pastor Meier', trackCount: 2, kind: 'manual', hidden: false, hasCover: false }],
  total: 1,
  limit: 100,
  offset: 0,
};

async function signedInAs(role: CurrentUser['role'] | null, oidc: { label: string } | null = null) {
  const user = role && { id: 1, name: 'Test', role, kind: 'oidc' };
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ user, oidc }));
  await loadAuth();
  vi.restoreAllMocks();
}

function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('/api/admin/albums')) return json(albums);
    if (url === '/api/scan') {
      return json({ state: 'idle', filesSeen: 2, toRead: 0, read: 0, added: 0, updated: 0, removed: 0, failed: 0, lastError: null, lastSuccessAt: null });
    }
    if (url === '/api/admin/users') {
      return json({ items: [{ id: 1, kind: 'local', username: 'admin', name: 'Administrator', email: null, role: 'admin', groups: [], disabled: false, lastLoginAt: null }] });
    }
    return json({ error: 'unerwartet' }, 500);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const at = (path: string) => ({ path, params: new URLSearchParams() });

describe('Verwaltung', () => {
  it('schickt Anfragen mit Sitzungs-Cookie statt Token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ok: true }));
    await adminRequest('PATCH', '/api/admin/albums/1', { hidden: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init!.body).toBe('{"hidden":true}');
  });

  it('geht bei abgelaufener Sitzung zurück zur Anmeldung', async () => {
    await signedInAs('admin');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'Bitte anmelden' }, 401));
    await expect(adminRequest('GET', '/api/admin/albums')).rejects.toThrow('Bitte anmelden');
    expect(getAuth()).toMatchObject({ user: null, notice: 'Bitte melde dich erneut an.' });
  });

  it('zeigt Managern nur die Alben', async () => {
    await signedInAs('manager');
    mockApi();
    render(<Admin location={at('/admin')} />);
    await waitFor(() => expect(screen.getByText('Predigten')).toBeTruthy());
    expect(screen.queryByText('Benutzer')).toBeNull();
    cleanup();
    // Auch direkt aufgerufen keine Benutzerverwaltung
    render(<Admin location={at('/admin/benutzer')} />);
    await waitFor(() => expect(screen.getByText('Alben verwalten')).toBeTruthy());
  });

  it('zeigt Admins Benutzer, Gruppen und Anmeldung', async () => {
    await signedInAs('admin');
    mockApi();
    render(<Admin location={at('/admin/benutzer')} />);
    expect(screen.getByText('Gruppen')).toBeTruthy();
    expect(screen.getByText('Anmeldung')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Lokaler Admin · Benutzername admin', { exact: false })).toBeTruthy());
  });

  it('sperrt Hörer aus', async () => {
    await signedInAs('listener');
    render(<Admin location={at('/admin')} />);
    expect(screen.getByText('Kein Zugriff')).toBeTruthy();
  });
});

describe('Anmeldung', () => {
  it('bietet das Gemeinde-Konto an und den lokalen Admin als Ausweg', async () => {
    await signedInAs(null, { label: 'Mit Gemeinde-Konto anmelden' });
    render(<Login />);
    expect(screen.getByText('Mit Gemeinde-Konto anmelden')).toBeTruthy();
    expect(screen.queryByLabelText('Passwort')).toBeNull();

    fireEvent.click(screen.getByText('Als lokaler Admin anmelden'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ user: { id: 1, name: 'Administrator', role: 'admin', kind: 'local' } }),
    );
    fireEvent.input(screen.getByLabelText('Passwort'), { target: { value: 'geheim-geheim' } });
    fireEvent.click(screen.getByText('Als Admin anmelden'));
    await waitFor(() => expect(getAuth().user).toMatchObject({ role: 'admin' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ username: 'admin', password: 'geheim-geheim' });
  });

  it('zeigt Fehler der Anmeldung', async () => {
    await signedInAs(null);
    render(<Login />);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'Benutzername oder Passwort stimmt nicht' }, 401));
    fireEvent.input(screen.getByLabelText('Passwort'), { target: { value: 'falsch' } });
    fireEvent.click(screen.getByText('Als Admin anmelden'));
    await waitFor(() => expect(screen.getByText('Benutzername oder Passwort stimmt nicht')).toBeTruthy());
  });
});
