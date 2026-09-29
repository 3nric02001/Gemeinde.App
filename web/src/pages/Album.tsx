import type { AlbumDetail } from '../api';
import { AlbumGrid } from '../components/AlbumCard';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { Menu } from '../components/Menu';
import { TrackList } from '../components/TrackList';
import { formatDuration, plural } from '../format';
import { useApi } from '../hooks';
import { player } from '../player';
import { query, type Album as AlbumType, type Page } from '../api';
import { ErrorNote, Loading } from './common';

export function Album({ id }: { id: number }) {
  const { data: album, error } = useApi<AlbumDetail>(`/api/albums/${id}`);
  const more = useApi<Page<AlbumType>>(album ? `/api/albums${query({ artist: album.artist, limit: 13 })}` : undefined);
  if (error) return <ErrorNote message={error} />;
  if (!album || album.id !== id) return <Loading />;

  const others = (more.data?.items ?? []).filter((a) => a.id !== album.id).slice(0, 12);
  const artistHref = `/interpret/${encodeURIComponent(album.artist)}`;
  return (
    <div class="page">
      <header class="hero">
        <Cover albumId={album.id} hasCover={album.hasCover} title={album.title} class="cover-hero" eager />
        <div class="hero-text">
          <span class="eyebrow">Album</span>
          <h1>{album.title}</h1>
          <p class="hero-sub">
            <a href={artistHref}>{album.artist}</a>
            {album.year && ` · ${album.year}`}
            {album.genre && (
              <>
                {' · '}
                <a href={`/alben${query({ genre: album.genre })}`}>{album.genre}</a>
              </>
            )}
          </p>
          <p class="hero-meta">
            {plural(album.trackCount, 'Titel', 'Titel')}, {formatDuration(album.duration)}
          </p>
        </div>
      </header>

      <div class="actions">
        <button type="button" class="button-primary" onClick={() => player.playList(album.tracks, 0, { shuffle: false })}>
          <Icon name="play" size={20} /> Abspielen
        </button>
        <button type="button" class="button-secondary" onClick={() => player.playList(album.tracks, 0, { shuffle: true })}>
          <Icon name="shuffle" size={18} /> Zufällig
        </button>
        <Menu
          label="Weitere Aktionen für das Album"
          items={[
            { label: 'Als Nächstes spielen', onSelect: () => player.playNext(album.tracks) },
            { label: 'Zur Warteschlange hinzufügen', onSelect: () => player.append(album.tracks) },
          ]}
        />
      </div>

      <TrackList tracks={album.tracks} variant="album" albumArtist={album.artist} ordinal={album.kind === 'manual'} />

      {others.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Mehr von {album.artist}</h2>
            <a class="more-link" href={artistHref}>
              Alle anzeigen
            </a>
          </div>
          <AlbumGrid albums={others} />
        </section>
      )}
    </div>
  );
}

