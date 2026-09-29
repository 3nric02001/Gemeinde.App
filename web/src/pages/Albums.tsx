import type { Album } from '../api';
import { query } from '../api';
import { AlbumGrid } from '../components/AlbumCard';
import { Filters, readFilter, type FilterValue } from '../components/Filters';
import { plural } from '../format';
import { usePaged } from '../hooks';
import { navigate } from '../router';
import { Empty, ErrorNote, Loading } from './common';

const SORTS = [
  ['artist', 'Interpret'],
  ['title', 'Titel'],
  ['year', 'Jahr'],
  ['date', 'Datum'],
  ['recent', 'Neu hinzugefügt'],
] as const;

/** Musik und Gottesdienste getrennt; Gottesdienste haben zusätzlich den Reiter "Datum". */
const KINDS = [
  ['musik', 'Musik'],
  ['gottesdienste', 'Gottesdienste'],
  ['alle', 'Alle'],
] as const;
type Kind = (typeof KINDS)[number][0];

export function Albums({ params }: { params: URLSearchParams }) {
  const filter = readFilter(params);
  const q = params.get('q') ?? undefined;
  // Ohne Auswahl nur Musik; kommt man über eine Suche, ein Genre oder Jahrzehnt, alles, damit nichts fehlt.
  const kind: Kind = KINDS.some(([key]) => key === params.get('art'))
    ? (params.get('art') as Kind)
    : q || filter.genre || filter.decade
      ? 'alle'
      : 'musik';
  const defaultSort = kind === 'gottesdienste' ? 'date' : 'artist';
  const sort = SORTS.some(([key]) => key === params.get('sort')) ? params.get('sort')! : defaultSort;
  const dated = kind === 'musik' ? 'false' : kind === 'gottesdienste' ? 'true' : undefined;
  const { items, total, loading, error, sentinel } = usePaged<Album>(`/api/albums${query({ ...filter, q, sort, dated })}`);

  const update = (next: { sort?: string; genre?: string; decade?: number; art?: string }) =>
    navigate(`/alben${query({ q, sort: params.get('sort') ?? undefined, art: params.get('art') ?? undefined, ...filter, ...next })}`, {
      replace: true,
    });

  return (
    <div class="page">
      <div class="page-head">
        <h1 class="page-title">{q ? `Alben zu „${q}“` : 'Alben'}</h1>
        <label class="select">
          <span class="visually-hidden">Sortieren nach</span>
          <select value={sort} onChange={(event) => update({ sort: (event.target as HTMLSelectElement).value })}>
            {SORTS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div class="segmented segmented-kinds" role="radiogroup" aria-label="Art">
        {KINDS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={kind === key}
            class={kind === key ? 'is-on' : ''}
            onClick={() => update({ art: key, sort: undefined })}
          >
            {label}
          </button>
        ))}
      </div>
      <Filters value={filter} onChange={(next: FilterValue) => update({ genre: next.genre, decade: next.decade })} />
      {total !== undefined && <p class="count">{plural(total, 'Album', 'Alben')}</p>}
      {error && <ErrorNote message={error} />}
      {total === 0 && <Empty title="Keine Alben gefunden">Entferne einen Filter, um mehr zu sehen.</Empty>}
      <AlbumGrid albums={items} />
      {loading && <Loading />}
      <div ref={sentinel} />
    </div>
  );
}
