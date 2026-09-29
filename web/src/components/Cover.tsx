import { useState } from 'preact/hooks';
import { coverUrl } from '../api';
import { hashHue, initials } from '../format';

interface Props {
  albumId: number | null | undefined;
  hasCover?: boolean;
  title: string;
  class?: string;
  eager?: boolean;
}

/** Albumcover; ohne Bild ein ruhiger Platzhalter mit den Anfangsbuchstaben. */
export function Cover({ albumId, hasCover = true, title, class: className = '', eager = false }: Props) {
  const [failed, setFailed] = useState(false);
  const showImage = albumId && hasCover && !failed;
  const hue = hashHue(title);
  return (
    <div class={`cover ${className}`} style={showImage ? undefined : { '--hue': hue }}>
      {showImage ? (
        <img
          src={coverUrl(albumId)}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span class="cover-initials" aria-hidden="true">
          {initials(title) || '♪'}
        </span>
      )}
    </div>
  );
}
