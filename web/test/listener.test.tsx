import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Album, Track } from '../src/api';
import { AlbumCard, AlbumGrid } from '../src/components/AlbumCard';
import { Controls } from '../src/components/Controls';
import { FavoriteButton } from '../src/components/FavoriteButton';
import { TrackList } from '../src/components/TrackList';
import { getMe, loadMe, resetMe } from '../src/me';
import { player } from '../src/player';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sermon: Track = {
  id: 41,
  title: 'Predigt: Psalm 23',
  album: '2026-09-20',
  albumId: 9,
  trackNo: 2,
  discNo: null,
  year: 2026,
  duration: 2400,
  mimeType: 'audio/mpeg',
  hasCover: false,
  albumDate: '2026-09-20',
  speaker: 'Pastor Meier',
};
const song: Track = { ...sermon, id: 42, title: 'Lobpreis', duration: 240, speaker: null, album: '2026-09-27 Erntedank', albumDate: '2026-09-27' };

/** Server-Antworten für Favoriten und Hörstand */
function mockServer(progress: Array<{ trackId: number; position: number; duration: number }> = []) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/me/favorites') return json({ tracks: [], albums: [] });
    if (url === '/api/me/progress') return json({ items: progress });
    if (init?.method === 'PUT' || init?.method === 'DELETE') return new Response(null, { status: 204 });
    return json({});
  });
}

beforeEach(() => resetMe());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Gottesdienste in Listen', () => {
  it('zeigen Anlass, Datum und Sprecher statt des Ordnernamens', () => {
    const { container } = render(<TrackList tracks={[sermon, song]} />);
    expect(screen.getByText('Pastor Meier · So., 20.09.2026')).toBeTruthy();
    expect(screen.getByText('Erntedank, So., 27.09.2026')).toBeTruthy();
    // Ohne Bild ein Kalenderblatt statt "20"
    expect([...container.querySelectorAll('.cover-cal')].map((el) => el.textContent)).toEqual(['Sep20', 'Sep27']);
  });

  it('Listenansicht der Alben zeigt die Länge, aber keinen Sprecher', () => {
    const album: Album = {
      id: 3, title: '2026-09-27 Erntedank', year: 2026, trackCount: 3, duration: 900, hasCover: false, date: '2026-09-27',
      speaker: 'Pastor Meier',
    };
    const { container } = render(<AlbumGrid albums={[album]} list />);
    expect(container.textContent).toContain('15 Min.');
    expect(container.textContent).not.toContain('Pastor Meier');
  });

  it('Albumkarten heißen nach dem Anlass', () => {
    const album: Album = {
      id: 3, title: '2026-09-27 Erntedank', year: 2026, trackCount: 3, duration: 900, hasCover: false, date: '2026-09-27',
    };
    render(<AlbumCard album={album} />);
    expect(screen.getByText('Erntedank')).toBeTruthy();
    expect(screen.getByText('So., 27.09.2026')).toBeTruthy();
  });
});

describe('Weiterhören', () => {
  it('zeigt, wie weit eine Predigt gehört ist', async () => {
    mockServer([{ trackId: 41, position: 600, duration: 2400 }]);
    await loadMe();
    const { container } = render(<TrackList tracks={[sermon]} />);
    expect(screen.getByText('noch 30:00')).toBeTruthy();
    expect((container.querySelector('.track-progress i') as HTMLElement).style.width).toBe('25%');
  });

  it('startet eine angefangene Predigt an der gemerkten Stelle und speichert den Stand beim Wechsel', async () => {
    const fetchMock = mockServer([{ trackId: 41, position: 600, duration: 2400 }]);
    await loadMe();
    vi.spyOn(player.audio, 'play').mockResolvedValue(undefined);
    player.playList([sermon, song], 0, { shuffle: false });
    player.audio.dispatchEvent(new Event('loadedmetadata'));
    expect(player.audio.currentTime).toBe(600);

    player.audio.currentTime = 900;
    player.next();
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/me/progress/41' && init?.method === 'PUT');
    expect(JSON.parse(String(put![1]!.body))).toEqual({ position: 900, duration: 2400 });
    expect(getMe().progress.get(41)).toEqual({ position: 900, duration: 2400 });
  });
});

