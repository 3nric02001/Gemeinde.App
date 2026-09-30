import { useEffect, useRef, useState } from 'preact/hooks';
import type { Album, Facets, Page, Track } from '../api';
import { categoryUrl, getJson, query } from '../api';
import { AlbumGrid, Shelf } from '../components/AlbumCard';
import { TrackList } from '../components/TrackList';
import { plural } from '../format';
import { useAuth } from '../auth';
import { useApi, useCategories, useDebounced } from '../hooks';
import { countSearch } from '../me';
import { player } from '../player';
import { navigate } from '../router';
import { Icon } from '../components/Icon';
import { rememberSearch, clearSearches, useRecentSearches } from '../searchHistory';
import { Empty } from './common';

export function Search({ params }: { params: URLSearchParams }) {
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text.trim(), 200);
  const input = useRef<HTMLInputElement>(null);
  const user = useAuth().user?.id;

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
          placeholder="Titel, Alben, Sprecher, Bibelstellen"
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
      {q ? (
        <Results q={q} user={user} />
      ) : (
        <Browse
          user={user}
          onPick={(value) => {
            setText(value);
            input.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function Results({ q, user }: { q: string; user: number | undefined }) {
  // Wer aus den Treffern etwas öffnet, hat gefunden, was er suchte: erst dann merken und zählen,
  // nicht jeden halb getippten Zwischenstand.
  const counted = useRef<string>();
  const found = (event: MouseEvent) => {
    if (counted.current === q || !(event.target as Element).closest('a, button, .track')) return;
    counted.current = q;
    if (user) rememberSearch(user, q);
    countSearch(q);
  };
  const tracks = useApi<Page<Track>>(`/api/tracks${query({ q, limit: TRACKS_MORE })}`);
  const albums = useApi<Page<Album>>(`/api/albums${query({ q, limit: SHELF, sort: 'date', kind: 'auto' })}`);
  const playlists = useApi<Page<Album>>(`/api/albums${query({ q, limit: SHELF, sort: 'title', kind: 'manual' })}`);
  const facets = useApi<Facets>('/api/facets').data;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [q]);

  const done = !tracks.loading && !albums.loading && !playlists.loading;
  const nothing = done && !tracks.data?.total && !albums.data?.total && !playlists.data?.total;
  if (nothing) return <Empty title={`Keine Treffer für „${q}“`}>Prüfe die Schreibweise oder versuche weniger Wörter.</Empty>;

  const playAll = async (index: number) => {
    // Alle Treffer in die Warteschlange, nicht nur die sichtbaren.
    const all = await getJson<Page<Track>>(`/api/tracks${query({ q, limit: 500 })}`);
    player.playList(all.items, index, { shuffle: false });
  };
  const albumHits = albums.data?.items ?? [];
  const dated = albumHits.filter((album) => album.date);
  const undated = albumHits.filter((album) => !album.date);
  const datedMore = dated.length > DATED || (albums.data?.total ?? 0) > albumHits.length;
  // Überschrift nach Art: nur Gottesdienste heißen so, gemischt "Aufnahmen"
  const kinds = new Set(dated.map((album) => album.recording));
  const only = kinds.size === 1 ? facets?.recordings?.find((kind) => kinds.has(kind.name)) : undefined;
  const datedTitle = only?.plural ?? 'Aufnahmen';
  const loaded = tracks.data?.items ?? [];
  const shown = expanded ? loaded : loaded.slice(0, TRACKS_FIRST);
  const more = (page: Page<Album> | undefined, href: string) => (page && page.total > page.items.length ? href : undefined);

  return (
    <div onClickCapture={found}>
      {shown.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Titel</h2>
            {tracks.data!.total > loaded.length && (
              <a class="more-link" href={`/titel${query({ q })}`}>
                {plural(tracks.data!.total, 'Titel', 'Titel')} anzeigen
              </a>
            )}
          </div>
          <TrackList tracks={shown} onPlay={(index) => void playAll(index)} />
          {!expanded && loaded.length > shown.length && (
            <button type="button" class="show-more" onClick={() => setExpanded(true)}>
              Mehr anzeigen
            </button>
          )}
        </section>
      )}
      {/* Gottesdienste und andere Aufnahmen mit Datum als kompakte Zeilen wie unter "Datum", Musik als Karten */}
      {dated.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>{datedTitle}</h2>
            {datedMore ? (
              <a class="more-link" href={`/alben${query({ q, art: 'alle', sort: 'date' })}`}>
                Alle anzeigen
              </a>
            ) : null}
          </div>
          <AlbumGrid albums={dated.slice(0, DATED)} list />
        </section>
      )}
      <Shelf title="Alben" href={more(albums.data, `/alben${query({ q, art: 'alle' })}`)} albums={undated} />
      <Shelf
        title="Playlists"
        href={more(playlists.data, `/alben${query({ q, art: 'playlists' })}`)}
        albums={playlists.data?.items ?? []}
      />
    </div>
  );
}

/** Zuerst wenige Titel, damit Alben und Playlists ohne langes Scrollen sichtbar bleiben; "Mehr anzeigen" holt den Rest */
const TRACKS_FIRST = 5;
const TRACKS_MORE = 20;
/** Alben und Playlists je als eine Reihe */
const SHELF = 12;
/** Aufnahmen mit Datum als Zeilen, so viele */
const DATED = 5;

interface Suggestions {
  searches: string[];
  albums: Album[];
}

/**
 * Ohne Suchbegriff: eigene letzte Suchen, was mehrere andere gesucht haben, oft Gehörtes und
 * Stöbern nach Kategorie und Art der Aufnahme, wie die Kacheln bei Spotify.
 */
function Browse({ user, onPick }: { user: number | undefined; onPick: (value: string) => void }) {
  const { data } = useApi<Facets>('/api/facets');
  const suggestions = useApi<Suggestions>('/api/search/suggestions').data;
  const recent = useRecentSearches(user);
  const categories = useCategories().filter((c) => c.inNav);
  return (
    <>
      {recent.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Zuletzt gesucht</h2>
            <button type="button" class="more-link" onClick={clearSearches}>
              Verlauf löschen
            </button>
          </div>
          <SearchChips items={recent} onPick={onPick} />
        </section>
      )}
      {suggestions && suggestions.searches.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Häufig gesucht</h2>
          </div>
          <SearchChips items={suggestions.searches} onPick={onPick} />
        </section>
      )}
      <Shelf title="Oft gehört" albums={suggestions?.albums ?? []} />
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
      {data && <Kinds facets={data} />}
    </>
  );
}

