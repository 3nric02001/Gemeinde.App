import { trackCoverUrl } from '../api';
import { plural } from '../format';
import { player } from '../player';
import { fetchPlaylist, playlistContext, playlistHref, type PlaylistSummary } from '../playlists';
import { Cover } from './Cover';
import { Icon } from './Icon';

/** Cover einer eigenen Playlist: das Bild des ersten Titels mit Bild, sonst ein Playlist-Zeichen */
export function PlaylistCover({ playlist, class: className = '' }: { playlist: Pick<PlaylistSummary, 'coverTrackId' | 'title'>; class?: string }) {
  if (playlist.coverTrackId) return <Cover src={trackCoverUrl({ id: playlist.coverTrackId })} title={playlist.title} class={className} />;
  return (
    <div class={`cover cover-favorites ${className}`}>
      <Icon name="playlist" size={48} />
    </div>
  );
}

/** Untertitel: bei geteilten, von wem sie kommt */
export const playlistSubtitle = (playlist: PlaylistSummary) =>
  playlist.mine ? `Playlist · ${plural(playlist.trackCount, 'Titel', 'Titel')}` : `Von ${playlist.owner}`;

export async function playPlaylist(id: number, shuffle = false): Promise<void> {
  const playlist = await fetchPlaylist(id);
  if (!playlist.tracks.length) return;
  const from = playlistContext(playlist);
  if (shuffle) player.playShuffled(playlist.tracks, from);
  else player.playList(playlist.tracks, 0, { shuffle: false, from });
}

export function PlaylistCard({ playlist }: { playlist: PlaylistSummary }) {
  return (
    <div class="card">
      <a class="card-link" href={playlistHref(playlist.id)}>
        <PlaylistCover playlist={playlist} />
        <span class="card-title">{playlist.title}</span>
        <span class="card-sub">
          {!playlist.mine || playlist.shared > 0 ? (
            <Icon name="share" size={12} class="card-shared" />
          ) : null}
          {playlistSubtitle(playlist)}
        </span>
      </a>
      {playlist.trackCount > 0 && (
        <button class="card-play" type="button" aria-label={`${playlist.title} abspielen`} onClick={() => void playPlaylist(playlist.id)}>
          <Icon name="play" size={22} />
        </button>
      )}
    </div>
  );
}
