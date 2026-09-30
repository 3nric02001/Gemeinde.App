import { AlbumGrid } from '../components/AlbumCard';
import { Icon } from '../components/Icon';
import { TrackList } from '../components/TrackList';
import { plural } from '../format';
import { useMe } from '../me';
import { player } from '../player';
import { Empty, Loading } from './common';

/** Die Favoriten des angemeldeten Hörers: Alben und Titel mit Herz */
export function Favorites() {
  const { favorites } = useMe();
  if (!favorites) return <Loading />;
  const { albums, tracks } = favorites;
  return (
    <div class="page">
      <h1 class="page-title">Favoriten</h1>
      {!albums.length && !tracks.length && (
        <Empty title="Noch keine Favoriten">
          Tippe bei einem Album auf das Herz oder wähle bei einem Titel im Menü „Zu den Favoriten“.
        </Empty>
      )}
      {tracks.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Titel</h2>
          </div>
          <div class="actions">
            <button type="button" class="button-primary" onClick={() => player.playList(tracks, 0, { shuffle: false })}>
              <Icon name="play" size={20} /> Abspielen
            </button>
            <button type="button" class="button-secondary" onClick={() => player.playShuffled(tracks)}>
              <Icon name="shuffle" size={18} /> Zufällig
            </button>
            <span class="count">{plural(tracks.length, 'Titel', 'Titel')}</span>
          </div>
          <TrackList tracks={tracks} />
        </section>
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
