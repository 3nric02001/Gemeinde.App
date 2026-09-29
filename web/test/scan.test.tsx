import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScanPanel, type ScanStatus } from '../src/admin/Scan';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const base: ScanStatus = {
  state: 'idle',
  startedAt: '2026-09-29T12:00:00.000Z',
  finishedAt: '2026-09-29T12:05:00.000Z',
  filesSeen: 1200,
  toRead: 3,
  read: 3,
  added: 3,
  updated: 0,
  removed: 0,
  failed: 0,
  lastError: null,
  lastSuccessAt: '2026-09-29T12:05:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Scan in der Verwaltung', () => {
  it('zeigt den letzten Stand', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(base));
    render(<ScanPanel />);
    await waitFor(() => expect(screen.getByText('1.200 Titel in der Nextcloud, zuletzt 3 neu.')).toBeTruthy());
    expect(screen.getByText('Jetzt scannen')).toBeTruthy();
  });

  it('zeigt Fehler des letzten Scans', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        ...base,
        state: 'failed',
        lastError: 'PROPFIND /: Nextcloud lehnt die Anmeldung ab (NEXTCLOUD_USER/NEXTCLOUD_PASSWORD prüfen)',
      }),
    );
    render(<ScanPanel />);
    await waitFor(() => expect(screen.getByText('Der letzte Scan ist fehlgeschlagen.')).toBeTruthy());
    expect(screen.getByText('Fehler: PROPFIND /: Nextcloud lehnt die Anmeldung ab', { exact: false })).toBeTruthy();
  });

  it('meldet einzelne unlesbare Dateien', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ...base, failed: 2, lastError: 'a.mp3: HTTP 500' }));
    render(<ScanPanel />);
    await waitFor(() => expect(screen.getByText('2 Dateien konnten nicht gelesen werden.')).toBeTruthy());
    expect(screen.getByText('Erste Ursache: a.mp3: HTTP 500')).toBeTruthy();
  });

  it('startet einen Scan und zeigt den Fortschritt, bis er fertig ist', async () => {
    const running = { ...base, state: 'running', toRead: 1200, read: 0, added: 0 };
    const responses = [
      json(base),
      json({ started: true, status: running }),
      json({ ...running, read: 400 }),
      json({ ...base, added: 0, updated: 1200 }),
    ];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!);
    render(<ScanPanel />);
    await waitFor(() => expect((screen.getByText('Jetzt scannen') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('Jetzt scannen'));
    await waitFor(() => expect(screen.getByText('Scan läuft: 0 von 1.200 Dateien gelesen')).toBeTruthy());
    expect(fetchMock.mock.calls[1]![1]!.method).toBe('POST');
    expect((screen.getByText('Scan läuft …') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByText('Scan läuft: 400 von 1.200 Dateien gelesen')).toBeTruthy(), { timeout: 5000 });
    await waitFor(() => expect(screen.getByText('1.200 Titel in der Nextcloud, zuletzt 1.200 geändert.')).toBeTruthy(), {
      timeout: 5000,
    });
  }, 10000);

  it('zeigt, wenn der Server den Start ablehnt', async () => {
    const responses = [json(base), json({ error: 'Anfrage von fremder Seite abgelehnt' }, 403)];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!);
    render(<ScanPanel />);
    await waitFor(() => expect((screen.getByText('Jetzt scannen') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('Jetzt scannen'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Anfrage von fremder Seite abgelehnt'));
  });
});
