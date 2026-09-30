import type { Track } from '../api';
import { plural } from '../format';
import { FAVORITES_CONTEXT } from '../me';
import { player } from '../player';
import { Icon } from './Icon';

/** Cover der Favoriten-Playlist: ein Herz statt eines Bildes */
export function FavoritesCover({ class: className = '' }: { class?: string }) {
  return (
    <div class={`cover cover-favorites ${className}`}>
      <Icon name="heart" size={48} />
    </div>
  );
}

/** Karte der Favoriten-Titel als Playlist, z. B. vorne in der Reihe "Deine Favoriten" */
export function FavoritesCard({ tracks }: { tracks: Track[] }) {
  return (
    <div class="card">
      <a class="card-link" href="/favoriten">
        <FavoritesCover />
        <span class="card-title">Favoriten</span>
        <span class="card-sub">Playlist · {plural(tracks.length, 'Titel', 'Titel')}</span>
      </a>
      <button
        class="card-play"
        type="button"
        aria-label="Favoriten abspielen"
        onClick={() => player.playList(tracks, 0, { shuffle: false, from: FAVORITES_CONTEXT })}
      >
        <Icon name="play" size={22} />
      </button>
    </div>
  );
}
