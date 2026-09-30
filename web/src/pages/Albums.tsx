import type { Album, Facets } from '../api';
import { query } from '../api';
import { AlbumGrid } from '../components/AlbumCard';
import { Filters, readFilter, type FilterValue } from '../components/Filters';
import { plural } from '../format';
import { useApi, usePaged } from '../hooks';
import { navigate } from '../router';
import { Empty, ErrorNote, Loading } from './common';

const SORTS = [
  ['title', 'Titel'],
  ['year', 'Jahr'],
  ['date', 'Datum'],
  ['recent', 'Neu hinzugefügt'],
] as const;

/**
 * Musik und Aufnahmen getrennt, Aufnahmen je Art aus der Zuordnung (Gottesdienste, Bibelstunden …), dahinter
 * Sonstiges (Alben, denen nichts eine Art gibt) und Playlists. Aufnahmen stehen zusätzlich unter "Datum"; eine
 * Playlist, der die Verwaltung eine Art gibt, steht zusätzlich unter dieser Art.
 * `art` ist "musik", "sonstiges", "playlists", "alle" oder der Name einer Art. "gottesdienste" aus älteren Links heißt: alle Aufnahmen mit Datum.
 */
const ALL_RECORDINGS = 'gottesdienste';
const PLAYLISTS = 'playlists';

export function Albums({ params }: { params: URLSearchParams }) {
  const filter = readFilter(params);
  const q = params.get('q') ?? undefined;
  const facets = useApi<Facets>('/api/facets').data;
  const recordings = facets?.recordings ?? [];
  // "Alle" steht wie unter "Datum" vorne; ohne Auswahl bleibt es bei Musik
  const kinds: Array<[string, string]> = [
    ['alle', 'Alle'],
    ['musik', 'Musik'],
    ...(recordings.length ? recordings.map((r): [string, string] => [r.name, r.plural]) : [[ALL_RECORDINGS, 'Gottesdienste'] as [string, string]]),
    ...(facets?.other ? [['sonstiges', 'Sonstiges'] as [string, string]] : []),
    ...(facets?.playlists ? [[PLAYLISTS, 'Playlists'] as [string, string]] : []),
  ];
  // Ohne Auswahl nur Musik (gibt es keine, alles); kommt man über eine Suche oder ein Jahrzehnt, alles, damit nichts fehlt.
  const kind = params.get('art') || (q || filter.decade || facets?.music === 0 ? 'alle' : 'musik');
  const section = kind === 'musik' ? 'music' : kind === 'sonstiges' ? 'other' : undefined;
  const playlists = kind === PLAYLISTS;
  const recording = !section && !playlists && kind !== 'alle' && kind !== ALL_RECORDINGS ? kind : undefined;
  const defaultSort = section || playlists || kind === 'alle' ? 'title' : 'date';
  const sort = SORTS.some(([key]) => key === params.get('sort')) ? params.get('sort')! : defaultSort;
  // Eine Art grenzt schon ein; "mit Datum" nur für das alte "gottesdienste" (Playlists einer Art haben kein Datum)
  const dated = kind === ALL_RECORDINGS ? 'true' : undefined;
  const { items, total, loading, error, sentinel } = usePaged<Album>(
    `/api/albums${query({ ...filter, q, sort, dated, recording, section, kind: playlists ? 'manual' : undefined })}`,
  );

  const update = (next: { sort?: string; decade?: number; art?: string }) =>
    navigate(`/alben${query({ q, sort: params.get('sort') ?? undefined, art: params.get('art') ?? undefined, ...filter, ...next })}`, {
      replace: true,
    });

  return (
    <div class="page">
      <div class="page-head">
        <h1 class="page-title">{q ? `Alben zu „${q}“` : 'Alben'}</h1>
        <label class="select">
          <span class="select-label">Sortieren:</span>
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
        {kinds.map(([key, label]) => (
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
      <Filters value={filter} onChange={(next: FilterValue) => update({ decade: next.decade })} />
      {total !== undefined && <p class="count">{playlists ? plural(total, 'Playlist', 'Playlists') : plural(total, 'Album', 'Alben')}</p>}
      {error && <ErrorNote message={error} />}
      {total === 0 && <Empty title="Keine Alben gefunden">Entferne einen Filter, um mehr zu sehen.</Empty>}
      <AlbumGrid albums={items} />
      {loading && <Loading />}
      <div ref={sentinel} />
    </div>
  );
}
