import { useEffect, useState } from 'preact/hooks';
import { DownloadButton } from '../components/DownloadButton';
import { Icon } from '../components/Icon';
import { Menu, type MenuItem } from '../components/Menu';
import { PlaylistCover } from '../components/PlaylistCard';
import { ShareDialog } from '../components/ShareDialog';
import { TrackList } from '../components/TrackList';
import { formatDuration, plural } from '../format';
import { player } from '../player';
import {
  fetchPlaylist,
  playlistContext,
  removePlaylist,
  renamePlaylist,
  setPlaylistTracks,
  type Person,
  type PlaylistDetail,
} from '../playlists';
import { navigate } from '../router';
import { showToast } from '../share';
import { BackButton, Empty, ErrorNote, Loading } from './common';

/** Mit wem geteilt, kurz: "Ben", "Ben und Carla", "Ben, Carla und 2 weiteren" */
export function sharedLine(people: Person[]): string {
  const names = people.map((p) => p.name);
  if (names.length <= 2) return names.join(' und ');
  if (names.length === 3) return `${names[0]}, ${names[1]} und ${names[2]}`;
  return `${names[0]}, ${names[1]} und ${names.length - 2} weiteren`;
}

/**
 * Eigene Playlist eines Hörers: wer sie angelegt hat, ändert und teilt sie; wem sie geteilt wurde, hört sie an
 * und kann sie aus seiner Liste entfernen.
 */
export function UserPlaylist({ id }: { id: number }) {
  const [playlist, setPlaylist] = useState<PlaylistDetail>();
  const [error, setError] = useState<string>();
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    fetchPlaylist(id)
      .then(setPlaylist)
      .catch((err: Error) => setError(err.message));
  }, [id]);

  if (error) return <ErrorNote message={error} />;
  if (!playlist) return <Loading />;

  const { tracks, mine } = playlist;
  const from = playlistContext(playlist);
  const duration = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);

  /** Titelliste ändern: sofort anzeigen, bei einem Fehler neu laden */
  const saveTracks = async (next: PlaylistDetail['tracks']) => {
    setPlaylist({ ...playlist, tracks: next, trackCount: next.length });
    try {
      await setPlaylistTracks(playlist.id, next.map((t) => t.id));
    } catch (err) {
      showToast((err as Error).message);
      setPlaylist(await fetchPlaylist(id).catch(() => playlist));
    }
  };
  const move = (index: number, by: number) => {
    const next = [...tracks];
    const [track] = next.splice(index, 1);
    next.splice(index + by, 0, track!);
    void saveTracks(next);
  };
  const extraMenu = mine
    ? (_track: unknown, index: number): MenuItem[] => [
        ...(index > 0 ? [{ label: 'Nach oben', onSelect: () => move(index, -1) }] : []),
        ...(index < tracks.length - 1 ? [{ label: 'Nach unten', onSelect: () => move(index, 1) }] : []),
        { label: 'Aus der Playlist entfernen', onSelect: () => void saveTracks(tracks.filter((_, i) => i !== index)) },
      ]
    : undefined;

  const rename = async () => {
    const title = window.prompt('Neuer Name der Playlist', playlist.title)?.trim();
    if (!title || title === playlist.title) return;
    try {
      await renamePlaylist(playlist.id, title);
      setPlaylist({ ...playlist, title: title.replace(/\s+/g, ' ') });
    } catch (err) {
      showToast((err as Error).message);
    }
  };
  const remove = async () => {
    const question = mine
      ? `Playlist „${playlist.title}“ löschen?${playlist.sharedWith.length ? ' Sie verschwindet auch bei allen, mit denen du sie geteilt hast.' : ''}`
      : `„${playlist.title}“ aus deiner Liste entfernen? ${playlist.owner} behält die Playlist.`;
    if (!window.confirm(question)) return;
    try {
      await removePlaylist(playlist.id);
      navigate('/playlists', { replace: true });
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  const menu: MenuItem[] = [
    ...(tracks.length
      ? [
          { label: 'Als Nächstes spielen', onSelect: () => player.playNext(tracks, from) },
          { label: 'Zur Warteschlange hinzufügen', onSelect: () => player.append(tracks, from) },
        ]
      : []),
    ...(mine
      ? [
          { label: 'Teilen …', onSelect: () => setSharing(true) },
          { label: 'Umbenennen', onSelect: () => void rename() },
          { label: 'Playlist löschen', onSelect: () => void remove() },
        ]
      : [{ label: 'Aus meiner Liste entfernen', onSelect: () => void remove() }]),
  ];

  return (
    <div class="page">
      <BackButton fallback="/playlists" />
      <header class="hero">
        <PlaylistCover playlist={playlist} class="cover-hero" />
        <div class="hero-text">
          <span class="eyebrow">{mine ? 'Deine Playlist' : 'Geteilte Playlist'}</span>
          <h1>{playlist.title}</h1>
          <p class="hero-sub">
            {mine
              ? playlist.sharedWith.length
                ? `Geteilt mit ${sharedLine(playlist.sharedWith)}`
                : 'Nur für dich'
              : `Von ${playlist.owner}`}
          </p>
          <p class="hero-meta">
            {plural(tracks.length, 'Titel', 'Titel')}
            {duration > 0 && `, ${formatDuration(duration)}`}
          </p>
        </div>
      </header>
      <div class="actions">
        {tracks.length > 0 && (
          <>
            <button type="button" class="button-primary" onClick={() => player.playList(tracks, 0, { shuffle: false, from })}>
              <Icon name="play" size={20} /> Abspielen
            </button>
            <button type="button" class="button-secondary" aria-label="Zufällig abspielen" onClick={() => player.playShuffled(tracks, from)}>
              <Icon name="shuffle" size={18} /> <span class="button-label">Zufällig</span>
            </button>
          </>
        )}
        {mine && (
          <button type="button" class="button-secondary" aria-label="Teilen" onClick={() => setSharing(true)}>
            <Icon name="share" size={18} /> <span class="button-label">Teilen</span>
          </button>
        )}
        <DownloadButton tracks={tracks} />
        <Menu label={`Weitere Aktionen für ${playlist.title}`} title={playlist.title} items={menu} />
      </div>
      {tracks.length ? (
        <TrackList tracks={tracks} from={from} extraMenu={extraMenu} />
      ) : (
        <Empty title="Noch keine Titel">
          {mine
            ? 'Wähle bei einem Titel oder Album im Menü „Zur Playlist hinzufügen“.'
            : 'Sobald Titel dazukommen, erscheinen sie hier.'}
        </Empty>
      )}
      {sharing && (
        <ShareDialog
          playlist={playlist}
          onClose={() => setSharing(false)}
          onSaved={(sharedWith) => setPlaylist({ ...playlist, sharedWith, shared: sharedWith.length })}
        />
      )}
    </div>
  );
}
