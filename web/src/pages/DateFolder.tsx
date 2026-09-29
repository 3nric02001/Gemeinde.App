import type { Album, DatedFolderDetail, Track } from '../api';
import { query, trackCoverUrl } from '../api';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { Menu } from '../components/Menu';
import { TrackList } from '../components/TrackList';
import { SermonInfo } from '../components/SermonInfo';
import { FavoriteButton } from '../components/FavoriteButton';
import { albumTitle, formatDuration, formatLongDate, plural, serviceEyebrow } from '../format';
import { useApi } from '../hooks';
import { player } from '../player';
import { ErrorNote, Loading } from './common';

export function DateFolder({ path }: { path: string }) {
  const { data, error } = useApi<DatedFolderDetail>(`/api/dates/folder${query({ path })}`);
  if (error) return <ErrorNote message={error} />;
  if (!data || data.folder !== path) return <Loading />;
  const tracks = data.tracks;
  const artist = mainArtist(tracks);
  const album = folderAlbum(data, artist);
  const title = albumTitle(data.title ?? data.name, data.date);
  return (
    <div class="page">
      <header class="hero">
        <Cover
          src={data.coverTrackId ? trackCoverUrl({ id: data.coverTrackId }) : undefined}
          title={data.name}
          date={data.date}
          class="cover-hero"
          eager
        />
        <div class="hero-text">
          <span class="eyebrow">
            <a href="/datum">{serviceEyebrow(title)}</a>
          </span>
          <h1>{title}</h1>
          <p class="hero-sub">
            {formatLongDate(data.date)}
            {artist && ` · ${artist}`}
          </p>
          <p class="hero-meta">
            {plural(data.trackCount, 'Titel', 'Titel')}, {formatDuration(data.duration)}
          </p>
        </div>
      </header>
      <div class="actions">
        <button type="button" class="button-primary" disabled={!tracks.length} onClick={() => player.playList(tracks, 0, { shuffle: false })}>
          <Icon name="play" size={20} /> Abspielen
        </button>
        <button type="button" class="button-secondary" aria-label="Zufällig abspielen" disabled={!tracks.length} onClick={() => player.playList(tracks, 0, { shuffle: true })}>
          <Icon name="shuffle" size={18} /> <span class="button-label">Zufällig</span>
        </button>
        {album && <FavoriteButton kind="album" item={album} />}
        <Menu
          label="Weitere Aktionen"
          items={[
            { label: 'Als Nächstes spielen', onSelect: () => player.playNext(tracks) },
            { label: 'Zur Warteschlange hinzufügen', onSelect: () => player.append(tracks) },
          ]}
        />
      </div>
      <SermonInfo speaker={data.speaker} passage={data.passage} description={data.description} />
      <TrackList tracks={tracks} variant="album" albumArtist={artist} />
    </div>
  );
}

/** Häufigster Interpret im Ordner; die Titelliste nennt dann nur abweichende Interpreten */
function mainArtist(tracks: Track[]): string | undefined {
  const counts = new Map<string, number>();
  for (const track of tracks) counts.set(track.artist, (counts.get(track.artist) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Das Album des Ordners für das Herz, so wie es auch unter Favoriten erscheint */
function folderAlbum(data: DatedFolderDetail, artist: string | undefined): Album | undefined {
  if (data.albumId === null) return undefined;
  return {
    id: data.albumId,
    title: data.name,
    artist: artist ?? '',
    year: Number(data.date.slice(0, 4)),
    genre: null,
    trackCount: data.trackCount,
    duration: data.duration,
    hasCover: data.coverTrackId !== null,
    date: data.date,
    speaker: data.speaker,
    passage: data.passage,
    description: data.description,
  };
}
