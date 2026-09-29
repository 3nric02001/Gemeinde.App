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
  ['date', 'Datum (Gottesdienste zuerst)'],
  ['recent', 'Neu hinzugefügt'],
] as const;

export function Albums({ params }: { params: URLSearchParams }) {
  const filter = readFilter(params);
  const q = params.get('q') ?? undefined;
  const sort = SORTS.some(([key]) => key === params.get('sort')) ? params.get('sort')! : 'artist';
  const { items, total, loading, error, sentinel } = usePaged<Album>(`/api/albums${query({ ...filter, q, sort })}`);

  const update = (next: { sort?: string; genre?: string; decade?: number }) =>
    navigate(`/alben${query({ q, sort, ...filter, ...next })}`, { replace: true });

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
