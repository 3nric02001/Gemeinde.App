import { useEffect, useState } from 'preact/hooks';

export interface Location {
  path: string;
  params: URLSearchParams;
}

const listeners = new Set<() => void>();
const read = (): Location => ({ path: window.location.pathname, params: new URLSearchParams(window.location.search) });

/** Position im Verlauf dieser App: 0 ist die erste Seite, auf der man gelandet ist (etwa über einen geteilten Link). */
const historyIndex = (): number => (window.history.state as { idx?: number } | null)?.idx ?? 0;
if (typeof (window.history.state as { idx?: number } | null)?.idx !== 'number') window.history.replaceState({ idx: 0 }, '');

/**
 * Bereich, aus dem man zuletzt kam (Datum, Alben, Suche …). Album-Seiten gehören zu keinem
 * eigenen Menüpunkt; markiert wird dann der Bereich, aus dem man sie geöffnet hat.
 */
let lastSection: string | undefined;
const DETAIL = /^\/album\//;
function remember(path: string): void {
  if (!DETAIL.test(path)) lastSection = path;
}
remember(window.location.pathname);

/** Pfad für die Markierung in Seitenleiste und Tab-Leiste */
export function sectionPath(path: string): string {
  return DETAIL.test(path) && lastSection ? lastSection : path;
}

/** Ob "Zurück" innerhalb der App bleibt */
export const canGoBack = (): boolean => historyIndex() > 0;

/** Zurück zur vorigen Seite der App; wer direkt hier gelandet ist, kommt zu `fallback`. */
export function goBack(fallback: string): void {
  if (canGoBack()) window.history.back();
  else navigate(fallback, { replace: true });
}

window.addEventListener('popstate', () => {
  remember(window.location.pathname);
  listeners.forEach((listener) => listener());
});

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return;
  if (options.replace) window.history.replaceState({ idx: historyIndex() }, '', to);
  else {
    window.history.pushState({ idx: historyIndex() + 1 }, '', to);
    window.scrollTo(0, 0);
    document.querySelector('main')?.scrollTo(0, 0);
  }
  remember(window.location.pathname);
  listeners.forEach((listener) => listener());
}

export function useLocation(): Location {
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const update = () => setLocation(read());
    listeners.add(update);
    return () => listeners.delete(update);
  }, []);
  return location;
}

/** Link-Klicks ohne Neuladen; Strg/Cmd-Klick öffnet weiterhin einen neuen Tab. */
export function onLinkClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as HTMLElement).closest('a');
  if (!anchor || anchor.target || anchor.origin !== window.location.origin || anchor.hasAttribute('download')) return;
  event.preventDefault();
  navigate(anchor.pathname + anchor.search);
}

export function match(pattern: string, path: string): Record<string, string> | undefined {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return undefined;
  }
  return params;
}
