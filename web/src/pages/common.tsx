import type { ComponentChildren } from 'preact';

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
