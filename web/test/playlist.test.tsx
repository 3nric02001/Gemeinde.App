import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../src/api';
import { NowPlaying } from '../src/components/NowPlaying';
import { PlayerBar } from '../src/components/PlayerBar';
import { TrackList } from '../src/components/TrackList';
import { albumContext, player } from '../src/player';
import * as router from '../src/router';

const track = (id: number, title: string, albumId: number): Track => ({
  id,
  title,
  album: `Album ${albumId}`,
  albumId,
  trackNo: 1,
  discNo: 1,
  year: 2021,
  duration: 185,
  mimeType: 'audio/mpeg',
});

const playlist = { id: 50, title: 'Lieblingslieder', kind: 'manual' as const };
const tracks = [track(1, 'Macht hoch die Tür', 3), track(2, 'Tochter Zion', 4)];

beforeEach(() => {
  vi.spyOn(player.audio, 'play').mockResolvedValue();
  vi.spyOn(player.audio, 'load').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Eigene Alben als Playlist', () => {
  it('gilt nur für eigene Alben', () => {
    expect(albumContext(playlist)).toEqual({ title: 'Lieblingslieder', href: '/album/50' });
    expect(albumContext({ ...playlist, kind: 'auto' })).toBeUndefined();
  });

  it('merkt sich die Playlist, aus der ein Titel läuft', () => {
    render(<TrackList tracks={tracks} variant="album" ordinal from={albumContext(playlist)} />);
    fireEvent.click(screen.getByText('Tochter Zion'));
    expect(player.getState().current?.id).toBe(2);
    expect(player.getState().from).toEqual({ title: 'Lieblingslieder', href: '/album/50' });
  });

  it('führt aus "Jetzt läuft" zurück zur Playlist, das Album bleibt erreichbar', () => {
    player.playList(tracks, 1, { shuffle: false, from: albumContext(playlist) });
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    render(<NowPlaying onClose={() => {}} />);
    expect(screen.getByText('Aus der Playlist')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Tochter Zion')[0]!);
    expect(navigate).toHaveBeenLastCalledWith('/album/50');
    fireEvent.click(screen.getByText('Album 4'));
    expect(navigate).toHaveBeenLastCalledWith('/album/4');
  });

  it('verlinkt in der Leiste die Playlist statt des Quellalbums', () => {
    player.playList(tracks, 0, { shuffle: false, from: albumContext(playlist) });
    render(<PlayerBar onExpand={() => {}} />);
    expect(screen.getByText('Macht hoch die Tür').getAttribute('href')).toBe('/album/50');
  });

  it('bleibt beim normalen Album beim Album des Titels', () => {
    player.playList(tracks, 0, { shuffle: false });
    render(<PlayerBar onExpand={() => {}} />);
    expect(player.getState().from).toBeUndefined();
    expect(screen.getByText('Macht hoch die Tür').getAttribute('href')).toBe('/album/3');
  });

  it('gibt "Als Nächstes spielen" nur den eingefügten Titeln die Playlist mit', () => {
    player.playList([tracks[0]!], 0, { shuffle: false });
    player.playNext([tracks[1]!], albumContext(playlist));
    const [first, second] = player.getState().queue;
    expect(first!.from).toBeUndefined();
    expect(second!.from?.href).toBe('/album/50');
  });
});