function SearchChips({ items, onPick }: { items: string[]; onPick: (value: string) => void }) {
  return (
    <div class="chips-row">
      {items.map((item) => (
        <button key={item} type="button" class="chip" onClick={() => onPick(item)}>
          <Icon name="search" size={14} />
          {item}
        </button>
      ))}
    </div>
  );
}

/**
 * Gottesdienste, Bibelstunden … aus der Zuordnung, jeweils nach Datum; dazu Predigten nach Bibelbuch und Sprecher,
 * Musik und Playlists.
 */
function Kinds({ facets: data }: { facets: Facets }) {
  const tiles: Array<{ href: string; label: string; sub?: string; icon?: 'book' | 'mic' }> = [
    ...(data.recordings ?? []).map((kind) => ({
      href: `/datum${query({ art: kind.name })}`,
      label: kind.plural,
      sub: plural(kind.count, 'Aufnahme', 'Aufnahmen'),
    })),
    { href: '/stoebern/bibel', label: 'Nach Bibelbuch', icon: 'book' as const },
    { href: '/stoebern/sprecher', label: 'Nach Sprecher', icon: 'mic' as const },
    ...(data.music ? [{ href: '/alben?art=musik', label: 'Musik', sub: plural(data.music, 'Album', 'Alben') }] : []),
    ...(data.playlists ? [{ href: '/alben?art=playlists', label: 'Playlists', sub: plural(data.playlists, 'Playlist', 'Playlists') }] : []),
  ];
  return (
    <section class="shelf">
      <div class="section-head">
        <h2>Stöbern</h2>
      </div>
      <div class="browse">
        {tiles.map((tile) => (
          <a key={tile.href} class="browse-tile" href={tile.href}>
            <span>{tile.label}</span>
            {tile.icon ? <Icon name={tile.icon} size={22} class="browse-icon" /> : <small>{tile.sub}</small>}
          </a>
        ))}
      </div>
    </section>
  );
}
