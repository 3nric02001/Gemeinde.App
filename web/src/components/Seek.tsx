import { useEffect, useRef, useState } from 'preact/hooks';
import { formatTime } from '../format';
import { player, usePlayer } from '../player';

/** Wann ein Ziehen am Regler endet; `change` allein reicht nicht (fehlt, wenn der Wert gleich bleibt). */
const COMMIT_EVENTS = ['change', 'pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur'];

/** Fortschrittsbalken; während des Ziehens springt die Anzeige nicht zurück. */
export function Seek({ compact = false }: { compact?: boolean }) {
  const { position, duration, current, currentKey, live } = usePlayer();
  const [dragging, setDragging] = useState<number | null>(null);
  const draggingRef = useRef<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const drag = (value: number | null) => {
    draggingRef.current = value;
    setDragging(value);
  };

  // Erst beim Loslassen springen. Absichtlich ein eigener Listener statt onChange: preact/compat
  // (für createPortal geladen) macht aus onChange an Eingabefeldern onInput, dann sprang die
  // Wiedergabe schon beim Ziehen und die Anzeige blieb danach auf dem gezogenen Wert stehen.
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const commit = () => {
      if (draggingRef.current === null) return;
      player.seek(Number(element.value));
      drag(null);
    };
    for (const name of COMMIT_EVENTS) element.addEventListener(name, commit);
    return () => {
      for (const name of COMMIT_EVENTS) element.removeEventListener(name, commit);
    };
  }, [live]);

  // Anderer oder neu gestarteter Titel: kein alter Ziehwert mehr
  useEffect(() => drag(null), [currentKey, live]);

  // Beim Livestream gibt es keine Stelle, zu der man springen könnte
  if (live) {
    return (
      <div class={`seek seek-live${compact ? ' seek-compact' : ''}`}>
        <span class="live-badge">
          <i aria-hidden="true" />
          Live
        </span>
      </div>
    );
  }
  const max = duration || 0;
  const value = Math.min(dragging ?? position, max || Infinity);
  const percent = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div class={`seek${compact ? ' seek-compact' : ''}`}>
      <span class="seek-time">{formatTime(value)}</span>
      <input
        ref={input}
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
        onInput={(event) => drag(Number((event.target as HTMLInputElement).value))}
      />
      <span class="seek-time">{formatTime(max)}</span>
    </div>
  );
}
