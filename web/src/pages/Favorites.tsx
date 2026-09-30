import { AlbumGrid } from '../components/AlbumCard';
import { DownloadButton } from '../components/DownloadButton';
import { FavoritesCover } from '../components/FavoritesCard';
import { Icon } from '../components/Icon';
import { Menu } from '../components/Menu';
import { TrackList } from '../components/TrackList';
import { formatDuration, plural } from '../format';
import { FAVORITES_CONTEXT, useMe } from '../me';
import { player } from '../player';
import { Empty, Loading } from './common';

/** Die Favoriten des angemeldeten Hörers: die Titel mit Herz als Playlist, darunter die Alben mit Herz */
export function Favorites() {
  const { favorites } = useMe();
  if (!favorites) return <Loading />;
  const { albums, tracks } = favorites;
  const from = FAVORITES_CONTEXT;
  const duration = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);
  return (
    <div class="page">
      {!tracks.length && <h1 class="page-title">Favoriten</h1>}
      {!albums.length && !tracks.length && (
        <Empty title="Noch keine Favoriten">
          Tippe bei einem Album auf das Herz oder wähle bei einem Titel im Menü „Zu den Favoriten“.
        </Empty>
      )}
      {tracks.length > 0 && (
        <>
          <header class="hero">
            <FavoritesCover class="cover-hero" />
            <div class="hero-text">
              <span class="eyebrow">Playlist</span>
              <h1>Favoriten</h1>
              <p class="hero-sub">Deine Titel mit Herz</p>
              <p class="hero-meta">
                {plural(tracks.length, 'Titel', 'Titel')}
                {duration > 0 && `, ${formatDuration(duration)}`}
              </p>
            </div>
          </header>
          <div class="actions">
            <button type="button" class="button-primary" onClick={() => player.playList(tracks, 0, { shuffle: false, from })}>
              <Icon name="play" size={20} /> Abspielen
            </button>
            <button
              type="button"
              class="button-secondary"
              aria-label="Zufällig abspielen"
              onClick={() => player.playList(tracks, 0, { shuffle: true, from })}
            >
              <Icon name="shuffle" size={18} /> <span class="button-label">Zufällig</span>
            </button>
            <DownloadButton tracks={tracks} favorites />
            <Menu
              label="Weitere Aktionen für die Favoriten"
              items={[
                { label: 'Als Nächstes spielen', onSelect: () => player.playNext(tracks, from) },
                { label: 'Zur Warteschlange hinzufügen', onSelect: () => player.append(tracks, from) },
              ]}
            />
          </div>
          <TrackList tracks={tracks} from={from} />
        </>
      )}
      {albums.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Alben</h2>
          </div>
          <AlbumGrid albums={albums} />
        </section>
      )}
    </div>
  );
}
