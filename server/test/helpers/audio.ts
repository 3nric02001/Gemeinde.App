/**
 * Erzeugt winzige, aber für Tag-Parser gültige Audiodateien, damit die Tests
 * ohne echte Musikdateien im Repo auskommen.
 */
export interface Tags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  track?: number;
  disc?: number;
  year?: number;
  genre?: string;
  compilation?: boolean;
  /** Eingebettetes Cover (APIC bzw. FLAC PICTURE) */
  picture?: { data: Buffer; mime: string };
}

function syncsafe(value: number): Buffer {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function id3Frame(id: string, value: string | Buffer): Buffer {
  const body = typeof value === 'string' ? Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]) : value;
  return Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(body.length), Buffer.from([0, 0]), body]);
}

function apic(picture: { data: Buffer; mime: string }): Buffer {
  // Kodierung Latin-1, MIME-Typ, Bildtyp 3 (Vorderseite), leere Beschreibung, Bilddaten
  return Buffer.concat([Buffer.from([0]), Buffer.from(picture.mime, 'latin1'), Buffer.from([0, 3, 0]), picture.data]);
}

export function mp3(tags: Tags, frames = 20): Buffer {
  const entries: Array<[string, string | undefined]> = [
    ['TIT2', tags.title],
    ['TPE1', tags.artist],
    ['TALB', tags.album],
    ['TPE2', tags.albumArtist],
    ['TRCK', tags.track?.toString()],
    ['TPOS', tags.disc?.toString()],
    ['TDRC', tags.year?.toString()],
    ['TCON', tags.genre],
    ['TCMP', tags.compilation ? '1' : undefined],
  ];
  const frames3 = entries.filter(([, v]) => v !== undefined).map(([id, v]) => id3Frame(id, v!));
  if (tags.picture) frames3.push(id3Frame('APIC', apic(tags.picture)));
  const body = Buffer.concat(frames3);
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), syncsafe(body.length)]);
  // MPEG-1 Layer III, 128 kbit/s, 44,1 kHz: 417 Byte pro Frame
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return Buffer.concat([header, body, ...Array.from({ length: frames }, () => frame)]);
}

function flacBlockHeader(type: number, length: number, last: boolean): Buffer {
  return Buffer.from([(last ? 0x80 : 0) | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

export function flac(tags: Tags, seconds = 180): Buffer {
  const sampleRate = 44100n;
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  // 20 Bit Samplerate, 3 Bit Kanäle-1, 5 Bit Bits-1, 36 Bit Gesamtsamples
  const packed = (sampleRate << 44n) | (1n << 41n) | (15n << 36n) | (sampleRate * BigInt(seconds));
  streamInfo.writeBigUInt64BE(packed, 10);

  const comments = Object.entries({
    TITLE: tags.title,
    ARTIST: tags.artist,
    ALBUM: tags.album,
    ALBUMARTIST: tags.albumArtist,
    TRACKNUMBER: tags.track?.toString(),
    DISCNUMBER: tags.disc?.toString(),
    DATE: tags.year?.toString(),
    GENRE: tags.genre,
    COMPILATION: tags.compilation ? '1' : undefined,
  })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
  const vendor = Buffer.from('test', 'utf8');
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const vorbis = Buffer.concat([
    u32(vendor.length),
    vendor,
    u32(comments.length),
    ...comments.flatMap((c) => [u32(c.length), c]),
  ]);
  const u32be = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const blocks: Array<[number, Buffer]> = [
    [0, streamInfo],
    [4, vorbis],
  ];
  if (tags.picture) {
    const mime = Buffer.from(tags.picture.mime, 'latin1');
    blocks.push([
      6,
      Buffer.concat([u32be(3), u32be(mime.length), mime, u32be(0), u32be(1), u32be(1), u32be(24), u32be(0), u32be(tags.picture.data.length), tags.picture.data]),
    ]);
  }
  return Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    ...blocks.flatMap(([type, data], i) => [flacBlockHeader(type, data.length, i === blocks.length - 1), data]),
  ]);
}
