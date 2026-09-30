import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Marquee } from '../src/components/Marquee';

/** happy-dom rechnet kein Layout: Breiten von Zeile und Text hier vorgeben. */
const layout = (box: number, text: number) => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(box);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(text);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Marquee', () => {
  it('steht still, wenn der Text in die Zeile passt', () => {
    layout(300, 200);
    render(<Marquee text="Kurz" />);
    const box = screen.getByText('Kurz').parentElement!;
    expect(box.classList.contains('is-running')).toBe(false);
  });

  it('läuft um genau den überstehenden Teil durch, wenn der Text zu lang ist', () => {
    layout(300, 420);
    render(<Marquee text="Ein sehr langer Predigttitel" />);
    const box = screen.getByText('Ein sehr langer Predigttitel').parentElement!;
    expect(box.classList.contains('is-running')).toBe(true);
    expect(box.dataset.shift).toBe('120');
  });
});
