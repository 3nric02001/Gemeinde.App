import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePaged } from '../src/hooks';

function List() {
  const { sentinel } = usePaged<number>('/api/tracks');
  return <div ref={sentinel} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Nachladen beim Scrollen', () => {
  const observe = () => {
    const roots: Array<Element | Document | null | undefined> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(_: unknown, options?: IntersectionObserverInit) {
          roots.push(options?.root);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [], total: 0 })));
    return roots;
  };

  it('beobachtet auf dem Handy den scrollenden Inhalt statt der Seite', () => {
    const roots = observe();
    const main = document.createElement('main');
    main.className = 'main';
    main.style.overflowY = 'auto';
    document.body.append(main);
    render(<List />, { container: main });
    expect(roots.at(-1)).toBe(main);
    main.remove();
  });

  it('beobachtet sonst die Seite', () => {
    const roots = observe();
    const main = document.createElement('main');
    main.className = 'main';
    document.body.append(main);
    render(<List />, { container: main });
    expect(roots.at(-1)).toBeNull();
    main.remove();
  });
});
