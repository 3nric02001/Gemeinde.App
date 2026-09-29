import type { DB } from '../db.js';
import { getAlbum, searchAlbums, type Page } from './queries.js';

export { parseFolderDate } from './dateText.js';

/**
 * Gottesdienste und andere Aufnahmen mit Datum. Grundlage sind die Alben mit Datum (siehe
 * albums.ts), damit Datumsansicht, Startseite und Albenliste dieselben Einträge zeigen: Ein Ordner,
 * dessen Titel verschiedene Album-Tags tragen, erscheint so nicht einmal als Ordner und zweimal als Album.
 */
export function listDatedAlbums(db: DB, limit: number, offset: number): Page<Record<string, unknown>> {
  const page = searchAlbums(db, { dated: true, sort: 'date', limit, offset });
  // Frühere Felder der Datumsansicht, damit ältere Oberflächen (noch zwischengespeichert) weiter funktionieren
  return { ...page, items: page.items.map((album) => ({ ...album, name: album.title, albumId: album.id })) };
}

/**
 * Album zu einem Ordnerpfad, für ältere Links auf /datum/ordner?pfad=…: das Album mit Datum aus diesem
 * Ordner, sonst das, in dem Titel aus dem Ordner stehen (z. B. "2026-09-27/Predigt", das jetzt
 * zum Gottesdienst "2026-09-27" gehört).
 */
export function datedAlbumForFolder(db: DB, folder: string) {
  const direct = db
    .prepare("SELECT id FROM albums WHERE folder = ? AND date IS NOT NULL AND hidden = 0 AND kind = 'auto' ORDER BY date DESC LIMIT 1")
    .get(folder) as { id: number } | undefined;
  const id =
    direct?.id ??
    (
      db
        .prepare(
          `SELECT a.id FROM tracks t JOIN albums a ON a.id = t.album_id
           WHERE t.path LIKE ? ESCAPE '\\' AND a.date IS NOT NULL AND a.hidden = 0 ORDER BY a.date DESC LIMIT 1`,
        )
        .get(`${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`) as { id: number } | undefined
    )?.id;
  if (id === undefined) return undefined;
  const album = getAlbum(db, id);
  return album && { ...album, folder, name: album.title, albumId: id };
}
