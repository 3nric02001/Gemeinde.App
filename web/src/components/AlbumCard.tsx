import { useEffect, useRef, useState } from 'preact/hooks';
import type { Album } from '../api';
import { coverUrl, getJson, kindLabel, type AlbumDetail } from '../api';
import { albumContext, player } from '../player';
import { albumSubtitle, albumTitle, formatDuration, plural } from '../format';
import { Cover } from './Cover';
import { Icon } from './Icon';

/** Spielt ein Album ab, ab `start` bzw. ab dem Titel `trackId` (dort setzt der Predigt-Player an der gemerkten Stelle fort). */
export async function playAlbum(albumId: number, options: { shuffle?: boolean; start?: number; trackId?: number } = {}) {
  const album = await getJson<AlbumDetail>(`/api/albums/${albumId}`);
  const index = options.trackId !== undefined ? album.tracks.findIndex((track) => track.id === options.trackId) : -1;
  const start = index >= 0 ? index : (options.start ?? (options.shuffle ? undefined : 0));
  player.playList(album.tracks, start, { shuffle: options.shuffle ?? false, from: albumContext(album) });
}

/**
 * Karte eines Albums. `extra` erscheint nur in der Listenansicht (Datum auf dem Handy) hinter dem Untertitel,
 * z. B. Sprecher und Länge.
 */
export function AlbumCard({ album, subtitle, extra }: { album: Album; subtitle?: string; extra?: string }) {
  const title = albumTitle(album.title, album.date, kindLabel(album));
  return (
    <div class="card">
      <a class="card-link" href={`/album/${album.id}`}>
        <Cover src={album.hasCover ? coverUrl(album.id) : undefined} title={album.title} date={album.date} />
        <span class="card-title">{title}</span>
        <span class="card-sub">
          {subtitle ?? (album.kind === 'manual' ? `Playlist · ${plural(album.trackCount, 'Titel', 'Titel')}` : albumSubtitle(album))}
          {extra && <span class="card-extra"> · {extra}</span>}
        </span>
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

/** Raster aus Karten; `list` macht daraus auf dem Handy eine kompakte Liste mit Sprecher und Länge. */
export function AlbumGrid({ albums, list = false }: { albums: Album[]; list?: boolean }) {
  return (
    <div class={list ? 'grid grid-list' : 'grid'}>
      {albums.map((album) => (
        <AlbumCard
          key={album.id}
          album={album}
          extra={list ? [album.speaker, album.duration ? formatDuration(album.duration) : undefined].filter(Boolean).join(' · ') : undefined}
        />
      ))}
    </div>
  );
}

/** Horizontale Reihe wie "Neu hinzugefügt" bei Spotify; am Rechner mit Pfeilen, sobald nicht alles hineinpasst */
export function Shelf({ title, href, albums }: { title: string; href?: string; albums: Album[] }) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const update = () =>
      setEdges({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [albums.length]);

  if (!albums.length) return null;
  const page = (direction: number) => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.9, behavior: 'smooth' });
  const overflow = !(edges.start && edges.end);
  return (
    <section class="shelf">
      <div class="section-head">
        <h2>{title}</h2>
        {href && (
          <a class="more-link" href={href}>
            Alle anzeigen
          </a>
        )}
        {overflow && (
          <span class="shelf-arrows">
            <button type="button" class="icon-button" aria-label={`${title}: zurückblättern`} disabled={edges.start} onClick={() => page(-1)}>
              <Icon name="back" size={20} />
            </button>
            <button type="button" class="icon-button" aria-label={`${title}: weiterblättern`} disabled={edges.end} onClick={() => page(1)}>
              <Icon name="forward" size={20} />
            </button>
          </span>
        )}
      </div>
      <div ref={row} class={`shelf-row${edges.end ? '' : ' has-more'}`}>
        {albums.map((album) => (
          <AlbumCard key={album.id} album={album} />
        ))}
      </div>
    </section>
  );
}
