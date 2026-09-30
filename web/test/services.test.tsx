import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlbumDetail, Track } from '../src/api';
import { clearCache } from '../src/api';
import { TabBar } from '../src/components/Nav';
import { Album } from '../src/pages/Album';
import { DateFolder } from '../src/pages/DateFolder';
import * as router from '../src/router';

afterEach(() => {
  cleanup();
  clearCache();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const track = (id: number, title: string, speaker: string | null = null): Track => ({
  id, title, album: '2026-09-20', albumId: 9, trackNo: id, discNo: null, year: 2026,
  duration: 120, mimeType: 'audio/mpeg', hasCover: false, albumDate: '2026-09-20', speaker,
});

describe('Seite eines Gottesdienstes', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('heißt wie überall nach dem Anlass und wiederholt ihn nicht bei jedem Titel', async () => {
    const detail: AlbumDetail = {
      id: 9, title: '2026-09-20', year: 2026, trackCount: 2, duration: 240,
      hasCover: false, kind: 'auto', date: '2026-09-20', speaker: 'Pastor Meier', passage: 'Psalm 23; Joh 3,16', description: null,
      tracks: [track(1, 'Lobpreis'), track(2, 'Predigt', 'Pastor Meier')],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      json(String(input).startsWith('/api/albums/9') ? detail : { items: [], total: 0, limit: 13, offset: 0 }),
    );
    render(<Album id={9} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Gottesdienst' })).toBeTruthy();
    // Nach dem Datum kein Name; der Sprecher steht bei der Predigt
    expect(document.querySelector('.hero-sub')!.textContent).toBe('Sonntag, 20. September 2026');
    // Kein "Datum" über dem Titel: das Datum steht schon darunter
    expect(document.querySelector('.hero .eyebrow')).toBeNull();
    // Nur der Sprecher aus dem Dateinamen, kein "So., 20.09.2026" in jeder Zeile
    expect([...document.querySelectorAll('.track-sub')].map((el) => el.textContent)).toEqual(['', 'Pastor Meier']);
    expect(screen.getByLabelText('Zu den Favoriten')).toBeTruthy();
    // Alle Bibelstellen, aber keine Rubrik "Sprecher": ein Gottesdienst hat oft mehrere
    expect([...document.querySelectorAll('.sermon-info dt')].map((el) => el.textContent)).toEqual(['Bibelstellen']);
    expect([...document.querySelectorAll('.sermon-info dd')].map((el) => el.textContent)).toEqual(['Psalm 23', 'Joh 3,16']);
  });

  it('führt ältere Links auf einen Datumsordner zum Album', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ albumId: 9 }));
    render(<DateFolder path="Gottesdienste/2026-09-20" />);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/album/9', { replace: true }));
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

describe('Zurück und Menü auf Albumseiten', () => {
  it('markiert den Bereich, aus dem man kam, und führt ohne Verlauf zur passenden Liste', () => {
    window.history.replaceState({ idx: 0 }, '', '/');
    router.navigate('/datum');
    router.navigate('/album/9');
    expect(router.sectionPath('/album/9')).toBe('/datum');
    render(<TabBar path="/album/9" />);
    expect(screen.getByRole('link', { name: 'Datum' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Alben' }).getAttribute('aria-current')).toBeNull();

    // Direkt auf einem geteilten Link gelandet: kein Verlauf der App, also zur Liste statt aus der App heraus
    window.history.replaceState({ idx: 0 }, '', '/album/9');
    const back = vi.spyOn(window.history, 'back');
    router.goBack('/datum');
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/datum');
  });

  it('fragt vor dem Verlassen einer Seite mit ungespeicherten Änderungen', () => {
    router.navigate('/admin/zuordnung');
    const confirm = vi.fn().mockReturnValue(false);
    router.setLeaveGuard(confirm);
    router.navigate('/admin');
    expect(confirm).toHaveBeenCalled();
    expect(window.location.pathname).toBe('/admin/zuordnung');
    router.setLeaveGuard(undefined);
    router.navigate('/admin');
    expect(window.location.pathname).toBe('/admin');
  });
});
