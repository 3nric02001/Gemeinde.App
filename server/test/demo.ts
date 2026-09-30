// Startet den Server mit simulierter Nextcloud und Beispielalben: `npm run demo`, dann http://localhost:3000
import { deflateSync } from 'node:zlib';
import { buildApp } from '../src/app.js';
import { OidcService } from '../src/auth/oidc.js';
import { saveGroup } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { mp3 } from './helpers/audio.js';
import { CLIENT_ID, CLIENT_SECRET, FakeIdp } from './helpers/fakeIdp.js';
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
albums.forEach(([artist, album, year, genre, titles, colors], n) => {
  // Mal liegt das Cover als Bild im Ordner, mal steckt es in den Dateien; beim Sampler hat jeder Titel ein eigenes.
  const sampler = album.startsWith('Feiert Jesus');
  const embedded = colors && (sampler || n % 2 === 1);
  titles.forEach((title, i) => {
    const picture = !embedded
      ? undefined
      : { data: png(sampler ? [40 + i * 50, 80, 200 - i * 40] : colors[0]!, sampler ? [250, 200 - i * 30, 90 + i * 40] : colors[1]!), mime: 'image/png' };
    cloud.put(
      `${artist}/${album}/${String(i + 1).padStart(2, '0')} ${title}.mp3`,
      mp3({ title, artist, album, track: i + 1, year, genre, picture, custom: { Kategorie: ['Chor', 'Lobpreis'].includes(genre) ? 'Lied' : 'Musik' } }, 3000 + i * 800),
    );
  });
  if (colors && !embedded) cloud.put(`${artist}/${album}/cover.png`, png(colors[0]!, colors[1]!));
});
// Aufnahmen wie in der Gemeinde abgelegt, ohne Tags: Jahr / JJJJ_MM_TT_Anlass / "Inhalt - Titel",
// Bibelstunden in einem eigenen Ordner mit nummerierten Teilen (siehe Verwaltung → Zuordnung)
for (const [folder, files] of [
  ['Audio Aufnahmen/2026/2026_09_06', ['Begrüßung', 'Lied - Großer Gott, wir loben dich', 'Predigt - Joh 10, 11 Der gute Hirte - Pastor Meier', 'Segen']],
  ['Audio Aufnahmen/2026/2026_08_30_Einschulung', ['Lied - Vergiss nicht zu danken - Kinderchor', 'Predigt - Gott geht mit - Anna Schulz', 'Gebet']],
  ['Audio Aufnahmen/2026/Bibelstunden/2026_01_14_Matthäus 9, 27-38', ['2026_01_14_001', '2026_01_14_002']],
  ['Audio Aufnahmen/2026/Bibelstunden/2026_01_21_Matthäus 10, 1-15', ['2026_01_21_001']],
  // Derselbe Sprecher anders geschrieben, für Verwaltung → Interpreten
  ['Audio Aufnahmen/2026/2026_08_23', ['Predigt - Psalm 139 - A. Schulz', 'Lied - Befiehl du deine Wege - Kinder Chor']],
] as Array<[string, string[]]>) {
  files.forEach((file, i) => cloud.put(`${folder}/${file}.mp3`, mp3({}, file.startsWith('Predigt') || file.startsWith('2026') ? 9000 : 2500 + i * 300)));
}
// Gottesdienst-Aufnahmen in Datumsordnern für den Reiter "Datum"
/** Sprecher und Bibelstelle als eigene ID3-Felder, wie sie z. B. mp3tag schreibt */
function sermonTags(title: string): Record<string, string> {
  if (!title.startsWith('Predigt')) return {};
  const passage = /Psalm \d+/.exec(title)?.[0];
  return { Sprecher: title.includes('Dankbarkeit') ? 'Pastorin Schulz' : 'Pastor Meier', ...(passage ? { Bibelstelle: passage } : {}) };
}

const services: Array<[string, string[], number[][] | null]> = [
  ['Gottesdienste/2026/2026-09-27 Erntedank', ['Begrüßung', 'Lobpreis', 'Predigt: Dankbarkeit'], [[180, 110, 40], [250, 220, 150]]],
  ['Gottesdienste/2026/2026-09-20', ['Lobpreis', 'Predigt: Psalm 23'], null],
  ['Gottesdienste/2026/13.09.2026 Taufgottesdienst', ['Taufe', 'Predigt'], [[40, 90, 150], [200, 225, 245]]],
  ['Gottesdienste/2026/2026-08-30 Jugendgottesdienst', ['Band', 'Input'], [[60, 60, 60], [210, 210, 210]]],
];
for (const [folder, titles, colors] of services) {
  titles.forEach((title, i) =>
    cloud.put(
      `${folder}/${String(i + 1).padStart(2, '0')} ${title}.mp3`,
      mp3(
        { title, artist: 'MBG Brake', album: folder.split('/').pop(), track: i + 1, genre: 'Gottesdienst', custom: { Kategorie: title.startsWith('Predigt') ? 'Predigt' : 'Musik', ...sermonTags(title) }, picture: colors ? { data: png(colors[0]!, colors[1]!), mime: 'image/png' } : undefined },
        // Predigten gut 11 Minuten lang, damit Sprünge, Tempo und Weiterhören greifen
        title.startsWith('Predigt') ? 26_000 : 4000,
      ),
    ),
  );
}

const config = loadConfig({
  NEXTCLOUD_URL: cloud.url, NEXTCLOUD_USER: USER, NEXTCLOUD_PASSWORD: PASSWORD, NEXTCLOUD_MUSIC_PATH: '/Musik',
  DATABASE_PATH: ':memory:', WEB_DIR: '../web/dist', PORT: '3000', ADMIN_PASSWORD: 'demo',
  PUBLIC_URL: 'http://localhost:3000',
});
const { app, db, scanner } = await buildApp(config, { logger: false });
await scanner.scan();

// Simulierter Identity Provider: "Mit Gemeinde-Konto anmelden" meldet sofort Anna (Musikteam) an.
const idp = new FakeIdp();
await idp.start();
idp.user = { sub: 'anna', name: 'Anna Beispiel', email: 'anna@example.org', groups: ['Musikteam', 'Jugend'] };
new OidcService(db).save({ enabled: true, issuer: idp.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
saveGroup(db, 'Musikteam', { enabled: true, role: 'manager' });
saveGroup(db, 'Gemeinde', { enabled: true, role: 'listener' });

await app.listen({ port: 3000, host: '127.0.0.1' });
console.log('Demo läuft auf http://localhost:3000 (Gemeinde-Konto meldet Anna an; lokaler Admin unter /?admin: admin / demo)');
