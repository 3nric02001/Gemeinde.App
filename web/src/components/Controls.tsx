import { usesSermonPlayer } from '../me';
import { player, usePlayerSelect } from '../player';
import { Icon, SkipIcon } from './Icon';

/** Predigten (laut Policies, sonst lange Titel) zeigen statt Zufall und Wiederholen die Sprungknöpfe */
export const useLongTrack = () => usePlayerSelect((s) => usesSermonPlayer(s.current, s.duration));

export function Controls({ large = false }: { large?: boolean }) {
  const playing = usePlayerSelect((s) => s.playing);
  const shuffle = usePlayerSelect((s) => s.shuffle);
  const repeat = usePlayerSelect((s) => s.repeat);
  const hasTrack = usePlayerSelect((s) => Boolean(s.current));
  const long = useLongTrack();
  const repeatLabel = repeat === 'off' ? 'Wiederholen' : repeat === 'all' ? 'Einen Titel wiederholen' : 'Wiederholen aus';
  const skip = (seconds: number) => (
    <button
      type="button"
      class="icon-button skip-button"
      aria-label={seconds < 0 ? `${-seconds} Sekunden zurück` : `${seconds} Sekunden vor`}
      disabled={!hasTrack}
      onClick={() => player.skip(seconds)}
    >
      <SkipIcon seconds={seconds} size={large ? 32 : 24} />
    </button>
  );
  return (
    <div class={`controls${large ? ' controls-large' : ''}`}>
      {long ? (
        skip(-15)
      ) : (
        <button
          type="button"
          class={`icon-button toggle${shuffle ? ' is-on' : ''}`}
          aria-label="Zufallswiedergabe"
          aria-pressed={shuffle}
          onClick={() => player.toggleShuffle()}
        >
          <Icon name="shuffle" size={large ? 24 : 18} />
        </button>
      )}
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
      {long ? (
        skip(30)
      ) : (
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
      )}
    </div>
  );
}

/** Tempo für Predigten: 1×, 1,25× … 2× */
export function RateButton() {
  const rate = usePlayerSelect((s) => s.rate);
  const long = useLongTrack();
  if (!long) return null;
  const label = `${rate.toLocaleString('de-DE')}×`;
  return (
    <button
      type="button"
      class={`rate-button${rate !== 1 ? ' is-on' : ''}`}
      aria-label={`Tempo ${label}, antippen zum Ändern`}
      onClick={() => player.cycleRate()}
    >
      {label}
    </button>
  );
}

/**
 * iPhone und iPad erlauben Webseiten nicht, die Lautstärke zu ändern (nur die Tasten am Gerät);
 * dort blenden wir den Regler aus. iPadOS meldet sich als Mac mit Touch.
 */
export const canSetVolume = () =>
  !/iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function Volume() {
  if (!canSetVolume()) return null;
  return <VolumeSlider />;
}

function VolumeSlider() {
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
