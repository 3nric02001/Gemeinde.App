import { player, usePlayerSelect } from '../player';
import { Icon } from './Icon';

export function Controls({ large = false }: { large?: boolean }) {
  const playing = usePlayerSelect((s) => s.playing);
  const shuffle = usePlayerSelect((s) => s.shuffle);
  const repeat = usePlayerSelect((s) => s.repeat);
  const hasTrack = usePlayerSelect((s) => Boolean(s.current));
  const repeatLabel = repeat === 'off' ? 'Wiederholen' : repeat === 'all' ? 'Einen Titel wiederholen' : 'Wiederholen aus';
  return (
    <div class={`controls${large ? ' controls-large' : ''}`}>
      <button
        type="button"
        class={`icon-button toggle${shuffle ? ' is-on' : ''}`}
        aria-label="Zufallswiedergabe"
        aria-pressed={shuffle}
        onClick={() => player.toggleShuffle()}
      >
        <Icon name="shuffle" size={large ? 24 : 18} />
      </button>
      <button type="button" class="icon-button" aria-label="Zurück" disabled={!hasTrack} onClick={() => player.previous()}>
        <Icon name="previous" size={large ? 34 : 22} />
      </button>
      <button
        type="button"
        class="play-button"
        aria-label={playing ? 'Pause' : 'Abspielen'}
        disabled={!hasTrack}
        onClick={() => player.toggle()}
      >
        <Icon name={playing ? 'pause' : 'play'} size={large ? 34 : 22} />
      </button>
      <button type="button" class="icon-button" aria-label="Weiter" disabled={!hasTrack} onClick={() => player.next()}>
        <Icon name="next" size={large ? 34 : 22} />
      </button>
      <button
        type="button"
        class={`icon-button toggle${repeat !== 'off' ? ' is-on' : ''}`}
        aria-label={repeatLabel}
        aria-pressed={repeat !== 'off'}
        onClick={() => player.cycleRepeat()}
      >
        <Icon name="repeat" size={large ? 24 : 18} />
        {repeat === 'one' && <span class="repeat-one">1</span>}
      </button>
    </div>
  );
}

export function Volume() {
  const volume = usePlayerSelect((s) => s.volume);
  const muted = usePlayerSelect((s) => s.muted);
  const value = muted ? 0 : volume;
  return (
    <div class="volume">
      <button type="button" class="icon-button" aria-label={muted ? 'Ton an' : 'Stumm'} onClick={() => player.toggleMute()}>
        <Icon name={value === 0 ? 'mute' : 'volume'} size={20} />
      </button>
      <input
        type="range"
        class="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        aria-label="Lautstärke"
        style={{ '--fill': `${value * 100}%` }}
        onInput={(event) => player.setVolume(Number((event.target as HTMLInputElement).value))}
      />
    </div>
  );
}
