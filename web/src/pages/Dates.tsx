import { Fragment } from 'preact';
import type { Album } from '../api';
import { AlbumGrid } from '../components/AlbumCard';
import { formatMonth, serviceLine } from '../format';
import { usePaged } from '../hooks';
import { Empty, ErrorNote, Loading } from './common';

/** Gottesdienst bzw. Aufnahme mit Datum; ein Album wie jedes andere */
export type DatedAlbum = Album & { date: string };

/** Zeile unter dem Anlass: Datum und Sprecher */
export function folderSubtitle(album: DatedAlbum): string {
  return serviceLine(album.date, album.speaker);
}

/** Alle Aufnahmen nach Datum, neueste zuerst, mit Monatsüberschriften */
export function Dates() {
  const { items, total, loading, error, sentinel } = usePaged<DatedAlbum>('/api/dates', 200);
  const months: Array<{ label: string; albums: DatedAlbum[] }> = [];
  for (const album of items) {
    const label = formatMonth(album.date);
    if (months.at(-1)?.label !== label) months.push({ label, albums: [] });
    months.at(-1)!.albums.push(album);
  }

  return (
    <div class="page">
      <h1 class="page-title">Datum</h1>
      {error && <ErrorNote message={error} />}
      {total === 0 && (
        <Empty title="Noch keine Aufnahmen mit Datum">
          Hier erscheinen Ordner und Dateien, deren Name ein Datum enthält, z. B. „2026-09-27 Gottesdienst“ oder
          „27.09.2026 Meier - Psalm 23.mp3“.
        </Empty>
      )}
      {months.map((month) => (
        <Fragment key={month.label}>
          <section class="shelf">
            <div class="section-head">
              <h2>{month.label}</h2>
            </div>
            <AlbumGrid albums={month.albums} />
          </section>
        </Fragment>
      ))}
      {loading && <Loading />}
      <div ref={sentinel} />
    </div>
  );
}
