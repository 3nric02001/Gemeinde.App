import type { Track } from '../api';
import { download, removeDownloads, useOffline } from '../offline';
import { Icon } from './Icon';

/** Album oder Gottesdienst offline verfügbar machen; zeigt den Fortschritt als Ring. */
export function DownloadButton({ tracks }: { tracks: Track[] }) {
  const offline = useOffline();
  if (!offline.enabled || !tracks.length) return null;
  const saved = tracks.filter((track) => offline.ids.has(track.id)).length;
  const loading = tracks.filter((track) => offline.progress.has(track.id));

  if (loading.length) {
    const share = (saved + loading.reduce((sum, track) => sum + offline.progress.get(track.id)!, 0)) / tracks.length;
    const percent = Math.round(share * 100);
    return (
      <button
        type="button"
        class="icon-button download-button is-loading"
        style={{ '--p': share }}
        aria-label={`Wird heruntergeladen, ${percent} %`}
        title={`Wird heruntergeladen, ${percent} %`}
        disabled
      >
        <Icon name="download" size={20} />
      </button>
    );
  }

  const all = saved === tracks.length;
  return (
    <button
      type="button"
      class={`icon-button download-button${all ? ' is-on' : ''}`}
      aria-label={all ? 'Offline verfügbar, tippen zum Löschen' : 'Herunterladen für offline'}
      title={all ? 'Offline verfügbar' : 'Herunterladen für offline'}
      aria-pressed={all}
      onClick={(event) => {
        event.stopPropagation();
        if (!all) download(tracks);
        else if (window.confirm('Offline-Kopie von diesem Gerät löschen?')) void removeDownloads(tracks.map((track) => track.id));
      }}
    >
      <Icon name={all ? 'downloaded' : 'download'} size={22} />
    </button>
  );
}
