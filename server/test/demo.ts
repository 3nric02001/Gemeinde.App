// Startet den Server mit simulierter Nextcloud und Beispielalben: `npm run demo`, dann http://localhost:3000
import { deflateSync } from 'node:zlib';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mp3 } from './helpers/audio.js';
import { FakeNextcloud, PASSWORD, USER } from './helpers/fakeNextcloud.js';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(r1: number[], r2: number[], size = 300): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(r1[i]! * (1 - t) + r2[i]! * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const cloud = new FakeNextcloud('/Musik');
await cloud.start();
const albums: Array<[string, string, number, string, string[], number[][] | null]> = [
  ['Hillsong', 'Let There Be Light', 2016, 'Worship', ['Behold', 'What a Beautiful Name', 'Let There Be Light', 'Crowns', 'Love So Great'], [[40, 40, 60], [200, 170, 120]]],
  ['Gemeindechor Brake', 'Adventskonzert', 2021, 'Chor', ['Macht hoch die Tür', 'Tochter Zion', 'O komm, o komm, du Morgenstern', 'Es kommt ein Schiff geladen'], [[120, 20, 30], [240, 220, 200]]],
  ['J. S. Bach', 'Weihnachtsoratorium', 1998, 'Klassik', ['Jauchzet, frohlocket', 'Und es waren Hirten', 'Ehre sei Gott'], [[20, 30, 40], [180, 160, 90]]],
  ['Outbreakband', 'Unser Gott', 2018, 'Worship', ['Königlich', 'Unser Gott', 'Majestät'], null],
  ['Feiert Jesus', 'Feiert Jesus! 20', 2014, 'Lobpreis', ['Lied Eins', 'Lied Zwei', 'Lied Drei', 'Lied Vier'], [[230, 120, 40], [250, 230, 90]]],
  ['Arne Kopfermann', 'Liebe, die sich verschenkt', 2012, 'Lobpreis', ['Hier bin ich', 'Liebe, die sich verschenkt'], [[30, 90, 80], [200, 230, 210]]],
  ['Jugendchor', 'Sommerfreizeit', 2023, 'Chor', ['Du bist Herr', 'Meine Hoffnung', 'Vater unser'], null],
  ['Sefora Nelson', 'Liebe, die bleibt', 2019, 'Pop', ['Liebe, die bleibt', 'Gnade'], [[70, 60, 120], [240, 200, 220]]],
];
for (const [artist, album, year, genre, titles, colors] of albums) {
  titles.forEach((title, i) =>
    cloud.put(`${artist}/${album}/${String(i + 1).padStart(2, '0')} ${title}.mp3`, mp3({ title, artist, album, track: i + 1, year, genre }, 3000 + i * 800)),
  );
  if (colors) cloud.put(`${artist}/${album}/cover.png`, png(colors[0]!, colors[1]!));
}
// Gottesdienst-Mitschnitte mit Predigten, um eigene Alben im Admin-Bereich auszuprobieren
for (const [date, preacher, text] of [['2024-03-03', 'Pastor Meier', 'Psalm 23'], ['2024-03-10', 'Pastorin Schulz', 'Römer 8']] as const) {
  const album = `Gottesdienst ${date}`;
  cloud.put(`Gottesdienste/${date}/01 Begrüßung.mp3`, mp3({ title: 'Begrüßung', artist: 'Gemeinde', album, track: 1, year: 2024, genre: 'Gottesdienst' }, 2000));
  cloud.put(`Gottesdienste/${date}/02 Lobpreis.mp3`, mp3({ title: 'Lobpreis', artist: 'Lobpreisteam', album, track: 2, year: 2024, genre: 'Gottesdienst' }, 3000));
  cloud.put(`Gottesdienste/${date}/03 Predigt ${text}.mp3`, mp3({ title: `Predigt: ${text}`, artist: preacher, album, track: 3, year: 2024, genre: 'Gottesdienst' }, 5000));
}
const config = loadConfig({
  NEXTCLOUD_URL: cloud.url, NEXTCLOUD_USER: USER, NEXTCLOUD_PASSWORD: PASSWORD, NEXTCLOUD_MUSIC_PATH: '/Musik',
  DATABASE_PATH: ':memory:', WEB_DIR: '../web/dist', PORT: '3000', ADMIN_TOKEN: 'demo',
});
const { app, scanner } = await buildApp(config, { logger: false });
await scanner.scan();
await app.listen({ port: 3000, host: '127.0.0.1' });
console.log('Demo läuft auf http://localhost:3000 (Verwaltung unter /admin, Token: demo)');
