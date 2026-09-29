import { useEffect } from 'preact/hooks';
import { navigate } from '../router';
import { usePlayerSelect } from '../player';
import { Controls, Volume } from './Controls';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { Seek } from './Seek';

/** Vollbild "Jetzt läuft" mit großem Cover, wie bei Apple Music */
export function NowPlaying({ onClose }: { onClose: () => void }) {
  const track = usePlayerSelect((s) => s.current);

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
  return (
    <div class="now-playing" role="dialog" aria-modal="true" aria-label="Jetzt läuft">
      <div class="now-top">
        <button type="button" class="icon-button" aria-label="Schließen" onClick={onClose}>
          <Icon name="down" size={28} />
        </button>
        <span class="now-label">Jetzt läuft</span>
        <button type="button" class="icon-button" aria-label="Warteschlange" onClick={() => go('/warteschlange')}>
          <Icon name="queue" size={22} />
        </button>
      </div>
      <Cover albumId={track.albumId} title={track.album ?? track.title} class="cover-now" eager />
      <div class="now-meta">
        <button type="button" class="now-title" onClick={() => track.albumId && go(`/album/${track.albumId}`)}>
          {track.title}
        </button>
        <button type="button" class="now-artist" onClick={() => go(`/interpret/${encodeURIComponent(track.artist)}`)}>
          {track.artist}
        </button>
      </div>
      <Seek />
      <Controls large />
      <Volume />
    </div>
  );
}
