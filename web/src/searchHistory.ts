import { useEffect, useState } from 'preact/hooks';

/**
 * "Zuletzt gesucht": nur auf diesem Gerät und nur für die angemeldete Person. Beim Abmelden
 * gelöscht, damit auf einem geteilten Gerät niemand die Suchen der anderen sieht.
 */

const KEY = 'gemeinde.searches';
const MAX = 6;
const listeners = new Set<() => void>();

interface Saved {
  user: number;
  items: string[];
}

function read(): Saved | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    return saved && Array.isArray(saved.items) ? saved : undefined;
  } catch {
    return undefined;
  }
}

function write(saved: Saved | undefined): void {
  try {
    if (saved) localStorage.setItem(KEY, JSON.stringify(saved));
    else localStorage.removeItem(KEY);
  } catch {
    // Gesperrter Speicher: dann eben ohne Verlauf.
  }
  listeners.forEach((listener) => listener());
}

export function recentSearches(user: number): string[] {
  const saved = read();
  return saved?.user === user ? saved.items : [];
}

export function rememberSearch(user: number, q: string): void {
  const same = (item: string) => item.toLocaleLowerCase() === q.toLocaleLowerCase();
  write({ user, items: [q, ...recentSearches(user).filter((item) => !same(item))].slice(0, MAX) });
}

export function clearSearches(): void {
  write(undefined);
}

export function useRecentSearches(user: number | undefined): string[] {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return user ? recentSearches(user) : [];
}
