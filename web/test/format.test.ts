import { describe, expect, it } from 'vitest';
import { query } from '../src/api';
import { formatDuration, formatTime, initials } from '../src/format';
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
