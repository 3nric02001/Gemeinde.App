import { describe, expect, it } from 'vitest';
import { findPassage, findPassages, joinPassages } from '../src/library/bible.js';
import { sortKey } from '../src/library/text.js';

describe('sortKey', () => {
  it('sortiert wie im Telefonbuch', () => {
    const names = ['Über uns', 'Zion', 'abend', 'Ärger', 'Der Herr', '10 Gebote', '2 Lieder', 'The Blessing', '„Stille Nacht“', 'Straße'];
    expect([...names].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))).toEqual([
      '2 Lieder', '10 Gebote', 'abend', 'Ärger', 'The Blessing', 'Der Herr', '„Stille Nacht“', 'Straße', 'Über uns', 'Zion',
    ]);
  });
});

describe('findPassage', () => {
  it('erkennt übliche Bibelstellen', () => {
    expect(findPassage('Predigt über Psalm 23')).toBe('Psalm 23');
    expect(findPassage('Joh 3,16')).toBe('Joh 3,16');
    expect(findPassage('1. Kor 13, 1-13 Die Liebe')).toBe('1. Kor 13,1-13');
    expect(findPassage('2026-09-27 Meier - Römer 8')).toBe('Römer 8');
  });

  it('verwechselt Wochentage und Namen ohne Kapitel nicht mit Bibelbüchern', () => {
    expect(findPassage('Mi 18 Uhr Bibelstunde')).toBeUndefined();
    expect(findPassage('Am 27. September')).toBeUndefined();
    expect(findPassage('Johannes Meier')).toBeUndefined();
  });
});

describe('findPassages', () => {
  it('findet alle Bibelstellen im Text', () => {
    expect(findPassages('Lesung Psalm 23 und Joh 3, 16')).toEqual(['Psalm 23', 'Joh 3,16']);
    expect(findPassages('Mi 18 Uhr Bibelstunde')).toEqual([]);
  });
});

describe('joinPassages', () => {
  it('fasst Bibelstellen ohne Doppelte zusammen', () => {
    expect(joinPassages(['Joh 3, 16', undefined, 'Psalm 23; Joh 3,16', ' ', 'psalm 23', 'Römer 8'])).toBe('Joh 3, 16; Psalm 23; Römer 8');
    expect(joinPassages([null, ''])).toBeNull();
  });
});
