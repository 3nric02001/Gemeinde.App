import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../src/api';
import { NowPlaying } from '../src/components/NowPlaying';
import { loadMe, resetMe } from '../src/me';
import { player } from '../src/player';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const song: Track = {
  id: 42, title: 'Lobpreis', album: 'Lieder', albumId: 9, trackNo: 1, discNo: null, year: 2026, duration: 240,
  mimeType: 'audio/mpeg', hasCover: false, speaker: null,
};
const other: Track = { ...song, id: 43, title: 'Danklied', trackNo: 2 };
const sermon: Track = { ...song, id: 41, title: 'Predigt: Psalm 23', duration: 2400, albumDate: '2026-09-20', speaker: 'Pastor Meier' };

function mockServer(progress: Array<{ trackId: number; position: number; duration: number }> = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/me/progress') return json({ items: progress });
    if (url === '/api/me/favorites') return json({ tracks: [], albums: [] });
    if (init?.method === 'PUT' || init?.method === 'POST') return new Response(null, { status: 204 });
    return json({});
  });
}

/** Quelle gesetzt (die Prüfung auf eine Offline-Kopie kann asynchron sein) */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Zeit am Audio-Element setzen, wie es der Browser beim Abspielen tut */
function playTo(seconds: number) {
  act(() => {
    player.audio.currentTime = seconds;
    player.audio.dispatchEvent(new Event('timeupdate'));
  });
}

beforeEach(() => {
  resetMe();
  vi.spyOn(player.audio, 'play').mockResolvedValue(undefined);
  vi.spyOn(player.audio, 'pause').mockImplementation(() => undefined);
  // happy-dom setzt die Zeit beim Quellwechsel nicht zurück
  player.audio.currentTime = 0;
});

afterEach(() => {
  player.reset();
  cleanup();
  vi.restoreAllMocks();
});

describe('Fortschrittsbalken in „Jetzt läuft“', () => {
  it('springt erst beim Loslassen und folgt danach wieder der Wiedergabe, auch nach einem Neustart', () => {
    mockServer();
    player.playList([song, other], 0, { shuffle: false });
    // NowPlaying lädt preact/compat (createPortal): das machte aus onChange am Regler onInput
    const { container } = render(<NowPlaying onClose={() => undefined} />);
    const range = container.querySelector('.seek input') as HTMLInputElement;
    const time = () => container.querySelector('.seek-time')?.textContent;
    playTo(30);
    expect(time()).toBe('0:30');

    // Ziehen: Anzeige folgt dem Finger, die Wiedergabe springt noch nicht
    fireEvent.input(range, { target: { value: '100' } });
    expect(time()).toBe('1:40');
    expect(player.audio.currentTime).toBe(30);
    // Loslassen; fireEvent.change von @testing-library/preact feuert input, daher das echte Ereignis
    range.dispatchEvent(new Event('change'));
    expect(player.audio.currentTime).toBe(100);

    // Danach zeigt der Balken wieder die echte Stelle, nicht den gezogenen Wert
    playTo(101);
    expect(time()).toBe('1:41');
    expect(range.style.getPropertyValue('--fill')).toBe(`${(101 / 240) * 100}%`);

    // Zurück an den Anfang („erneut starten“)
    act(() => {
      player.previous();
      player.audio.dispatchEvent(new Event('seeking'));
    });
    expect(time()).toBe('0:00');
    playTo(2);
    expect(time()).toBe('0:02');
  });

  it('vergisst einen angefangenen Ziehwert, wenn ein anderer Titel startet', () => {
    mockServer();
    player.playList([song, other], 0, { shuffle: false });
    const { container } = render(<NowPlaying onClose={() => undefined} />);
    const range = container.querySelector('.seek input') as HTMLInputElement;
    fireEvent.input(range, { target: { value: '200' } });
    act(() => player.next());
    act(() => {
      player.audio.currentTime = 0;
      player.audio.dispatchEvent(new Event('timeupdate'));
    });
    expect(container.querySelector('.seek-time')?.textContent).toBe('0:00');
  });

  it('springt ohne Ziehen nicht, wenn der Regler nur angetippt und losgelassen wird', () => {
    mockServer();
    player.playList([song], 0, { shuffle: false });
    const { container } = render(<NowPlaying onClose={() => undefined} />);
    const range = container.querySelector('.seek input') as HTMLInputElement;
    playTo(30);
    fireEvent.pointerUp(range);
    expect(player.audio.currentTime).toBe(30);
  });
});

describe('Gemerkte Stelle beim Start', () => {
  it('gilt nur für die Predigt, nicht für einen Titel, der vor dem Laden gewählt wird', async () => {
    mockServer([{ trackId: 41, position: 600, duration: 2400 }]);
    await loadMe();
    player.playList([sermon], 0, { shuffle: false });
    await settled();
    // Noch bevor die Predigt geladen ist, ein anderer Titel
    player.playList([song], 0, { shuffle: false });
    await settled();
    player.audio.currentTime = 0;
    player.audio.dispatchEvent(new Event('loadedmetadata'));
    expect(player.audio.currentTime).toBe(0);

    // Die Predigt selbst beginnt weiterhin an der gemerkten Stelle
    player.playList([sermon], 0, { shuffle: false });
    await settled();
    player.audio.dispatchEvent(new Event('loadedmetadata'));
    expect(player.audio.currentTime).toBe(600);
  });
});
