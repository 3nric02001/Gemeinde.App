import type { AlbumDetail } from '../api';
import { AlbumGrid } from '../components/AlbumCard';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { DownloadButton } from '../components/DownloadButton';
import { Menu } from '../components/Menu';
import { TrackList } from '../components/TrackList';
import { FavoriteButton } from '../components/FavoriteButton';
import { SermonInfo } from '../components/SermonInfo';
import { albumTitle, formatLongDate, formatDuration, plural, serviceEyebrow } from '../format';
import { useApi } from '../hooks';
import { albumContext, player } from '../player';
import { coverUrl, kindLabel, query, type Album as AlbumType, type Page } from '../api';
import { BackButton, ErrorNote, Loading } from './common';

export function Album({ id }: { id: number }) {
  const { data: album, error } = useApi<AlbumDetail>(`/api/albums/${id}`);
  // Weitere Aufnahmen derselben Art (Gottesdienste, Bibelstunden), neueste zuerst
  const more = useApi<Page<AlbumType>>(
    album?.recording ? `/api/albums${query({ recording: album.recording, sort: 'date', limit: 13 })}` : undefined,
  );
  if (error) return <ErrorNote message={error} />;
  if (!album || album.id !== id) return <Loading />;

  const others = (more.data?.items ?? []).filter((a) => a.id !== album.id).slice(0, 12);
  const moreHref = `/datum${query({ art: album.recording ?? undefined })}`;
  const from = albumContext(album);
  const eyebrowText = album.date ? serviceEyebrow(albumTitle(album.title, album.date, kindLabel(album)), kindLabel(album)) : undefined;
  // Ohne Anlass heißt der Gottesdienst wie seine Art; eine Zeile "Datum" darüber wäre doppelt.
  const eyebrow = from ? (
    'Playlist'
  ) : album.date ? (
    eyebrowText && <a href={`/datum${query({ art: album.recording ?? undefined })}`}>{eyebrowText}</a>
  ) : (
    'Album'
  );
  return (
    <div class="page">
      <BackButton fallback={album.date ? '/datum' : '/alben'} />
      <header class="hero">
        <Cover src={album.hasCover ? coverUrl(album.id) : undefined} title={album.title} date={album.date} class="cover-hero" eager />
        <div class="hero-text">
          {eyebrow && <span class="eyebrow">{eyebrow}</span>}
          <h1>{albumTitle(album.title, album.date, kindLabel(album))}</h1>
          <p class="hero-sub">
            {/* Nur Datum bzw. Jahr: wer predigt, steht bei der Predigt in der Titelliste */}
            {album.date ? formatLongDate(album.date) : album.year}
          </p>
          <p class="hero-meta">
            {plural(album.trackCount, 'Titel', 'Titel')}, {formatDuration(album.duration)}
          </p>
        </div>
      </header>

      <div class="actions">
        <button type="button" class="button-primary" onClick={() => player.playList(album.tracks, 0, { shuffle: false, from })}>
          <Icon name="play" size={20} /> Abspielen
        </button>
        <button type="button" class="button-secondary" aria-label="Zufällig abspielen" onClick={() => player.playList(album.tracks, 0, { shuffle: true, from })}>
          <Icon name="shuffle" size={18} /> <span class="button-label">Zufällig</span>
        </button>
        <FavoriteButton kind="album" item={album} />
        <DownloadButton tracks={album.tracks} />
        <Menu
          label="Weitere Aktionen für das Album"
          items={[
            { label: 'Als Nächstes spielen', onSelect: () => player.playNext(album.tracks, from) },
            { label: 'Zur Warteschlange hinzufügen', onSelect: () => player.append(album.tracks, from) },
          ]}
        />
      </div>

      <SermonInfo passage={album.passage} description={album.description} />

      <TrackList
        tracks={album.tracks}
        variant="album"
        ordinal={!!from}
        from={from}
      />

      {others.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Weitere Aufnahmen</h2>
            <a class="more-link" href={moreHref}>
              Alle anzeigen
            </a>
          </div>
          <AlbumGrid albums={others} />
        </section>
      )}
    </div>
  );
}

