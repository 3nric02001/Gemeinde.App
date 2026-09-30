import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../src/api';
import { TrackList } from '../src/components/TrackList';
import { player } from '../src/player';

const track = (id: number, title: string, discNo = 1): Track => ({
  id,
  title,
  album: 'Adventskonzert',
  albumId: 1,
  trackNo: id,
  discNo,
  year: 2021,
  duration: 185,
  mimeType: 'audio/mpeg',
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Titelliste', () => {
  it('spielt das Album ab dem angeklickten Titel', () => {
    const playList = vi.spyOn(player, 'playList').mockImplementation(() => {});
    const tracks = [track(1, 'Macht hoch die Tür'), track(2, 'Tochter Zion')];
    render(<TrackList tracks={tracks} variant="album" />);
    fireEvent.click(screen.getByText('Tochter Zion'));
    expect(playList).toHaveBeenCalledWith(tracks, 1, { shuffle: false });
    expect(screen.getAllByText('3:05')).toHaveLength(2);
  });

  it('zeigt das Bild jedes Titels und sonst einen Platzhalter', () => {
    const { container } = render(
      <TrackList tracks={[{ ...track(7, 'Mit Bild'), hasCover: true }, { ...track(8, 'Ohne Bild'), hasCover: false }]} />,
    );
    const images = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(images).toEqual(['/api/tracks/7/cover']);
    expect(container.querySelectorAll('.cover-initials')).toHaveLength(1);
  });

  it('trennt Doppel-CDs mit Zwischenüberschriften', () => {
    render(<TrackList tracks={[track(1, 'A', 1), track(2, 'B', 2)]} variant="album" />);
    expect(screen.getByText('CD 1')).toBeTruthy();
    expect(screen.getByText('CD 2')).toBeTruthy();
  });

  it('nummeriert eigene Alben fortlaufend statt nach Tracknummer', () => {
    render(<TrackList tracks={[track(7, 'A', 1), track(3, 'B', 2)]} variant="album" ordinal />);
    expect(screen.queryByText('CD 2')).toBeNull();
    expect([...document.querySelectorAll('.track-no')].map((el) => el.textContent)).toEqual(['1', '2']);
  });

  it('bietet "Als Nächstes spielen" im Menü an', () => {
    const playNext = vi.spyOn(player, 'playNext').mockImplementation(() => {});
    const t = track(1, 'Macht hoch die Tür');
    render(<TrackList tracks={[t]} />);
    fireEvent.click(screen.getByLabelText('Weitere Aktionen für Macht hoch die Tür'));
    fireEvent.click(screen.getByText('Als Nächstes spielen'));
    expect(playNext).toHaveBeenCalledWith([t]);
  });
});
