import { useState } from 'preact/hooks';
import { hashHue, initials } from '../format';

interface Props {
  /** Bildadresse; ohne Bild erscheint ein Platzhalter */
  src: string | undefined;
  title: string;
  class?: string;
  eager?: boolean;
}

/** Cover eines Albums oder Titels; ohne Bild ein ruhiger Platzhalter mit den Anfangsbuchstaben. */
export function Cover({ src, title, class: className = '', eager = false }: Props) {
  const [failed, setFailed] = useState<string | undefined>();
  const showImage = src && failed !== src;
  return (
    <div class={`cover ${className}`} style={showImage ? undefined : { '--hue': hashHue(title) }}>
      {showImage ? (
        <img
          key={src}
          src={src}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailed(src)}
        />
      ) : (
        <span class="cover-initials" aria-hidden="true">
          {initials(title) || '♪'}
        </span>
      )}
    </div>
  );
}
