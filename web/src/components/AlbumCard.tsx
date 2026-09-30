import type { Album } from '../api';
import { coverUrl, getJson, type AlbumDetail } from '../api';
import { albumContext, player } from '../player';
import { albumSubtitle, albumTitle } from '../format';
import { Cover } from './Cover';
import { Icon } from './Icon';

export async function playAlbum(albumId: number, options: { shuffle?: boolean; start?: number } = {}) {
  const album = await getJson<AlbumDetail>(`/api/albums/${albumId}`);
  player.playList(album.tracks, options.start ?? 0, { shuffle: options.shuffle ?? false, from: albumContext(album) });
}

export function AlbumCard({ album, subtitle }: { album: Album; subtitle?: string }) {
  const title = albumTitle(album.title, album.date, album.recording);
  return (
    <div class="card">
      <a class="card-link" href={`/album/${album.id}`}>
        <Cover src={album.hasCover ? coverUrl(album.id) : undefined} title={album.title} date={album.date} />
        <span class="card-title">{title}</span>
        <span class="card-sub">{subtitle ?? albumSubtitle(album)}</span>
      </a>
      <button
        class="card-play"
        type="button"
        aria-label={`${title} abspielen`}
        onClick={() => void playAlbum(album.id)}
      >
        <Icon name="play" size={22} />
      </button>
    </div>
  );
}

export function AlbumGrid({ albums }: { albums: Album[] }) {
  return (
    <div class="grid">
      {albums.map((album) => (
        <AlbumCard key={album.id} album={album} />
      ))}
    </div>
  );
}

/** Horizontale Reihe wie "Neu hinzugefügt" bei Spotify */
export function Shelf({ title, href, albums }: { title: string; href?: string; albums: Album[] }) {
  if (!albums.length) return null;
  return (
    <section class="shelf">
      <div class="section-head">
        <h2>{title}</h2>
        {href && (
          <a class="more-link" href={href}>
            Alle anzeigen
          </a>
        )}
      </div>
      <div class="shelf-row">
        {albums.map((album) => (
          <AlbumCard key={album.id} album={album} />
        ))}
      </div>
    </section>
  );
}
