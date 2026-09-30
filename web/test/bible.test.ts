import { describe, expect, it } from 'vitest';
import { bibleUrl, splitPassages } from '../src/bible';

describe('Bibelstellen', () => {
  it('trennt mehrere Stellen und lässt leere weg', () => {
    expect(splitPassages('Psalm 23; Joh 3,16;  ')).toEqual(['Psalm 23', 'Joh 3,16']);
    expect(splitPassages(null)).toEqual([]);
  });

  it('öffnet den Text bei bibleserver.com in der gewählten Übersetzung', () => {
    expect(bibleUrl('Joh 3,16', 'LUT')).toBe('https://www.bibleserver.com/LUT/Joh3%2C16');
    expect(bibleUrl('1. Kor 13,1–13', 'ELB')).toBe('https://www.bibleserver.com/ELB/1.Kor13%2C1-13');
    // Ohne Einstellung Luther
    expect(bibleUrl('Psalm 23')).toBe('https://www.bibleserver.com/LUT/Psalm23');
  });
});
