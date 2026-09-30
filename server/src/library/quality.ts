import type { DB } from '../db.js';

/**
 * Hinweise zur Datenqualität für die Verwaltung: Stellen, an denen die automatische Zuordnung
 * wahrscheinlich nicht das zeigt, was gemeint ist. Behoben wird in Ordner- und Dateinamen in der Nextcloud
 * oder in der Verwaltung am Album.
 */

const LIMIT = 50;

interface AlbumRef {
  id: number;
  title: string;
  date: string | null;
  trackCount: number;
}

export interface QualityReport {
  /** Musikalben ohne Bild (Gottesdienste bekommen ein Kalenderblatt) */
  withoutCover: { total: number; items: AlbumRef[] };
  /** Gottesdienste ohne Sprecher */
  servicesWithoutSpeaker: { total: number; items: AlbumRef[] };
}

const ALBUM_REF = 'a.id, a.title, a.date, a.track_count AS trackCount';

export function libraryQuality(db: DB): QualityReport {
  const page = (where: string) => ({
    total: (db.prepare(`SELECT count(*) AS n FROM albums a WHERE ${where}`).get() as { n: number }).n,
    items: db.prepare(`SELECT ${ALBUM_REF} FROM albums a WHERE ${where} ORDER BY a.date DESC, a.sort_title LIMIT ${LIMIT}`).all() as AlbumRef[],
  });
  return {
    withoutCover: page('a.hidden = 0 AND a.date IS NULL AND a.cover_path IS NULL AND a.cover_id IS NULL'),
    // Nur Aufnahmen mit Predigt (laut Policies im Regelwerk)
    servicesWithoutSpeaker: page(
      `a.hidden = 0 AND a.date IS NOT NULL AND a.speaker IS NULL AND a.kind = 'auto' AND a.recording IS NOT NULL
       AND EXISTS (SELECT 1 FROM album_tracks x JOIN tracks t ON t.id = x.track_id WHERE x.album_id = a.id AND t.sermon = 1)`,
    ),
  };
}
