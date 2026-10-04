import { useState } from 'preact/hooks';
import { hashHue, initials } from '../format';
import { Icon } from './Icon';

interface Props {
  /** Bildadresse; ohne Bild erscheint ein Platzhalter */
  src: string | undefined;
  title: string;
  /** Datum (JJJJ-MM-TT) eines Gottesdienstes: ohne Bild ein Kalenderblatt statt der Anfangsbuchstaben */
  date?: string | null;
  class?: string;
  eager?: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Cover eines Albums oder Titels; ohne Bild ein ruhiger Platzhalter mit den Anfangsbuchstaben oder dem Datum. */
export function Cover({ src, title, date, class: className = '', eager = false }: Props) {
  const [failed, setFailed] = useState<string | undefined>();
  const showImage = src && failed !== src;
  return (
    <div
      class={`cover ${className}${!showImage && date ? ' cover-date' : ''}`}
      style={showImage || date ? undefined : { '--hue': hashHue(title) }}
    >
      {showImage ? (
        <img
          key={src}
          src={src}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailed(src)}
        />
      ) : date ? (
        <span class="cover-cal" aria-hidden="true">
          <small>{MONTHS[Number(date.slice(5, 7)) - 1]}</small>
          <b>{Number(date.slice(8, 10))}</b>
        </span>
      ) : (
        <span class="cover-initials" aria-hidden="true">
          {initials(title) || '♪'}
        </span>
      )}
    </div>
  );
}

/** Platzhalter für den Livestream: das Live-Symbol statt Anfangsbuchstaben */
export function LiveCover({ class: className = '' }: { class?: string }) {
  return (
    <div class={`cover cover-live ${className}`}>
      <Icon name="live" />
    </div>
  );
}
