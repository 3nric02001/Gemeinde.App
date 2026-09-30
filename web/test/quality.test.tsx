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
        splitFolders: [
          {
            folder: '2024/2024_08_04',
            albums: [{ id: 7, title: 'Gottesdienst Vormittag', artist: 'Gemeinde', date: '2024-08-04', trackCount: 5 }],
          },
        ],
        withoutCover: { total: 0, items: [] },
        servicesWithoutSpeaker: { total: 0, items: [] },
        suspiciousArtists: [{ name: '2024', trackCount: 2 }],
        artistVariants: [],
      }),
    );
    render(<QualityPanel />);

    await waitFor(() => expect(screen.getByText('2024/2024_08_04')).toBeTruthy());
    const row = document.querySelector('a[href="/admin/album/7"]')!;
    // Ohne admin-row-plain landet der Text in der 44px-Bildspalte und wird zu „Got…“ abgeschnitten
    expect(row.classList.contains('admin-row-plain')).toBe(true);
    expect(row.classList.contains('admin-row-wrap')).toBe(true);
    expect(row.querySelector('.track-title')!.textContent).toContain('Gottesdienst');
    expect(screen.getByText('2024').closest('li')!.classList.contains('admin-row-plain')).toBe(true);
  });
});
