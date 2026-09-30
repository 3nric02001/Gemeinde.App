import { describe, expect, it } from 'vitest';
import { query } from '../src/api';
import {
  albumLabel,
  albumSubtitle,
  albumTitle,
  formatDuration,
  formatLongDate,
  formatMonth,
  formatShortDate,
  formatTime,
  initials,
  withoutDate,
} from '../src/format';
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

  it('zeigt unter dem Anlass nur das Datum, ohne Sprecher', () => {
    const album = {
      id: 1, year: 2026, date: '2026-09-27', trackCount: 3, duration: 0, hasCover: false,
      speaker: null, passage: null, description: null,
    };
    expect(folderSubtitle({ ...album, title: '2026-09-27 Erntedank' })).toBe('So., 27.09.2026');
    expect(folderSubtitle({ ...album, title: '2026-09-27', speaker: 'Pastor Meier' })).toBe('So., 27.09.2026');
  });

  it('benennt Gottesdienste nach Anlass und Datum statt nach dem Ordner', () => {
    expect(withoutDate('27. September 2026 Erntedank')).toBe('Erntedank');
    expect(withoutDate('13.09.2026 Taufgottesdienst')).toBe('Taufgottesdienst');
    expect(withoutDate('Feiert Jesus! 20')).toBe('Feiert Jesus! 20');
    expect(albumTitle('2026-09-27 Erntedank', '2026-09-27')).toBe('Erntedank');
    // Ohne Anlass heißt die Aufnahme wie ihre Art aus der Zuordnung
    expect(albumTitle('2026-09-20', '2026-09-20', 'Gottesdienst')).toBe('Gottesdienst');
    expect(albumTitle('2026-09-20', '2026-09-20')).toBe('Aufnahme');
    expect(albumTitle('Adventskonzert', null)).toBe('Adventskonzert');
    expect(albumLabel('2026-09-27 Erntedank', '2026-09-27')).toBe('Erntedank, So., 27.09.2026');
    expect(albumLabel('2026-09-20', '2026-09-20')).toBe('So., 20.09.2026');
    expect(albumSubtitle({ year: 2026, date: '2026-09-27' })).toBe('So., 27.09.2026');
    // Kein Sprecher am Album: ein Gottesdienst hat oft mehrere
    expect(albumSubtitle({ year: 2026, date: '2026-09-20', speaker: 'Pastor Meier' } as never)).toBe('So., 20.09.2026');
    expect(albumSubtitle({ year: 2018, trackCount: 12 })).toBe('2018 · 12 Titel');
    expect(albumSubtitle({ year: null })).toBe('');
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
