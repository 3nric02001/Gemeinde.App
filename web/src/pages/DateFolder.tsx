import type { DatedFolderDetail } from '../api';
import { query, trackCoverUrl } from '../api';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { Menu } from '../components/Menu';
import { TrackList } from '../components/TrackList';
import { SermonInfo } from '../components/SermonInfo';
import { formatDuration, formatLongDate, plural, withoutDate } from '../format';
import { useApi } from '../hooks';
import { player } from '../player';
import { ErrorNote, Loading } from './common';

export function DateFolder({ path }: { path: string }) {
  const { data, error } = useApi<DatedFolderDetail>(`/api/dates/folder${query({ path })}`);
  if (error) return <ErrorNote message={error} />;
  if (!data || data.folder !== path) return <Loading />;
  const tracks = data.tracks;
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
            <a href="/datum">Datum</a>
          </span>
          <h1>{formatLongDate(data.date)}</h1>
          {withoutDate(data.name) && <p class="hero-sub">{withoutDate(data.name)}</p>}
          <p class="hero-meta">
            {plural(data.trackCount, 'Titel', 'Titel')}, {formatDuration(data.duration)}
          </p>
        </div>
      </header>
      <div class="actions">
        <button type="button" class="button-primary" disabled={!tracks.length} onClick={() => player.playList(tracks, 0, { shuffle: false })}>
          <Icon name="play" size={20} /> Abspielen
        </button>
        <button type="button" class="button-secondary" disabled={!tracks.length} onClick={() => player.playList(tracks, 0, { shuffle: true })}>
          <Icon name="shuffle" size={18} /> Zufällig
        </button>
        <Menu
          label="Weitere Aktionen"
          items={[
            { label: 'Als Nächstes spielen', onSelect: () => player.playNext(tracks) },
            { label: 'Zur Warteschlange hinzufügen', onSelect: () => player.append(tracks) },
          ]}
        />
      </div>
      <SermonInfo speaker={data.speaker} passage={data.passage} description={data.description} />
      <TrackList tracks={tracks} />
    </div>
  );
}
