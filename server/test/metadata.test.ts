import { describe, expect, it } from 'vitest';
import { extractMetadata } from '../src/library/metadata.js';
import { flac, mp3 } from './helpers/audio.js';

describe('extractMetadata', () => {
  it('nimmt Titel, Album, Nummer und Jahr aus dem Pfad, nicht aus den Tags', async () => {
    const data = mp3({ title: 'Anderer Titel', artist: 'Chor', album: 'Anderes Album', track: 7, year: 1980, genre: 'gospel' });
    const meta = await extractMetadata('Chorlieder (2019)/03 Großer Gott.mp3', data, 'audio/mpeg');
    expect(meta).toMatchObject({ title: 'Großer Gott', album: 'Chorlieder', trackNo: 3, year: 2019 });
    expect(meta).not.toHaveProperty('artist');
    expect(meta).not.toHaveProperty('genre');
  });

  it('liest Dauer aus FLAC und Disc-Nummer aus dem Ordner', async () => {
    const data = flac({ title: 'Kyrie', album: 'Messe', track: 1, disc: 2 }, 240);
    const meta = await extractMetadata('Messe/CD 2/01 Kyrie.flac', data, 'audio/flac');
    expect(meta).toMatchObject({ title: 'Kyrie', album: 'Messe', discNo: 2, trackNo: 1, duration: 240 });
  });

  it('rechnet die Dauer einer MP3 mit fester Bitrate auf die ganze Datei hoch', async () => {
    // 1000 Frames zu je 1152 Samples bei 44,1 kHz; gelesen wird wie beim Scan nur der Anfang
    const file = mp3({ title: 'Predigt' }, 1000);
    const seconds = (1000 * 1152) / 44100;
    const whole = await extractMetadata('a/b.mp3', file, 'audio/mpeg', file.length);
    const head = await extractMetadata('a/b.mp3', file.subarray(0, 64 * 1024), 'audio/mpeg', file.length);
    expect(whole.duration).toBeCloseTo(seconds, 0);
    expect(head.duration).toBeCloseTo(seconds, 0);
  });

  it('übersteht kaputte Dateien', async () => {
    const meta = await extractMetadata('lose.mp3', Buffer.from('keine musik'), 'audio/mpeg');
    expect(meta).toMatchObject({ title: 'lose', album: undefined, duration: undefined });
  });
});
