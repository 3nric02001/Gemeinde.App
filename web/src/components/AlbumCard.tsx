import type { Album } from '../api';
import { coverUrl, getJson, type AlbumDetail } from '../api';
import { player } from '../player';
import { Cover } from './Cover';
import { Icon } from './Icon';

export async function playAlbum(albumId: number, options: { shuffle?: boolean; start?: number } = {}) {
  const album = await getJson<AlbumDetail>(`/api/albums/${albumId}`);
  player.playList(album.tracks, options.start ?? 0, { shuffle: options.shuffle ?? false });
}

export function AlbumCard({ album, subtitle }: { album: Album; subtitle?: string }) {
  return (
    <div class="card">
      <a class="card-link" href={`/album/${album.id}`}>
        <Cover src={album.hasCover ? coverUrl(album.id) : undefined} title={album.title} />
        <span class="card-title">{album.title}</span>
        <span class="card-sub">{subtitle ?? [album.artist, album.year].filter(Boolean).join(' · ')}</span>
      </a>
      <button
        class="card-play"
        type="button"
        aria-label={`${album.title} abspielen`}
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
