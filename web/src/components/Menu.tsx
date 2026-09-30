import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

/** Auf dem Handy fährt das Menü als Blatt von unten hoch, über Mini-Player und Tab-Leiste. */
const SHEET = '(max-width: 760px)';
const asSheet = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SHEET).matches;

/** Kontextmenü hinter einem "…"-Knopf; `title` steht auf dem Handy über den Einträgen (z. B. der Name des Titels) */
export function Menu({ items, label, title }: { items: MenuItem[]; label: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const target = event.target as Node;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(target) && !sheetRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const list = (
    <div class={sheet ? 'menu-list menu-sheet' : 'menu-list'} role="menu" aria-label={title ?? label} ref={sheetRef}>
      {sheet && title && <div class="menu-sheet-title">{title}</div>}
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={(event) => {
            event.stopPropagation();
            setOpen(false);
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
      {sheet && (
        <button type="button" class="menu-sheet-cancel" onClick={(event) => (event.stopPropagation(), setOpen(false))}>
          Abbrechen
        </button>
      )}
    </div>
  );

  return (
    <div class="menu" ref={ref} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        class="icon-button menu-toggle"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setSheet(asSheet());
          setOpen(!open);
        }}
      >
        <Icon name="more" size={20} />
      </button>
      {open && !sheet && list}
      {open &&
        sheet &&
        createPortal(
          <div class="menu-backdrop" onClick={(event) => event.stopPropagation()}>
            {list}
          </div>,
          document.body,
        )}
    </div>
  );
}
