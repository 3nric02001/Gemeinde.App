import type { DB } from '../db.js';
import { findDate, isYearOnly } from './dateText.js';
import { UNKNOWN_ARTIST } from './metadata.js';
import { artistKey, artistNames } from './text.js';

/**
 * Hinweise zur Datenqualität für die Verwaltung: Stellen, an denen die automatische Zuordnung
 * wahrscheinlich nicht das zeigt, was gemeint ist. Behoben wird in den Dateien (Tags, Ordner)
 * oder in der Verwaltung am Album.
 */

const LIMIT = 50;

interface AlbumRef {
  id: number;
  title: string;
  artist: string;
  date: string | null;
  trackCount: number;
}

export interface QualityReport {
  /** Ordner, die in mehrere automatische Alben zerfallen (unterschiedliche Album-Tags) */
  splitFolders: Array<{ folder: string; albums: AlbumRef[] }>;
  /** Musikalben ohne Bild (Gottesdienste bekommen ein Kalenderblatt) */
  withoutCover: { total: number; items: AlbumRef[] };
  /** Gottesdienste ohne Sprecher */
  servicesWithoutSpeaker: { total: number; items: AlbumRef[] };
  /** Interpreten, die wie ein Datum, ein Jahr oder "unbekannt" aussehen */
  suspiciousArtists: Array<{ name: string; trackCount: number }>;
  /** Derselbe Interpret in mehreren Schreibweisen (wird schon zusammengefasst, aber die Tags sind uneinheitlich) */
  artistVariants: Array<{ names: string[]; trackCount: number }>;
}

const ALBUM_REF = 'a.id, a.title, a.artist, a.date, a.track_count AS trackCount';

export function libraryQuality(db: DB): QualityReport {
  // Aufteilungen nach Datum im Dateinamen sind gewollt (Schlüssel mit "@").
  const split = db
    .prepare(
      `SELECT a.folder, ${ALBUM_REF} FROM albums a
       WHERE a.kind = 'auto' AND a.hidden = 0 AND a.folder <> '' AND instr(a.key, char(0) || '@') = 0
         AND a.folder IN (
           SELECT folder FROM albums WHERE kind = 'auto' AND hidden = 0 AND instr(key, char(0) || '@') = 0
           GROUP BY folder HAVING count(*) > 1)
       ORDER BY a.folder, a.sort_title`,
    )
    .all() as Array<AlbumRef & { folder: string }>;
  const byFolder = new Map<string, AlbumRef[]>();
  for (const { folder, ...album } of split) byFolder.set(folder, [...(byFolder.get(folder) ?? []), album]);

  const page = (where: string) => ({
    total: (db.prepare(`SELECT count(*) AS n FROM albums a WHERE ${where}`).get() as { n: number }).n,
    items: db.prepare(`SELECT ${ALBUM_REF} FROM albums a WHERE ${where} ORDER BY a.date DESC, a.sort_title LIMIT ${LIMIT}`).all() as AlbumRef[],
  });

  const artists = db
    .prepare(
      `SELECT name, count(*) AS n FROM (
         SELECT coalesce(display_artist, artist) AS name FROM tracks
         UNION ALL SELECT album_artist FROM tracks WHERE album_artist IS NOT NULL AND album_artist <> artist)
       GROUP BY name`,
    )
    .all() as Array<{ name: string; n: number }>;
  const suspicious = artists
    .filter(({ name }) => name === UNKNOWN_ARTIST || isYearOnly(name) || findDate(name) !== undefined)
    .sort((a, b) => b.n - a.n)
    .slice(0, LIMIT)
    .map(({ name, n }) => ({ name, trackCount: n }));

  const variants = new Map<string, { names: Set<string>; trackCount: number }>();
  for (const { name, n } of artists) {
    for (const single of artistNames(name)) {
      const key = artistKey(single);
      const entry = variants.get(key) ?? { names: new Set<string>(), trackCount: 0 };
      entry.names.add(single);
      entry.trackCount += n;
      variants.set(key, entry);
    }
  }

  return {
    splitFolders: [...byFolder].slice(0, LIMIT).map(([folder, albums]) => ({ folder, albums })),
    withoutCover: page('a.hidden = 0 AND a.date IS NULL AND a.cover_path IS NULL AND a.cover_id IS NULL'),
    // Nur Aufnahmen mit Predigt (laut Policies im Regelwerk)
    servicesWithoutSpeaker: page(
      `a.hidden = 0 AND a.date IS NOT NULL AND a.speaker IS NULL AND a.kind = 'auto' AND a.recording IS NOT NULL
       AND EXISTS (SELECT 1 FROM album_tracks x JOIN tracks t ON t.id = x.track_id WHERE x.album_id = a.id AND t.sermon = 1)`,
    ),
    suspiciousArtists: suspicious,
    artistVariants: [...variants.values()]
      .filter((entry) => entry.names.size > 1)
      .sort((a, b) => b.trackCount - a.trackCount)
      .slice(0, LIMIT)
      .map((entry) => ({ names: [...entry.names].sort(), trackCount: entry.trackCount })),
  };
}
