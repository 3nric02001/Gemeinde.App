import { trackCoverUrl } from '../api';
import { currentHref, player, usePlayerSelect } from '../player';
import { Controls, RateButton, Volume } from './Controls';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { Seek } from './Seek';

/** Leiste am unteren Rand; auf dem Handy ein Mini-Player, der sich per Tipp aufklappt. */
export function PlayerBar({ onExpand }: { onExpand: () => void }) {
  const track = usePlayerSelect((s) => s.current);
  const from = usePlayerSelect((s) => s.from);
  const playing = usePlayerSelect((s) => s.playing);
  const error = usePlayerSelect((s) => s.error);
  const progress = usePlayerSelect((s) => (s.duration ? Math.round((s.position / s.duration) * 200) / 2 : 0));

  return (
    <footer class={`player-bar${track ? '' : ' is-empty'}`} aria-label="Wiedergabe">
      <div class="player-now" onClick={() => track && onExpand()}>
        {track ? (
          <>
            <Cover src={trackCoverUrl(track)} title={track.album ?? track.title} date={track.albumDate} class="cover-bar" />
            <div class="player-meta">
              <a
                class="player-title"
                href={currentHref(track, from)}
                onClick={(event) => event.stopPropagation()}
              >
                {track.title}
              </a>
              <a
                class="player-artist"
                href={`/interpret/${encodeURIComponent(track.artist)}`}
                onClick={(event) => event.stopPropagation()}
              >
                {error ?? track.speaker ?? track.artist}
              </a>
            </div>
          </>
        ) : (
          <span class="player-hint">Wähle ein Album oder einen Titel</span>
        )}
      </div>

      <div class="player-center">
        <Controls />
        <Seek />
      </div>

      <div class="player-side">
        <RateButton />
        <a class="icon-button" href="/warteschlange" aria-label="Warteschlange">
          <Icon name="queue" size={20} />
        </a>
        <Volume />
      </div>

      {/* Nur auf dem Handy sichtbar */}
      <button
        type="button"
        class="mini-play"
        aria-label={playing ? 'Pause' : 'Abspielen'}
        disabled={!track}
        onClick={() => player.toggle()}
      >
        <Icon name={playing ? 'pause' : 'play'} size={26} />
      </button>
      <div class="mini-track">
        <div class="mini-progress" style={{ width: `${progress}%` }} />
      </div>
    </footer>
  );
}
