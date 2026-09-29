import { describe, expect, it } from 'vitest';
import { albumFolderOf, coverRank, isAudioFile, parsePath } from '../src/library/pathMeta.js';

describe('parsePath', () => {
  it('liest Interpret/Album/NN - Titel', () => {
    expect(parsePath('Queen/A Night at the Opera/11 - Bohemian Rhapsody.mp3')).toEqual({
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      album: 'A Night at the Opera',
      trackNo: 11,
      albumFolder: 'Queen/A Night at the Opera',
    });
  });

  it('erkennt Jahr im Albumordner und Disc-Unterordner', () => {
    const meta = parsePath('Bach/Weihnachtsoratorium (1998)/CD 2/03 Choral.flac');
    expect(meta).toMatchObject({
      title: 'Choral',
      artist: 'Bach',
      album: 'Weihnachtsoratorium',
      year: 1998,
      discNo: 2,
      trackNo: 3,
      albumFolder: 'Bach/Weihnachtsoratorium (1998)',
    });
  });

  it('lässt ein Datum im Ordnernamen stehen, trennt aber "1999 - Album"', () => {
    expect(parsePath('Gottesdienste/2026/2026-09-27 Erntedank/01 Predigt.mp3').album).toBe('2026-09-27 Erntedank');
    expect(parsePath('Chor/1999 - Konzert/01 Lied.mp3')).toMatchObject({ album: 'Konzert', year: 1999 });
  });

  it('erkennt "Interpret - Album" als Ordnername und Disc-Track im Dateinamen', () => {
    expect(parsePath('Lobpreis/Hillsong - Let There Be Light/1-04 What a Beautiful Name.mp3')).toMatchObject({
      artist: 'Hillsong',
      album: 'Let There Be Light',
      discNo: 1,
      trackNo: 4,
      title: 'What a Beautiful Name',
    });
  });

  it('nimmt Interpret aus dem Dateinamen vor dem Ordner', () => {
    expect(parsePath('Sammlung/Gemischt/Anna - Lied.mp3')).toMatchObject({ artist: 'Anna', title: 'Lied' });
  });

  it('kommt mit Dateien direkt im Musikordner zurecht', () => {
    expect(parsePath('lied_ohne_ordner.mp3')).toEqual({ title: 'lied ohne ordner', albumFolder: '' });
  });
});

describe('Hilfsfunktionen', () => {
  it('fasst Disc-Ordner zum Album zusammen', () => {
    expect(albumFolderOf('A/B/Disc 1/x.mp3')).toBe('A/B');
    expect(albumFolderOf('A/B/x.mp3')).toBe('A/B');
  });

  it('erkennt Audio- und Coverdateien', () => {
    expect(isAudioFile('a/b.FLAC')).toBe(true);
    expect(isAudioFile('a/b.txt')).toBe(false);
    expect(coverRank('a/cover.jpg')).toBe(0);
    expect(coverRank('a/folder.png')).toBe(1);
    expect(coverRank('a/scan.jpg')).toBeGreaterThan(1);
    expect(coverRank('a/notes.pdf')).toBeUndefined();
  });
});
