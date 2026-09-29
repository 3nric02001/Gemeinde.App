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
}

function syncsafe(value: number): Buffer {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function id3Frame(id: string, value: string): Buffer {
  const body = Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]);
  return Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(body.length), Buffer.from([0, 0]), body]);
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
  const body = Buffer.concat(entries.filter(([, v]) => v !== undefined).map(([id, v]) => id3Frame(id, v!)));
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
  return Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    flacBlockHeader(0, streamInfo.length, false),
    streamInfo,
    flacBlockHeader(4, vorbis.length, true),
    vorbis,
  ]);
}
