import type { Album, Track } from '../api';
import { toggleFavorite, useMe } from '../me';
import { Icon } from './Icon';

/** Herz für Titel oder Alben; gefüllt, wenn es unter "Favoriten" steht. */
export function FavoriteButton({ kind, item, size = 24 }: { kind: 'track' | 'album'; item: Track | Album; size?: number }) {
  const me = useMe();
  const on = (kind === 'track' ? me.trackIds : me.albumIds).has(item.id);
  return (
    <button
      type="button"
      class={`icon-button favorite${on ? ' is-on' : ''}`}
      aria-label={on ? 'Aus den Favoriten entfernen' : 'Zu den Favoriten'}
      aria-pressed={on}
      onClick={(event) => {
        event.stopPropagation();
        void (kind === 'track' ? toggleFavorite('track', item as Track) : toggleFavorite('album', item as Album));
      }}
    >
      <Icon name={on ? 'heart' : 'heartOutline'} size={size} />
    </button>
  );
}
