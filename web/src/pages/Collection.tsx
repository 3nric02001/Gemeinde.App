import type { Album, Page, Track } from '../api';
import { query } from '../api';
import { AlbumGrid } from '../components/AlbumCard';
import { Icon } from '../components/Icon';
import { TrackList } from '../components/TrackList';
import { hashHue, initials, plural } from '../format';
import { useApi } from '../hooks';
import { player } from '../player';
import { ErrorNote, Loading } from './common';

/**
 * Alben und Titel zu einem Wert einer Kategorie, z. B. ein Sprecher oder "Predigt".
 * `filter` sind die Query-Parameter für /api/albums und /api/tracks.
 */
export function Collection({ eyebrow, name, filter }: { eyebrow: string; name: string; filter: Record<string, string> }) {
  const albums = useApi<Page<Album>>(`/api/albums${query({ ...filter, sort: 'year', limit: 200 })}`);
  const tracks = useApi<Page<Track>>(`/api/tracks${query({ ...filter, limit: 500 })}`);
  if (albums.error) return <ErrorNote message={albums.error} />;
  if (!albums.data || !tracks.data) return <Loading />;
  const all = tracks.data.items;

  return (
    <div class="page">
      <header class="hero hero-artist">
        <span class="avatar avatar-hero" style={{ '--hue': hashHue(name) }} aria-hidden="true">
          {initials(name)}
        </span>
        <div class="hero-text">
          <span class="eyebrow">{eyebrow}</span>
          <h1>{name}</h1>
          <p class="hero-meta">
            {plural(albums.data.total, 'Album', 'Alben')} · {plural(tracks.data.total, 'Titel', 'Titel')}
          </p>
        </div>
      </header>
      <div class="actions">
        <button type="button" class="button-primary" disabled={!all.length} onClick={() => player.playList(all, 0, { shuffle: false })}>
          <Icon name="play" size={20} /> Abspielen
        </button>
        <button type="button" class="button-secondary" disabled={!all.length} onClick={() => player.playList(all, 0, { shuffle: true })}>
          <Icon name="shuffle" size={18} /> Zufällig
        </button>
      </div>

      {albums.data.items.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Alben</h2>
          </div>
          <AlbumGrid albums={albums.data.items} />
        </section>
      )}
      {all.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Titel</h2>
          </div>
          <TrackList tracks={all} />
        </section>
      )}
    </div>
  );
}
