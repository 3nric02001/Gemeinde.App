import { useState } from 'preact/hooks';
import { formatTime } from '../format';
import { player, usePlayer } from '../player';

/** Fortschrittsbalken; während des Ziehens springt die Anzeige nicht zurück. */
export function Seek({ compact = false }: { compact?: boolean }) {
  const { position, duration, current } = usePlayer();
  const [dragging, setDragging] = useState<number | null>(null);
  const value = dragging ?? position;
  const max = duration || 0;
  const percent = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div class={`seek${compact ? ' seek-compact' : ''}`}>
      <span class="seek-time">{formatTime(value)}</span>
      <input
        type="range"
        class="range"
        min={0}
        max={max || 1}
        step={0.1}
        value={value}
        disabled={!current}
        aria-label="Position im Titel"
        aria-valuetext={`${formatTime(value)} von ${formatTime(max)}`}
        style={{ '--fill': `${percent}%` }}
        onInput={(event) => setDragging(Number((event.target as HTMLInputElement).value))}
        onChange={(event) => {
          player.seek(Number((event.target as HTMLInputElement).value));
          setDragging(null);
        }}
      />
      <span class="seek-time">{formatTime(max)}</span>
    </div>
  );
}
