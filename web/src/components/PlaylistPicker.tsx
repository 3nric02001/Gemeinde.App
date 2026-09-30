import { useState } from 'preact/hooks';
import type { Track } from '../api';
import { plural } from '../format';
import {
  addToPlaylist,
  closePlaylistDialog,
  createPlaylist,
  usePickerTracks,
  usePlaylists,
  type PlaylistSummary,
} from '../playlists';
import { showToast } from '../share';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { PlaylistCover } from './PlaylistCard';

/** "Zur Playlist hinzufügen": eine eigene Playlist wählen oder gleich eine neue anlegen. Einmal in der App eingehängt. */
export function PlaylistPicker() {
  const tracks = usePickerTracks();
  if (!tracks) return null;
  return <Picker key={tracks.map((t) => t.id).join(',')} trackIds={tracks.map((t) => t.id)} suggestion={albumOf(tracks)} />;
}

/** Ganzes Album: dessen Name als Vorschlag für eine neue Playlist */
function albumOf(tracks: Track[]): string | undefined {
  const first = tracks[0];
  return tracks.length > 1 && first?.albumId && tracks.every((t) => t.albumId === first.albumId) ? (first.album ?? undefined) : undefined;
}

function Picker({ trackIds, suggestion }: { trackIds: number[]; suggestion?: string | null }) {
  const { own, loaded } = usePlaylists();
  const [creating, setCreating] = useState(loaded && own.length === 0);
  const [name, setName] = useState(suggestion ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const count = plural(trackIds.length, 'Titel', 'Titel');

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    try {
      showToast(await action());
      closePlaylistDialog();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const pick = (playlist: PlaylistSummary) =>
    run(async () => {
      const added = await addToPlaylist(playlist.id, trackIds);
      return added ? `${plural(added, 'Titel', 'Titel')} zu „${playlist.title}“ hinzugefügt` : `Schon in „${playlist.title}“`;
    });
  const create = (event: Event) => {
    event.preventDefault();
    if (!name.trim()) return;
    void run(async () => {
      const playlist = await createPlaylist(name, trackIds);
      return `Playlist „${playlist.title}“ angelegt`;
    });
  };

  return (
    <Dialog title="Zur Playlist hinzufügen" onClose={closePlaylistDialog}>
      <p class="dialog-sub">{count}</p>
      {creating ? (
        <form class="dialog-form" onSubmit={create}>
          <label class="field">
            Name der neuen Playlist
            <input
              value={name}
              maxLength={100}
              placeholder="z. B. Lieblingslieder"
              onInput={(event) => setName((event.target as HTMLInputElement).value)}
            />
          </label>
          <div class="dialog-actions">
            {own.length > 0 && (
              <button type="button" class="button-secondary" onClick={() => setCreating(false)}>
                Zurück
              </button>
            )}
            <button type="submit" class="button-primary" disabled={busy || !name.trim()}>
              Anlegen
            </button>
          </div>
        </form>
      ) : (
        <ul class="pick-list">
          <li>
            <button type="button" class="pick-row" onClick={() => setCreating(true)}>
              <span class="cover cover-sm cover-favorites pick-new" aria-hidden="true">
                <Icon name="plus" size={22} />
              </span>
              <span class="pick-text">
                <strong>Neue Playlist</strong>
              </span>
            </button>
          </li>
          {own.map((playlist) => (
            <li key={playlist.id}>
              <button type="button" class="pick-row" disabled={busy} onClick={() => void pick(playlist)}>
                <PlaylistCover playlist={playlist} class="cover-sm" />
                <span class="pick-text">
                  <strong>{playlist.title}</strong>
                  <span>{plural(playlist.trackCount, 'Titel', 'Titel')}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
