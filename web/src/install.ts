import { useEffect, useState } from 'preact/hooks';

/**
 * "Zum Home-Bildschirm": Chrome/Android bietet ein eigenes Installationsfenster an (beforeinstallprompt),
 * iPhone und iPad nur den Weg über das Teilen-Menü in Safari.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = undefined;
    notify();
  });
}

export type Platform = 'ios' | 'android' | 'other';

export function platform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

/** Läuft die App schon als eigenes Symbol vom Home-Bildschirm? */
export function isInstalled(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useInstall() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const update = () => setVersion((v) => v + 1);
    listeners.add(update);
    return () => listeners.delete(update);
  }, []);
  return {
    canPrompt: Boolean(deferred),
    prompt: async () => {
      const event = deferred;
      if (!event) return;
      deferred = undefined;
      await event.prompt();
      notify();
    },
  };
}

const DISMISSED_KEY = 'gemeinde.installHint';

export function hintDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return true;
  }
}

export function dismissHint(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // ohne Speicher erscheint der Hinweis eben wieder
  }
}
