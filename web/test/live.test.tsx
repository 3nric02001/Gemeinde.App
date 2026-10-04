/**
 * Eingebettete Seiten nicht wirklich laden
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../src/api';
import { setLivestream } from '../src/auth';
import { NowPlaying } from '../src/components/NowPlaying';
import { PlayerBar } from '../src/components/PlayerBar';
import { Live } from '../src/pages/Live';
import { player } from '../src/player';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const AUDIO = 'https://live.example.org/hls/stream.m3u8';
const stream = { url: 'https://live.example.org/embed/video/', title: 'Gottesdienst live', audio: AUDIO };
const song: Track = {
  id: 42, title: 'Lobpreis', album: 'Lieder', albumId: 9, trackNo: 1, discNo: null, year: 2026, duration: 240,
  mimeType: 'audio/mpeg', hasCover: false, speaker: null,
};

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => (String(input) === '/api/live' ? json({ live: true }) : json({})));
  vi.spyOn(player.audio, 'play').mockResolvedValue(undefined);
  vi.spyOn(player.audio, 'pause').mockImplementation(() => undefined);
  // happy-dom kennt kein HLS; Safari und Android schon
  vi.spyOn(player.audio, 'canPlayType').mockImplementation((type) => (type === 'application/vnd.apple.mpegurl' ? 'maybe' : ''));
  setLivestream(stream);
});

afterEach(() => {
  player.stopLive();
  player.reset();
  setLivestream(null);
  cleanup();
  vi.restoreAllMocks();
});

describe('Livestream im Player', () => {
  it('läuft im Audio-Element der App und erscheint in der Leiste und unter „Jetzt läuft“', () => {
    render(<Live />);
    fireEvent.click(screen.getByRole('button', { name: 'Anhören' }));
    expect(player.audio.src).toBe(AUDIO);
    expect(player.audio.play).toHaveBeenCalled();
    expect(player.getState().live?.title).toBe('Gottesdienst live');
    // Das Bild hält das Handy beim Sperren an: solange der Player den Stream spielt, ist es weg
    expect(document.querySelector('iframe')).toBeNull();
    cleanup();

    const bar = render(<PlayerBar onExpand={() => undefined} />);
    expect(bar.container.querySelector('.player-title')?.textContent).toBe('Gottesdienst live');
    expect(bar.container.querySelector('.player-bar')?.classList.contains('is-empty')).toBe(false);
    cleanup();

    const now = render(<NowPlaying onClose={() => undefined} />);
    expect(now.container.querySelector('.now-label')?.textContent).toBe('Livestream');
    expect(now.container.querySelector('.seek-live')).toBeTruthy();
    // Kein Springen und Spulen im Livestream
    expect(screen.queryByRole('button', { name: 'Weiter' })).toBeNull();
  });

  it('lässt die Warteschlange stehen; ein Titel löst den Stream ab, „Mit Bild“ legt den Titel davor wieder bereit', () => {
    player.playList([song], 0, { shuffle: false });
    player.audio.currentTime = 30;
    player.playLive({ title: stream.title, audio: AUDIO, href: '/live' });
    expect(player.getState().current).toBeUndefined();
    expect(player.getState().queue).toHaveLength(1);
    // Ende des Streams springt nicht zum nächsten Titel
    player.audio.dispatchEvent(new Event('ended'));
    expect(player.getState().live).toBeDefined();
    expect(player.getState().error).toBe('Übertragung beendet');

    render(<Live />);
    fireEvent.click(screen.getByRole('button', { name: 'Mit Bild ansehen' }));
    expect(player.getState().live).toBeUndefined();
    expect(player.getState().current?.id).toBe(42);
    expect(player.audio.src).toContain('/api/tracks/42');
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(stream.url);

    player.playLive({ title: stream.title, audio: AUDIO, href: '/live' });
    player.jump(0);
    expect(player.getState().live).toBeUndefined();
    expect(player.getState().current?.id).toBe(42);
  });

  it('bleibt eingebettet, wenn der Browser HLS nicht selbst abspielt', () => {
    vi.mocked(player.audio.canPlayType).mockReturnValue('');
    render(<Live />);
    expect(screen.queryByRole('button', { name: 'Anhören' })).toBeNull();
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(stream.url);
  });
});
