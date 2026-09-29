import type { Facets } from '../api';
import { decadeLabel } from '../format';
import { useApi } from '../hooks';

export interface FilterValue {
  genre?: string;
  decade?: number;
}

/** Chips für Genre und Jahrzehnt, wie die Filter-Pillen bei Spotify */
export function Filters({ value, onChange }: { value: FilterValue; onChange: (value: FilterValue) => void }) {
  const { data } = useApi<Facets>('/api/facets');
  if (!data || (!data.genres.length && !data.decades.length)) return null;
  const active = value.genre !== undefined || value.decade !== undefined;
  return (
    <div class="filters" role="group" aria-label="Filter">
      {active && (
        <button type="button" class="chip chip-clear" onClick={() => onChange({})}>
          Alle
        </button>
      )}
      {data.decades.map((d) => (
        <button
          key={`d${d.value}`}
          type="button"
          class={`chip${value.decade === d.value ? ' is-on' : ''}`}
          aria-pressed={value.decade === d.value}
          onClick={() => onChange({ ...value, decade: value.decade === d.value ? undefined : d.value })}
        >
          {decadeLabel(d.value)}
        </button>
      ))}
      {data.genres.slice(0, 20).map((g) => (
        <button
          key={`g${g.value}`}
          type="button"
          class={`chip${value.genre?.toLowerCase() === g.value.toLowerCase() ? ' is-on' : ''}`}
          aria-pressed={value.genre?.toLowerCase() === g.value.toLowerCase()}
          onClick={() =>
            onChange({ ...value, genre: value.genre?.toLowerCase() === g.value.toLowerCase() ? undefined : g.value })
          }
        >
          {g.value}
        </button>
      ))}
    </div>
  );
}

export function readFilter(params: URLSearchParams): FilterValue {
  const decade = Number(params.get('decade'));
  return {
    genre: params.get('genre') || undefined,
    decade: Number.isInteger(decade) && decade > 0 ? decade : undefined,
  };
}