describe('Predigt-Player', () => {
  it('zeigt bei langen Titeln Sprünge und Tempo statt Zufall und Wiederholen', async () => {
    mockServer();
    vi.spyOn(player.audio, 'play').mockResolvedValue(undefined);
    player.playList([sermon], 0, { shuffle: false });
    render(<Controls />);
    expect(screen.queryByLabelText('Zufallswiedergabe')).toBeNull();
    player.audio.currentTime = 100;
    fireEvent.click(screen.getByLabelText('15 Sekunden zurück'));
    expect(player.audio.currentTime).toBe(85);
    fireEvent.click(screen.getByLabelText('30 Sekunden vor'));
    expect(player.audio.currentTime).toBe(115);

    player.cycleRate();
    expect(player.audio.playbackRate).toBe(1.25);
    // Musik läuft immer im normalen Tempo
    player.playList([song], 0, { shuffle: false });
    expect(player.audio.playbackRate).toBe(1);
    await waitFor(() => expect(screen.getByLabelText('Zufallswiedergabe')).toBeTruthy());
    // Zurück auf 1× für die nächsten Tests
    while (player.getState().rate !== 1) player.cycleRate();
  });
});

describe('Abmelden', () => {
  it('hält den Player an und vergisst die Warteschlange', async () => {
    const fetchMock = mockServer();
    vi.spyOn(player.audio, 'play').mockResolvedValue(undefined);
    vi.spyOn(player.audio, 'pause').mockImplementation(() => undefined);
    player.playList([sermon, song], 0, { shuffle: false });
    player.audio.currentTime = 300;
    localStorage.setItem('gemeinde.player', '{"queue":{}}');

    const { logout } = await import('../src/auth');
    await logout();
    expect(player.getState().current).toBeUndefined();
    expect(player.getState().queue).toEqual([]);
    expect(localStorage.getItem('gemeinde.player')).toBeNull();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    // Der Hörstand geht noch mit der alten Sitzung raus, erst dann die Abmeldung.
    expect(urls.indexOf('/api/me/progress/41')).toBeGreaterThanOrEqual(0);
    expect(urls.indexOf('/api/me/progress/41')).toBeLessThan(urls.indexOf('/api/auth/logout'));
  });
});

describe('Favoriten', () => {
  it('Herz schaltet um und fällt bei einem Fehler zurück', async () => {
    const fetchMock = mockServer();
    await loadMe();
    render(<FavoriteButton kind="track" item={song} />);
    fireEvent.click(screen.getByLabelText('Zu den Favoriten'));
    expect(screen.getByLabelText('Aus den Favoriten entfernen')).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/favorites/track/42', expect.objectContaining({ method: 'PUT' })));

    fetchMock.mockResolvedValue(json({ error: 'kaputt' }, 500));
    fireEvent.click(screen.getByLabelText('Aus den Favoriten entfernen'));
    await waitFor(() => expect(screen.getByLabelText('Aus den Favoriten entfernen')).toBeTruthy());
    expect(getMe().trackIds.has(42)).toBe(true);
  });
});

describe('Wiedergaben zählen', () => {
  it('meldet einen Titel einmal, sobald 30 Sekunden wirklich gehört sind; Springen zählt nicht', () => {
    const fetchMock = mockServer();
    vi.spyOn(player.audio, 'play').mockResolvedValue(undefined);
    vi.spyOn(player.audio, 'paused', 'get').mockReturnValue(false);
    player.playList([song], 0, { shuffle: false });
    const plays = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/me/plays/42' && init?.method === 'POST');
    const listen = (from: number, to: number) => {
      for (let time = from; time <= to; time += 0.25) {
        player.audio.currentTime = time;
        player.audio.dispatchEvent(new Event('timeupdate'));
      }
    };

    listen(0, 20);
    // Sprung nach vorne: die übersprungene Zeit gilt nicht als gehört
    player.audio.currentTime = 150;
    player.audio.dispatchEvent(new Event('timeupdate'));
    expect(plays()).toHaveLength(0);
    listen(150, 162);
    expect(plays()).toHaveLength(1);
    listen(162, 200);
    expect(plays()).toHaveLength(1);
  });
});
