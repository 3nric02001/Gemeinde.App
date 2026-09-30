import type { Facets } from '../api';
import { decadeLabel } from '../format';
import { useApi } from '../hooks';

export interface FilterValue {
  decade?: number;
}

/** Chips für das Jahrzehnt, wie die Filter-Pillen bei Spotify */
export function Filters({ value, onChange }: { value: FilterValue; onChange: (value: FilterValue) => void }) {
  const { data } = useApi<Facets>('/api/facets');
  if (!data || !data.decades.length) return null;
  const active = value.decade !== undefined;
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
    </div>
  );
}

export function readFilter(params: URLSearchParams): FilterValue {
  const decade = Number(params.get('decade'));
  return {
    decade: Number.isInteger(decade) && decade > 0 ? decade : undefined,
  };
}
