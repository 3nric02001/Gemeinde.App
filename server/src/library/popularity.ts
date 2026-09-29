import type { DB } from '../db.js';

/**
 * Verdecktes Scoring: wie oft ein Titel gehört wird, über alle Hörer zusammen.
 * Die Zahl erscheint nirgends in der Oberfläche oder API, sie schiebt nur Beliebtes in der Suche
 * und in Vorschlägen nach oben.
 *
 * Jede gezählte Wiedergabe verliert mit der Zeit an Gewicht (Halbwertszeit), damit Titel, die vor
 * einem Jahr oft liefen, nicht dauerhaft vor Neuem stehen. Gespeichert wird die Summe bezogen auf
 * einen festen Zeitpunkt: eine neue Wiedergabe zählt 2^((jetzt - EPOCH) / Halbwertszeit). Weil alle
 * Titel mit demselben Faktor altern, reicht zum Vergleich ein Faktor je Abfrage (`decayFactor`).
 */

export const HALF_LIFE_MS = 90 * 24 * 3600 * 1000;
const EPOCH = Date.UTC(2026, 0, 1);
/** Dieselbe Person zählt für denselben Titel höchstens einmal in diesem Zeitraum. */
export const PLAY_COOLDOWN_MS = 6 * 3600 * 1000;

const playWeight = (now: number) => 2 ** ((now - EPOCH) / HALF_LIFE_MS);
/** Rechnet gespeicherte Summen auf heute um: Ergebnis ist die Zahl der Wiedergaben mit Verfall. */
export const decayFactor = (now = Date.now()) => 2 ** (-(now - EPOCH) / HALF_LIFE_MS);

/**
 * Stufe 0, 1, 2 … = log2(1 + Wiedergaben mit Verfall), gerundet. Eine einzelne frische Wiedergabe
 * ergibt Stufe 1 (nach gut einer Halbwertszeit wieder 0), erst etwa doppelt so viele die nächste. Innerhalb einer Stufe bleibt die bisherige
 * Reihenfolge, so gewinnt Beliebtheit nur bei deutlichem Abstand. Braucht den Parameter @decay.
 */
export const trackTierSql = (alias: string) =>
  `coalesce((SELECT round(log2(1 + score * @decay)) FROM track_popularity WHERE track_id = ${alias}.id), 0)`;

/** Ein Album ist so beliebt wie sein meistgehörter Titel; lange Alben haben so keinen Vorteil. */
export const albumTierSql = (alias: string) =>
  `coalesce((SELECT round(log2(1 + max(p.score) * @decay)) FROM album_tracks pt
    JOIN track_popularity p ON p.track_id = pt.track_id WHERE pt.album_id = ${alias}.id), 0)`;

/**
 * Eine Wiedergabe zählen. Ob wirklich lange genug gehört wurde, entscheidet der Player;
 * hier verhindert die Sperrfrist, dass eine Person durch Wiederholen einen Titel hochtreibt.
 * `false`, wenn es den Titel nicht gibt.
 */
export function recordPlay(db: DB, userId: number, trackId: number, now = Date.now()): boolean {
  if (!db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(trackId)) return false;
  db.transaction(() => {
    const last = db.prepare('SELECT counted_at FROM track_plays WHERE user_id = ? AND track_id = ?').get(userId, trackId) as
      | { counted_at: number }
      | undefined;
    if (last && now - last.counted_at < PLAY_COOLDOWN_MS) return;
    db.prepare(
      `INSERT INTO track_plays (user_id, track_id, counted_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, track_id) DO UPDATE SET counted_at = excluded.counted_at`,
    ).run(userId, trackId, now);
    db.prepare(
      `INSERT INTO track_popularity (track_id, score) VALUES (?, ?)
       ON CONFLICT(track_id) DO UPDATE SET score = score + excluded.score`,
    ).run(trackId, playWeight(now));
  })();
  return true;
}
