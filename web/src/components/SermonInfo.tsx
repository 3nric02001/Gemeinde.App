/** Bibelstellen und Beschreibung eines Gottesdienstes (aus Tags, Dateinamen oder der Verwaltung) */
export function SermonInfo({ passage, description }: { passage?: string | null; description?: string | null }) {
  // Mehrere Bibelstellen stehen durch ";" getrennt in einem Feld.
  const passages = (passage ?? '').split(';').map((p) => p.trim()).filter(Boolean);
  if (!passages.length && !description) return null;
  return (
    <section class="sermon-info">
      {passages.length > 0 && (
        <dl>
          <div>
            <dt>{passages.length > 1 ? 'Bibelstellen' : 'Bibelstelle'}</dt>
            {passages.map((p) => (
              <dd key={p}>{p}</dd>
            ))}
          </div>
        </dl>
      )}
      {description && <p>{description}</p>}
    </section>
  );
}
