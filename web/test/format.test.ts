import { describe, expect, it } from 'vitest';
import { query } from '../src/api';
import { formatDuration, formatLongDate, formatMonth, formatShortDate, formatTime, initials } from '../src/format';
import { folderSubtitle } from '../src/pages/Dates';
import { match } from '../src/router';

describe('Formatierung', () => {
  it('zeigt Zeiten wie ein Player', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(null)).toBe('–:––');
    expect(formatTime(Number.NaN)).toBe('–:––');
  });

  it('fasst Albumlängen zusammen', () => {
    expect(formatDuration(59)).toBe('1 Min.');
    expect(formatDuration(3600)).toBe('1 Std.');
    expect(formatDuration(4380)).toBe('1 Std. 13 Min.');
  });

  it('zeigt Datum mit Wochentag', () => {
    expect(formatLongDate('2026-09-27')).toBe('Sonntag, 27. September 2026');
    expect(formatMonth('2026-09-27')).toBe('September 2026');
    expect(formatShortDate('2026-09-06')).toBe('Sonntag, 06.09.2026');
  });

  it('zeigt unter dem Datum den Rest des Ordnernamens', () => {
    const folder = { folder: 'x', date: '2026-09-27', trackCount: 3, duration: 0, coverTrackId: null };
    expect(folderSubtitle({ ...folder, name: '2026-09-27 Erntedank' })).toBe('Erntedank');
    expect(folderSubtitle({ ...folder, name: 'GD 27.09.2026' })).toBe('GD');
    expect(folderSubtitle({ ...folder, name: '2026-09-27' })).toBe('3 Titel');
  });

  it('bildet Initialen für Platzhalter', () => {
    expect(initials('Feiert Jesus! 20')).toBe('FJ');
    expect(initials('Über den Wolken')).toBe('ÜD');
    expect(initials('   ')).toBe('');
  });

  it('baut Abfragen ohne leere Werte', () => {
    expect(query({ q: 'Tochter Zion', genre: undefined, decade: 1990, sort: '' })).toBe('?q=Tochter+Zion&decade=1990');
    expect(query({})).toBe('');
  });

  it('erkennt Pfade mit Parametern', () => {
    expect(match('/album/:id', '/album/12')).toEqual({ id: '12' });
    expect(match('/interpret/:name', '/interpret/J.%20S.%20Bach')).toEqual({ name: 'J. S. Bach' });
    expect(match('/album/:id', '/album')).toBeUndefined();
  });
});
