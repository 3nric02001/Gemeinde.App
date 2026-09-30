import { useState } from 'preact/hooks';
import { categoryUrl, type CategoryInfo, type CategoryValue } from '../api';
import { Icon } from '../components/Icon';
import { hashHue, initials, plural } from '../format';
import { useApi } from '../hooks';
import { Collection } from './Collection';
import { Empty, ErrorNote, Loading } from './common';

interface ValuesResponse {
  category: CategoryInfo;
  items: CategoryValue[];
}

/** So viele Einträge auf einmal; der Rest über das Suchfeld */
const SHOWN = 300;

/** Alle Werte einer Kategorie, z. B. alle Sprecher */
export function Category({ slug }: { slug: string }) {
  const { data, error } = useApi<ValuesResponse>(`/api/categories/${encodeURIComponent(slug)}/values`);
  const [filter, setFilter] = useState('');
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;

  const needle = filter.trim().toLocaleLowerCase('de');
  const items = needle ? data.items.filter((v) => v.value.toLocaleLowerCase('de').includes(needle)) : data.items;
  return (
    <div class="page">
      <h1 class="page-title">{data.category.name}</h1>
      <p class="count">{plural(data.items.length, 'Eintrag', 'Einträge')}</p>
      {data.items.length > 12 && (
        <form class="search-box search-box-small" role="search" onSubmit={(event) => event.preventDefault()}>
          <Icon name="search" size={18} />
          <input
            type="search"
            value={filter}
            placeholder={`${data.category.name} filtern`}
            aria-label={`${data.category.name} filtern`}
            autocomplete="off"
            onInput={(event) => setFilter((event.target as HTMLInputElement).value)}
          />
        </form>
      )}
      {data.items.length === 0 && (
        <Empty title="Noch keine Einträge">Keiner der Titel hat einen Wert in den Tag-Feldern dieser Kategorie.</Empty>
      )}
      <ul class="artist-list">
        {items.slice(0, SHOWN).map((item) => (
          <li key={item.value}>
            <a href={categoryUrl(data.category.slug, item.value)}>
              <span class="avatar" style={{ '--hue': hashHue(item.value) }} aria-hidden="true">
                {initials(item.value)}
              </span>
              <span class="artist-text">
                <span class="artist-name">{item.value}</span>
                <span class="artist-sub">{plural(item.trackCount, 'Titel', 'Titel')}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {items.length > SHOWN && <p class="count">Weitere {items.length - SHOWN} über das Suchfeld finden.</p>}
    </div>
  );
}

/** Alben und Titel zu einem Wert einer Kategorie */
export function CategoryEntry({ slug, value }: { slug: string; value: string }) {
  const { data, error } = useApi<ValuesResponse>(`/api/categories/${encodeURIComponent(slug)}/values`);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return <Collection eyebrow={data.category.name} name={value} filter={{ category: slug, value }} />;
}
