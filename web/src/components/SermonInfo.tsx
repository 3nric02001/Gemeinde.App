import { bibleUrl, splitPassages } from '../bible';
import { Icon } from './Icon';

/** Bibelstellen und Beschreibung eines Gottesdienstes (aus Dateinamen oder der Verwaltung) */
export function SermonInfo({ passage, description }: { passage?: string | null; description?: string | null }) {
  const passages = splitPassages(passage);
  if (!passages.length && !description) return null;
  return (
    <section class="sermon-info">
      {passages.length > 0 && (
        <dl>
          <div>
            <dt>{passages.length > 1 ? 'Bibelstellen' : 'Bibelstelle'}</dt>
            {passages.map((p) => (
              <dd key={p}>
                <PassageLink passage={p} />
              </dd>
            ))}
          </div>
        </dl>
      )}
      {description && <p>{description}</p>}
    </section>
  );
}

/** Bibelstelle als Link zum Text; öffnet in neuem Tab, die Wiedergabe läuft weiter */
export function PassageLink({ passage, class: className, book = false }: { passage: string; class?: string; book?: boolean }) {
  return (
    <a
      class={`passage-link${className ? ` ${className}` : ''}`}
      href={bibleUrl(passage)}
      target="_blank"
      rel="noopener noreferrer"
      title={`${passage} lesen (bibleserver.com)`}
      onClick={(event) => event.stopPropagation()}
    >
      {book && <Icon name="book" size={15} />}
      {passage}
      <Icon name="external" size={14} />
    </a>
  );
}
