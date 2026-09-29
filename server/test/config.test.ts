import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeMusicPath, parseMusicPaths } from '../src/config.js';

const base = { NEXTCLOUD_URL: 'https://cloud.example.org/', NEXTCLOUD_USER: 'musik', NEXTCLOUD_PASSWORD: 'pw' };

describe('Musikordner', () => {
  it('muss ausdrücklich angegeben werden', () => {
    expect(() => loadConfig(base)).toThrow('NEXTCLOUD_MUSIC_PATH fehlt');
    expect(() => loadConfig({ ...base, NEXTCLOUD_MUSIC_PATH: '  ' })).toThrow('NEXTCLOUD_MUSIC_PATH fehlt');
  });

  it('wird normalisiert', () => {
    expect(loadConfig({ ...base, NEXTCLOUD_MUSIC_PATH: 'Gemeinde//Medien/Musik/' }).nextcloud).toMatchObject({
      url: 'https://cloud.example.org',
      musicPaths: ['/Gemeinde/Medien/Musik'],
    });
    expect(normalizeMusicPath('/')).toBe('');
  });

  it('erlaubt keine relativen Pfadteile', () => {
    expect(() => normalizeMusicPath('/Musik/../Privat')).toThrow('".."');
    expect(() => normalizeMusicPath('./Musik')).toThrow();
  });
});

describe('Mehrere Musikordner', () => {
  it('trennt an Komma, Semikolon und Zeilenumbruch', () => {
    expect(parseMusicPaths('/Gemeinde/Musik, /Gemeinde/Predigten;Jugend/Lieder\n /Archiv/ ')).toEqual([
      '/Gemeinde/Musik',
      '/Gemeinde/Predigten',
      '/Jugend/Lieder',
      '/Archiv',
    ]);
  });

  it('lässt doppelte und verschachtelte Ordner weg', () => {
    expect(parseMusicPaths('/Musik/Chor, /Musik, /Musik/, /Predigten')).toEqual(['/Musik', '/Predigten']);
    expect(parseMusicPaths('/Musik, /')).toEqual(['']);
  });

  it('braucht mindestens einen Ordner', () => {
    expect(() => loadConfig({ ...base, NEXTCLOUD_MUSIC_PATH: ' , ;' })).toThrow('NEXTCLOUD_MUSIC_PATH fehlt');
  });
});
