import { useEffect, useRef, useState } from 'preact/hooks';
import type { Album, Artist, Facets, Page, Track } from '../api';
import { categoryUrl, getJson, query } from '../api';
import { AlbumGrid } from '../components/AlbumCard';
import { TrackList } from '../components/TrackList';
import { plural } from '../format';
import { useApi, useCategories, useDebounced } from '../hooks';
import { player } from '../player';
import { navigate } from '../router';
import { Icon } from '../components/Icon';
import { ArtistList } from './Artists';
import { Empty } from './common';

export function Search({ params }: { params: URLSearchParams }) {
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text.trim(), 200);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  // Suchbegriff in der Adresse halten, damit Zurück wieder bei den Treffern landet.
  useEffect(() => navigate(`/suche${query({ q })}`, { replace: true }), [q]);

  return (
    <div class="page">
      <form class="search-box" role="search" onSubmit={(event) => event.preventDefault()}>
        <Icon name="search" size={20} />
        <input
          ref={input}
          type="search"
          value={text}
          placeholder="Titel, Alben, Interpreten, Sprecher"
          aria-label="Suche"
          enterKeyHint="search"
          autocomplete="off"
          onInput={(event) => setText((event.target as HTMLInputElement).value)}
        />
        {text && (
          <button type="button" class="icon-button" aria-label="Suche leeren" onClick={() => setText('')}>
            <Icon name="close" size={18} />
          </button>
        )}
      </form>
      {q ? <Results q={q} /> : <Browse />}
    </div>
  );
}

function Results({ q }: { q: string }) {
  const tracks = useApi<Page<Track>>(`/api/tracks${query({ q, limit: 20 })}`);
  const albums = useApi<Page<Album>>(`/api/albums${query({ q, limit: 12, sort: 'date' })}`);
  const artists = useApi<Page<Artist>>(`/api/artists${query({ q, limit: 6 })}`);

  const done = !tracks.loading && !albums.loading && !artists.loading;
  const nothing =
    done && !tracks.data?.total && !albums.data?.total && !artists.data?.total;
  if (nothing) return <Empty title={`Keine Treffer für „${q}“`}>Prüfe die Schreibweise oder versuche weniger Wörter.</Empty>;

  const playAll = async (index: number) => {
    // Alle Treffer in die Warteschlange, nicht nur die sichtbaren 20.
    const all = await getJson<Page<Track>>(`/api/tracks${query({ q, limit: 500 })}`);
    player.playList(all.items, index, { shuffle: false });
  };

  return (
    <>
      {artists.data && artists.data.items.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Interpreten</h2>
          </div>
          <ArtistList artists={artists.data.items} />
        </section>
      )}
      {tracks.data && tracks.data.items.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Titel</h2>
            {tracks.data.total > tracks.data.items.length && (
              <a class="more-link" href={`/titel${query({ q })}`}>
                {plural(tracks.data.total, 'Titel', 'Titel')} anzeigen
              </a>
            )}
          </div>
          <TrackList tracks={tracks.data.items} onPlay={(index) => void playAll(index)} />
        </section>
      )}
      {albums.data && albums.data.items.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Alben</h2>
            {albums.data.total > albums.data.items.length && (
              <a class="more-link" href={`/alben${query({ q })}`}>
                Alle anzeigen
              </a>
            )}
          </div>
          <AlbumGrid albums={albums.data.items} />
        </section>
      )}
    </>
  );
}

/** Ohne Suchbegriff: Stöbern nach Kategorie und Genre, wie die Kacheln bei Spotify */
function Browse() {
  const { data } = useApi<Facets>('/api/facets');
  const categories = useCategories().filter((c) => c.inNav);
  return (
    <>
      {categories.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Kategorien</h2>
          </div>
          <div class="chips-row">
            {categories.map((category) => (
              <a key={category.id} class="chip" href={categoryUrl(category.slug)}>
                {category.name}
              </a>
            ))}
          </div>
        </section>
      )}
      {data && data.genres.length > 0 && <Genres facets={data} />}
    </>
  );
}

function Genres({ facets: data }: { facets: Facets }) {
  return (
    <section class="shelf">
      <div class="section-head">
        <h2>Stöbern</h2>
      </div>
      <div class="browse">
        {data.genres.slice(0, 24).map((genre) => (
          <a key={genre.value} class="browse-tile" href={`/alben${query({ genre: genre.value })}`}>
            <span>{genre.value}</span>
            <small>{plural(genre.count, 'Titel', 'Titel')}</small>
          </a>
        ))}
      </div>
    </section>
  );
}
