import { trackCoverUrl } from '../api';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { Equalizer } from '../components/TrackList';
import { formatTime } from '../format';
import { player, usePlayerSelect, type Entry } from '../player';
import { addToPlaylistDialog } from '../playlists';
import { Empty } from './common';

function Row({ entry, index, current, playing }: { entry: Entry; index: number; current: boolean; playing: boolean }) {
  const { track } = entry;
  return (
    <li class={`track${current ? ' is-current' : ''}`} onClick={() => (current ? player.toggle() : player.jump(index))}>
      <span class="track-lead">
        <Cover src={trackCoverUrl(track)} title={track.album ?? track.title} date={track.albumDate} class="cover-sm" />
        <span class="track-play" aria-hidden="true">
          {current && playing ? <Equalizer /> : <Icon name="play" size={18} />}
        </span>
      </span>
      <span class="track-main">
        <span class="track-title">{track.title}</span>
        <span class="track-sub">{track.speaker ?? track.album}</span>
      </span>
      <span class="track-time">{formatTime(track.duration)}</span>
      {!current && (
        <button
          type="button"
          class="icon-button"
          aria-label={`${track.title} entfernen`}
          onClick={(event) => {
            event.stopPropagation();
            player.remove(index);
          }}
        >
          <Icon name="close" size={18} />
        </button>
      )}
    </li>
  );
}

export function QueuePage() {
  const queue = usePlayerSelect((s) => s.queue);
  const index = usePlayerSelect((s) => s.index);
  const key = usePlayerSelect((s) => s.currentKey);
  const playing = usePlayerSelect((s) => s.playing);

  if (index < 0) return <div class="page"><h1 class="page-title">Warteschlange</h1><Empty title="Die Warteschlange ist leer" /></div>;
  const current = queue[index]!;
  const upcoming = queue.slice(index + 1);
  return (
    <div class="page">
      <div class="page-head">
        <h1 class="page-title">Warteschlange</h1>
        <button type="button" class="button-secondary" onClick={() => addToPlaylistDialog(queue.slice(index).map((entry) => entry.track))}>
          <Icon name="playlist" size={18} /> Als Playlist speichern
        </button>
      </div>
      <section class="shelf">
        <div class="section-head">
          <h2>Jetzt läuft</h2>
        </div>
        <ol class="tracks tracks-list">
          <Row entry={current} index={index} current playing={playing} key={key} />
        </ol>
      </section>
      <section class="shelf">
        <div class="section-head">
          <h2>Als Nächstes</h2>
          {upcoming.length > 0 && (
            <button type="button" class="more-link" onClick={() => player.clearUpcoming()}>
              Leeren
            </button>
          )}
        </div>
        {upcoming.length ? (
          <ol class="tracks tracks-list">
            {upcoming.map((entry, i) => (
              <Row key={entry.key} entry={entry} index={index + 1 + i} current={false} playing={false} />
            ))}
          </ol>
        ) : (
          <p class="count">Danach ist Schluss.</p>
        )}
      </section>
    </div>
  );
}
