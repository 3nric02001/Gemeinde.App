import type { ComponentChildren } from 'preact';
import { Icon } from '../components/Icon';
import { goBack } from '../router';

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading() {
  return <div class="loading" role="status" aria-label="Lädt" />;
}

export function ErrorNote({ message }: { message: string }) {
  return <Empty title="Das hat nicht geklappt">{message}</Empty>;
}

/** Runder Zurück-Pfeil oben links, nur auf dem Handy: als installierte App gibt es dort keinen Zurück-Knopf des Browsers. */
export function BackButton({ fallback }: { fallback: string }) {
  return (
    <button type="button" class="back-button" aria-label="Zurück" onClick={() => goBack(fallback)}>
      <Icon name="back" size={22} />
    </button>
  );
}
