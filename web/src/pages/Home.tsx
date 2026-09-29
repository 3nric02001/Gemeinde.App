import type { Album, Facets, Page } from '../api';
import { query } from '../api';
import { Shelf } from '../components/AlbumCard';
import { decadeLabel, formatDuration, plural } from '../format';
import { useApi } from '../hooks';
import { Empty } from './common';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 11) return 'Guten Morgen';
  if (hour < 18) return 'Guten Tag';
  return 'Guten Abend';
}

export function Home() {
  const recent = useApi<Page<Album>>('/api/albums?sort=recent&limit=12');
  const facets = useApi<Facets>('/api/facets');
  const topGenre = facets.data?.genres[0]?.value;
  const genreAlbums = useApi<Page<Album>>(topGenre ? `/api/albums${query({ genre: topGenre, limit: 12, sort: 'year' })}` : undefined);

  if (facets.data && facets.data.totals.albums === 0) {
    return (
      <div class="page">
        <h1 class="page-title">{greeting()}</h1>
        <Empty title="Noch keine Musik da">
          Die Bibliothek wird aus der Nextcloud gelesen. Sobald der erste Scan durch ist, erscheinen hier die Alben.
        </Empty>
      </div>
    );
  }

  return (
    <div class="page">
      <h1 class="page-title">{greeting()}</h1>

      {facets.data && facets.data.genres.length > 0 && (
        <section>
          <div class="tiles">
            {facets.data.genres.slice(0, 6).map((genre) => (
              <a key={genre.value} class="tile" href={`/alben${query({ genre: genre.value })}`}>
                {genre.value}
              </a>
            ))}
          </div>
        </section>
      )}

      <Shelf title="Neu hinzugefügt" href="/alben?sort=recent" albums={recent.data?.items ?? []} />
      {topGenre && <Shelf title={topGenre} href={`/alben${query({ genre: topGenre })}`} albums={genreAlbums.data?.items ?? []} />}

      {facets.data && facets.data.decades.length > 1 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Nach Jahrzehnt</h2>
          </div>
          <div class="chips-row">
            {facets.data.decades.map((d) => (
              <a key={d.value} class="chip" href={`/alben${query({ decade: d.value, sort: 'year' })}`}>
                {decadeLabel(d.value)}
              </a>
            ))}
          </div>
        </section>
      )}

      {facets.data && (
        <p class="stats">
          {plural(facets.data.totals.albums, 'Album', 'Alben')} · {plural(facets.data.totals.tracks, 'Titel', 'Titel')} ·{' '}
          {formatDuration(facets.data.totals.duration)}
        </p>
      )}
    </div>
  );
}
