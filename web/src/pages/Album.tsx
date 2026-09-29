import type { AlbumDetail } from '../api';
import { AlbumGrid } from '../components/AlbumCard';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { DownloadButton } from '../components/DownloadButton';
import { Menu } from '../components/Menu';
import { TrackList } from '../components/TrackList';
import { FavoriteButton } from '../components/FavoriteButton';
import { SermonInfo } from '../components/SermonInfo';
import { albumTitle, formatLongDate, formatDuration, plural, withoutDate } from '../format';
import { useApi } from '../hooks';
import { player } from '../player';
import { coverUrl, query, type Album as AlbumType, type Page } from '../api';
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
        <Cover src={album.hasCover ? coverUrl(album.id) : undefined} title={album.title} date={album.date} class="cover-hero" eager />
        <div class="hero-text">
          <span class="eyebrow">{album.date ? <a href="/datum">Gottesdienst</a> : 'Album'}</span>
          <h1>{albumTitle(album.title, album.date)}</h1>
          <p class="hero-sub">
            {album.date && withoutDate(album.title) && `${formatLongDate(album.date)} · `}
            <a href={artistHref}>{album.artist}</a>
            {album.year && !album.date && ` · ${album.year}`}
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
        <FavoriteButton kind="album" item={album} />
        <DownloadButton tracks={album.tracks} />
        <Menu
          label="Weitere Aktionen für das Album"
          items={[
            { label: 'Als Nächstes spielen', onSelect: () => player.playNext(album.tracks) },
            { label: 'Zur Warteschlange hinzufügen', onSelect: () => player.append(album.tracks) },
          ]}
        />
      </div>

      <SermonInfo speaker={album.speaker} passage={album.passage} description={album.description} />

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

