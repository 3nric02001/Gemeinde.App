import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QualityPanel } from '../src/admin/Quality';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Verwaltung → Prüfen', () => {
  it('zeigt Alben ohne Cover-Spalte, damit Titel auf dem Handy lesbar bleiben', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        withoutCover: { total: 0, items: [] },
        servicesWithoutSpeaker: { total: 1, items: [{ id: 7, title: 'Gottesdienst Vormittag', date: '2024-08-04', trackCount: 5 }] },
      }),
    );
    render(<QualityPanel />);

    await waitFor(() => expect(document.querySelector('a[href="/admin/album/7"]')).toBeTruthy());
    const row = document.querySelector('a[href="/admin/album/7"]')!;
    // Ohne admin-row-plain landet der Text in der 44px-Bildspalte und wird zu „Got…“ abgeschnitten
    expect(row.classList.contains('admin-row-plain')).toBe(true);
    expect(row.classList.contains('admin-row-wrap')).toBe(true);
    expect(row.querySelector('.track-title')!.textContent).toContain('Gottesdienst');
    // Interpreten gibt es nicht mehr
    expect(screen.queryByText(/Interpret/)).toBeNull();
  });
});
