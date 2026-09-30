import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from './Icon';

/**
 * Kleines Fenster über der App, auf dem Handy als Blatt von unten. Escape, Schließen-Knopf und
 * ein Tipp neben das Fenster schließen es.
 */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    // Vor der Tastatursteuerung der App (Leertaste, "/")
    window.addEventListener('keydown', onKey, true);
    const first = box.current?.querySelector<HTMLElement>('input, button:not(.dialog-close)');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return createPortal(
    <div
      class="dialog-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div class="dialog" role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <div class="dialog-head">
          <h2>{title}</h2>
          <button type="button" class="icon-button dialog-close" aria-label="Schließen" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
