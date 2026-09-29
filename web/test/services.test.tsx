import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatedFolderDetail, Track } from '../src/api';
import { clearCache } from '../src/api';
import { TabBar } from '../src/components/Nav';
import { DateFolder } from '../src/pages/DateFolder';

afterEach(() => {
  cleanup();
  clearCache();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const track = (id: number, title: string, artist = 'MBG Brake'): Track => ({
  id, title, artist, albumArtist: null, album: '2026-09-20', albumId: 9, trackNo: id, discNo: null, year: 2026,
  genre: 'Gottesdienst', duration: 120, mimeType: 'audio/mpeg', hasCover: false, albumDate: '2026-09-20', speaker: null,
});

describe('Seite eines Gottesdienstes', () => {
  it('heißt wie überall nach dem Anlass und wiederholt ihn nicht bei jedem Titel', async () => {
    const detail: DatedFolderDetail = {
      folder: 'Gottesdienste/2026-09-20', name: '2026-09-20', date: '2026-09-20', trackCount: 2, duration: 240,
      coverTrackId: null, albumId: 9, speaker: 'Pastor Meier', passage: null, description: null,
      tracks: [track(1, 'Lobpreis'), track(2, 'Predigt', 'Pastor Meier')],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(detail), { headers: { 'content-type': 'application/json' } }));
    render(<DateFolder path="Gottesdienste/2026-09-20" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Gottesdienst' })).toBeTruthy();
    expect(screen.getByText('Sonntag, 20. September 2026 · MBG Brake')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Datum' }).getAttribute('href')).toBe('/datum');
    // Nur der abweichende Interpret, kein "So., 20.09.2026" in jeder Zeile
    expect([...document.querySelectorAll('.track-sub')].map((el) => el.textContent)).toEqual(['', 'Pastor Meier']);
    expect(screen.getByLabelText('Zu den Favoriten')).toBeTruthy();
  });
});

describe('Tab-Leiste', () => {
  const setup = (scrollTop: number) => {
    const main = document.createElement('main');
    main.className = 'main';
    Object.defineProperty(main, 'scrollTop', { value: scrollTop, configurable: true });
    main.scrollTo = vi.fn() as typeof main.scrollTo;
    const input = document.createElement('input');
    input.type = 'search';
    main.append(input);
    document.body.append(main);
    render(<TabBar path="/suche" />);
    return { main, input };
  };

  it('springt beim Tipp auf den aktiven Tab nach oben', () => {
    const { main } = setup(400);
    const tab = screen.getByText('Suche').closest('a')!;
    expect(fireEvent.click(tab)).toBe(false); // kein Seitenwechsel
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('setzt oben angekommen den Cursor ins Suchfeld', () => {
    const { input } = setup(0);
    fireEvent.click(screen.getByText('Suche').closest('a')!);
    expect(document.activeElement).toBe(input);
  });

  it('wechselt bei anderen Tabs ganz normal die Seite', () => {
    setup(400);
    expect(fireEvent.click(screen.getByText('Datum').closest('a')!)).toBe(true);
  });
});
