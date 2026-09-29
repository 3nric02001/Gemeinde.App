import { describe, expect, it } from 'vitest';
import { extractMetadata, normalizeGenre, UNKNOWN_ARTIST } from '../src/library/metadata.js';
import { flac, mp3 } from './helpers/audio.js';

describe('extractMetadata', () => {
  it('liest ID3v2-Tags aus MP3', async () => {
    const data = mp3({ title: 'Großer Gott', artist: 'Chor', album: 'Lieder', track: 3, year: 2019, genre: 'gospel' });
    const meta = await extractMetadata('x/y/z.mp3', data, 'audio/mpeg');
    expect(meta).toMatchObject({
      title: 'Großer Gott',
      artist: 'Chor',
      album: 'Lieder',
      trackNo: 3,
      year: 2019,
      genre: 'Gospel',
      compilation: false,
    });
  });

  it('liest Vorbis-Kommentare und Dauer aus FLAC', async () => {
    const data = flac({ title: 'Kyrie', artist: 'Ensemble', albumArtist: 'Diverse', album: 'Messe', track: 1, disc: 2 }, 240);
    const meta = await extractMetadata('a/b.flac', data, 'audio/flac');
    expect(meta).toMatchObject({ title: 'Kyrie', albumArtist: 'Diverse', discNo: 2, duration: 240 });
  });

  it('fällt bei fehlenden Tags auf den Pfad zurück', async () => {
    const meta = await extractMetadata('Anna/Erstes Album (2001)/02 Morgenlied.mp3', mp3({}), 'audio/mpeg');
    expect(meta).toMatchObject({ title: 'Morgenlied', artist: 'Anna', album: 'Erstes Album', year: 2001, trackNo: 2 });
  });

  it('sammelt alle Tags für Kategorien, auch eigene Felder', async () => {
    const data = mp3({ title: 'T', artist: 'Chor; Band', genre: 'lied', composer: 'Bach', custom: { Kategorie: 'Musik' } });
    const meta = await extractMetadata('a/b.mp3', data, 'audio/mpeg');
    expect(meta.tags).toEqual([
      ['artist', 'Chor'],
      ['artist', 'Band'],
      ['album', 'a'],
      ['filename', 'b'],
      ['genre', 'Lied'],
      ['composer', 'Bach'],
      ['kategorie', 'Musik'],
    ]);
    const vorbis = await extractMetadata('a/b.flac', flac({ title: 'T', artist: 'A', track: 2, custom: { Sprecher: 'Meier' } }), 'audio/flac');
    expect(vorbis.tags).toEqual([
      ['artist', 'A'],
      ['album', 'a'],
      ['filename', 'b'],
      ['sprecher', 'Meier'],
    ]);
  });

  it('übersteht kaputte Dateien', async () => {
    const meta = await extractMetadata('lose.mp3', Buffer.from('keine musik'), 'audio/mpeg');
    expect(meta).toMatchObject({ title: 'lose', artist: UNKNOWN_ARTIST, album: undefined });
  });
});

describe('normalizeGenre', () => {
  it.each([
    ['rock; pop', 'Rock'],
    ['(17)Rock', 'Rock'],
    ['christian contemporary', 'Christian Contemporary'],
    ['hip-hop', 'Hip-Hop'],
    ['12', undefined],
    ['  ', undefined],
    [undefined, undefined],
  ])('%s → %s', (input, expected) => {
    expect(normalizeGenre(input)).toBe(expected);
  });
});
