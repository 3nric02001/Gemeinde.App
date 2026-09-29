import { useEffect, useState } from 'preact/hooks';

/** Schriftgröße für die Inhalte, auf diesem Gerät gespeichert */
export type TextSize = 'normal' | 'large' | 'xlarge';

export const TEXT_SIZES: Array<[TextSize, string]> = [
  ['normal', 'Normal'],
  ['large', 'Groß'],
  ['xlarge', 'Sehr groß'],
];

const KEY = 'gemeinde.textSize';
const listeners = new Set<() => void>();

export function getTextSize(): TextSize {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'large' || value === 'xlarge' ? value : 'normal';
  } catch {
    return 'normal';
  }
}

/** Setzt data-text am <html>; die Stile vergrößern damit Seiteninhalt, Player und Menüs. */
export function applyTextSize(size: TextSize = getTextSize()): void {
  if (size === 'normal') document.documentElement.removeAttribute('data-text');
  else document.documentElement.setAttribute('data-text', size);
}

export function setTextSize(size: TextSize): void {
  try {
    localStorage.setItem(KEY, size);
  } catch {
    // nur für diese Sitzung
  }
  applyTextSize(size);
  listeners.forEach((listener) => listener());
}

export function useTextSize(): TextSize {
  const [size, setSize] = useState(getTextSize);
  useEffect(() => {
    const update = () => setSize(getTextSize());
    listeners.add(update);
    return () => listeners.delete(update);
  }, []);
  return size;
}
