import { useEffect, useState } from 'preact/hooks';

export interface Location {
  path: string;
  params: URLSearchParams;
}

const listeners = new Set<() => void>();
const read = (): Location => ({ path: window.location.pathname, params: new URLSearchParams(window.location.search) });

window.addEventListener('popstate', () => listeners.forEach((listener) => listener()));

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else {
    window.history.pushState(null, '', to);
    window.scrollTo(0, 0);
    document.querySelector('main')?.scrollTo(0, 0);
  }
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
