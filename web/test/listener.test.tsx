import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Album, Track } from '../src/api';
import { AlbumCard } from '../src/components/AlbumCard';
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
  artist: 'MBG Brake',
  albumArtist: null,
  album: '2026-09-20',
  albumId: 9,
  trackNo: 2,
  discNo: null,
  year: 2026,
  genre: 'Gottesdienst',
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
    expect(screen.getByText('MBG Brake · Erntedank, So., 27.09.2026')).toBeTruthy();
    // Ohne Bild ein Kalenderblatt statt "20"
    expect([...container.querySelectorAll('.cover-cal')].map((el) => el.textContent)).toEqual(['Sep20', 'Sep27']);
  });

  it('Albumkarten heißen nach dem Anlass', () => {
    const album: Album = {
      id: 3, title: '2026-09-27 Erntedank', artist: 'MBG Brake', year: 2026, genre: 'Gottesdienst',
      trackCount: 3, duration: 900, hasCover: false, date: '2026-09-27',
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
