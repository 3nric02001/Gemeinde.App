import { Fragment } from 'preact';
import type { Album, Facets } from '../api';
import { query } from '../api';
import { AlbumGrid } from '../components/AlbumCard';
import { formatMonth, serviceLine } from '../format';
import { useApi, usePaged } from '../hooks';
import { Empty, ErrorNote, Loading } from './common';

/** Gottesdienst bzw. Aufnahme mit Datum; ein Album wie jedes andere */
export type DatedAlbum = Album & { date: string };

/** Zeile unter dem Anlass: das Datum */
export function folderSubtitle(album: DatedAlbum): string {
  return serviceLine(album.date);
}

/** Alle Aufnahmen nach Datum, neueste zuerst, mit Monatsüberschriften */
export function Dates({ params }: { params: URLSearchParams }) {
  const art = params.get('art') || undefined;
  const facets = useApi<Facets>('/api/facets');
  const kinds = facets.data?.recordings ?? [];
  const { items, total, loading, error, sentinel } = usePaged<DatedAlbum>(`/api/dates${query({ recording: art })}`, 200);
  const months: Array<{ label: string; albums: DatedAlbum[] }> = [];
  for (const album of items) {
    const label = formatMonth(album.date);
    if (months.at(-1)?.label !== label) months.push({ label, albums: [] });
    months.at(-1)!.albums.push(album);
  }

  return (
    <div class="page">
      <h1 class="page-title">Datum</h1>
      {/* Filter je Art aus dem Regelwerk (Gottesdienste, Bibelstunden …), erst ab zwei Arten */}
      {kinds.length > 1 && (
        <nav class="chips-row" aria-label="Art der Aufnahme">
          <a class={`chip${!art ? ' is-on' : ''}`} href="/datum" aria-current={!art ? 'page' : undefined}>
            Alle
          </a>
          {kinds.map((kind) => (
            <a
              key={kind.name}
              class={`chip${art === kind.name ? ' is-on' : ''}`}
              href={`/datum${query({ art: kind.name })}`}
              aria-current={art === kind.name ? 'page' : undefined}
            >
              {kind.plural}
            </a>
          ))}
        </nav>
      )}
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
