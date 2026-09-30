import { useEffect, useRef } from 'preact/hooks';
import { trackCoverUrl } from '../api';
import { albumLabel } from '../format';
import { navigate } from '../router';
import { currentHref, usePlayerSelect } from '../player';
import { Controls, RateButton, Volume } from './Controls';
import { Cover } from './Cover';
import { FavoriteButton } from './FavoriteButton';
import { Icon } from './Icon';
import { Seek } from './Seek';

/** Vollbild "Jetzt läuft" mit großem Cover, wie bei Apple Music; nach unten wischen schließt. */
export function NowPlaying({ onClose }: { onClose: () => void }) {
  const track = usePlayerSelect((s) => s.current);
  const from = usePlayerSelect((s) => s.from);
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | undefined>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!track) return null;
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const album = albumLabel(track.album, track.albumDate);

  // Wischen nach unten wie bei Apple Music: Ansicht folgt dem Finger, ab 120 px schließt sie.
  const onTouchStart = (event: TouchEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, .controls')) return;
    drag.current = { y: event.touches[0]!.clientY, dy: 0 };
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!drag.current || !sheet.current) return;
    drag.current.dy = Math.max(0, event.touches[0]!.clientY - drag.current.y);
    sheet.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onTouchEnd = () => {
    const dy = drag.current?.dy ?? 0;
    drag.current = undefined;
    if (dy > 120) onClose();
    else if (sheet.current) sheet.current.style.transform = '';
  };

  return (
    <div
      ref={sheet}
      class="now-playing"
      role="dialog"
      aria-modal="true"
      aria-label="Jetzt läuft"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div class="now-top">
        <button type="button" class="icon-button" aria-label="Schließen" onClick={onClose}>
          <Icon name="down" size={28} />
        </button>
        {from ? (
          <a class="now-label now-from" href={from.href} onClick={(event) => (event.preventDefault(), go(from.href))}>
            <small>Aus der Playlist</small>
            <span>{from.title}</span>
          </a>
        ) : (
          <span class="now-label">Jetzt läuft</span>
        )}
        <button type="button" class="icon-button" aria-label="Warteschlange" onClick={() => go('/warteschlange')}>
          <Icon name="queue" size={22} />
        </button>
      </div>
      <Cover src={trackCoverUrl(track)} title={track.album ?? track.title} date={track.albumDate} class="cover-now" eager />
      <div class="now-head">
        <div class="now-meta">
          <button type="button" class="now-title" onClick={() => {
              const href = currentHref(track, from);
              if (href) go(href);
            }}>
            {track.title}
          </button>
          {track.speaker && <span class="now-artist">{track.speaker}</span>}
          {album && track.albumId && (
            <a class="now-album" href={`/album/${track.albumId}`} onClick={(event) => (event.preventDefault(), go(`/album/${track.albumId}`))}>
              {album}
            </a>
          )}
        </div>
        <FavoriteButton kind="track" item={track} />
      </div>
      <Seek />
      <Controls large />
      <div class="now-extra">
        <RateButton />
        <Volume />
      </div>
    </div>
  );
}
