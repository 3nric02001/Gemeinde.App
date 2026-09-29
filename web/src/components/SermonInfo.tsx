/** Sprecher, Bibelstelle und Beschreibung eines Gottesdienstes (aus Tags oder der Verwaltung) */
export function SermonInfo({
  speaker,
  passage,
  description,
}: {
  speaker?: string | null;
  passage?: string | null;
  description?: string | null;
}) {
  if (!speaker && !passage && !description) return null;
  return (
    <section class="sermon-info">
      {(speaker || passage) && (
        <dl>
          {speaker && (
            <div>
              <dt>Sprecher</dt>
              <dd>{speaker}</dd>
            </div>
          )}
          {passage && (
            <div>
              <dt>Bibelstelle</dt>
              <dd>{passage}</dd>
            </div>
          )}
        </dl>
      )}
      {description && <p>{description}</p>}
    </section>
  );
}
