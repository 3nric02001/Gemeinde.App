import { useEffect, useState } from 'preact/hooks';
import { useAuth } from './auth';

/**
 * Sendet der Livestream gerade? Der Server fragt den Stream-Server höchstens einmal pro Minute; die App fragt den
 * Server, solange eine Seite mit Kachel offen und sichtbar ist. null: unbekannt (anderer Stream-Server, Fehler).
 */
const POLL_MS = 60_000;

let live: boolean | null = null;
const listeners = new Set<(value: boolean | null) => void>();
let timer: number | undefined;

async function check(): Promise<void> {
  if (document.visibilityState === 'hidden') return;
  try {
    const res = await fetch('/api/live', { headers: { accept: 'application/json' } });
    const data = res.ok ? ((await res.json()) as { live: boolean | null }) : { live: null };
    live = data.live;
  } catch {
    live = null;
  }
  listeners.forEach((listener) => listener(live));
}

function subscribe(listener: (value: boolean | null) => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void check();
    timer = window.setInterval(() => void check(), POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

function onVisible(): void {
  if (document.visibilityState === 'visible') void check();
}

/** true: sendet gerade, false: sendet nicht, null: unbekannt oder kein Livestream eingerichtet */
export function useLive(): boolean | null {
  const enabled = Boolean(useAuth().livestream);
  const [value, setValue] = useState(live);
  useEffect(() => (enabled ? subscribe(setValue) : undefined), [enabled]);
  return enabled ? value : null;
}
