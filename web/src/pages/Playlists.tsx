import { useEffect, useState } from 'preact/hooks';
import { Dialog } from '../components/Dialog';
import { FavoritesCard } from '../components/FavoritesCard';
import { Icon } from '../components/Icon';
import { PlaylistCard } from '../components/PlaylistCard';
import { useMe } from '../me';
import { createPlaylist, loadPlaylists, playlistHref, usePlaylists } from '../playlists';
import { navigate } from '../router';
import { Empty, Loading } from './common';

/** "Meine Playlists": die eigenen (mit den Favoriten vorne) und die, die andere mit einem teilen */
export function Playlists() {
  const { own, shared, loaded } = usePlaylists();
  const favorites = useMe().favorites?.tracks ?? [];
  const [creating, setCreating] = useState(false);
  useEffect(() => void loadPlaylists(), []);

  return (
    <div class="page">
      <div class="page-head">
        <h1 class="page-title">Meine Playlists</h1>
        <button type="button" class="button-secondary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={18} /> Neue Playlist
        </button>
      </div>
      {!loaded ? (
        <Loading />
      ) : (
        <>
          {own.length === 0 && favorites.length === 0 ? (
            <Empty title="Noch keine eigenen Playlists">
              Lege eine neue an oder wähle bei einem Titel oder Album im Menü „Zur Playlist hinzufügen“.
            </Empty>
          ) : (
            <div class="grid">
              {favorites.length > 0 && <FavoritesCard tracks={favorites} />}
              {own.map((playlist) => (
                <PlaylistCard key={playlist.id} playlist={playlist} />
              ))}
            </div>
          )}
          <section class="shelf">
            <div class="section-head">
              <h2>Geteilt mit mir</h2>
            </div>
            {shared.length ? (
              <div class="grid">
                {shared.map((playlist) => (
                  <PlaylistCard key={playlist.id} playlist={playlist} />
                ))}
              </div>
            ) : (
              <p class="section-note">Wenn jemand eine Playlist mit dir teilt, erscheint sie hier.</p>
            )}
          </section>
        </>
      )}
      {creating && <NewPlaylist onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewPlaylist({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const playlist = await createPlaylist(name);
      onClose();
      navigate(playlistHref(playlist.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title="Neue Playlist" onClose={onClose}>
      <form class="dialog-form" onSubmit={(event) => void submit(event)}>
        <label class="field">
          Name
          <input value={name} maxLength={100} placeholder="z. B. Lieblingslieder" onInput={(event) => setName((event.target as HTMLInputElement).value)} />
        </label>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <div class="dialog-actions">
          <button type="button" class="button-secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" class="button-primary" disabled={busy || !name.trim()}>
            Anlegen
          </button>
        </div>
      </form>
    </Dialog>
  );
}
