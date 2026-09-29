import { describe, expect, it } from 'vitest';
import { albumFolderOf, coverRank, dateOfPath, isAudioFile, parsePath } from '../src/library/pathMeta.js';

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

  it('nimmt keinen Jahres-, Datums- oder Sammelordner als Interpreten', () => {
    expect(parsePath('Predigten/2026/2026-09-27 Erntedank/01 Predigt.mp3').artist).toBeUndefined();
    expect(parsePath('Gottesdienste/2026-09-27 Erntedank/Predigt.mp3').artist).toBeUndefined();
    const meta = parsePath('Gottesdienste/2026-09-27 - Erntedank/Predigt.mp3');
    expect(meta.album).toBe('2026-09-27 - Erntedank');
    expect(meta.artist).toBeUndefined();
  });

  it('liest Datum, Sprecher und Titel aus dem Dateinamen', () => {
    expect(parsePath('Predigten 2026/2026-09-27 Meier - Psalm 23.mp3')).toMatchObject({
      date: '2026-09-27',
      artist: 'Meier',
      speaker: 'Meier',
      title: 'Psalm 23',
      album: 'Predigten 2026',
    });
    // "27.09.2026" ist kein Disc 27, Track 9
    const plain = parsePath('Predigten/27.09.2026 Predigt.mp3');
    expect(plain).toMatchObject({ date: '2026-09-27', title: 'Predigt' });
    expect(plain.trackNo).toBeUndefined();
    // Ohne Datum bleibt "Interpret - Titel" ohne Sprecher
    expect(parsePath('Sammlung/Gemischt/Anna - Lied.mp3').speaker).toBeUndefined();
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

  it('fasst Unterordner eines Gottesdienstes zum Gottesdienst zusammen', () => {
    expect(albumFolderOf('GD/2026-09-27/Predigt/x.mp3')).toBe('GD/2026-09-27');
    expect(albumFolderOf('GD/2026-09-27/Lobpreis/CD 1/x.mp3')).toBe('GD/2026-09-27');
    // Unterordner mit eigenem Datum oder Jahr bleiben eigene Alben
    expect(albumFolderOf('Archiv 2019-05-01/Album (2010)/x.mp3')).toBe('Archiv 2019-05-01/Album (2010)');
    expect(albumFolderOf('GD/2026-09-27/2026-09-27 Abend/x.mp3')).toBe('GD/2026-09-27/2026-09-27 Abend');
  });

  it('findet das Datum einer Aufnahme im Ordner oder Dateinamen', () => {
    expect(dateOfPath('GD/2026-09-27/Predigt/x.mp3')).toBe('2026-09-27');
    expect(dateOfPath('Predigten/2025/30.11. Advent.mp3')).toBe('2025-11-30');
    expect(dateOfPath('Musik/Album/01 Lied.mp3')).toBeUndefined();
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
