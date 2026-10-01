import { Fragment } from 'preact';
import { trackCoverUrl, type Track } from '../api';
import { albumLabel, formatTime } from '../format';
import { isFavorite, savedProgress, toggleFavorite, useMe } from '../me';
import { player, usePlayerSelect, type PlaybackContext } from '../player';
import { download, getOffline, removeDownloads, useOffline } from '../offline';
import { navigate } from '../router';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { Menu, type MenuItem } from './Menu';
import { addToPlaylistDialog } from '../playlists';
import { shareLink } from '../share';
import { useEffect, useRef } from 'preact/hooks';

interface Props {
  tracks: Track[];
  /** Albumansicht: Tracknummer statt Cover, Album nicht wiederholen */
  variant?: 'album' | 'list';
  /** Wird statt `tracks` in die Warteschlange gelegt, z. B. alle Treffer statt der sichtbaren */
  onPlay?: (index: number) => void;
  /** Laufende Nummer statt Tracknummer, z. B. in selbst zusammengestellten Alben */
  ordinal?: boolean;
  /** Playlist, aus der abgespielt wird; "Jetzt läuft" führt dann dorthin zurück */
  from?: PlaybackContext;
  /** Titel aus einem geteilten Link: hervorheben und hinscrollen */
  highlight?: number;
  /** Weitere Menüeinträge je Titel, z. B. "Aus der Playlist entfernen" in einer eigenen Playlist */
  extraMenu?: (track: Track, index: number) => MenuItem[];
  /** Kreuz zum Schließen je Titel, z. B. unter "Weiterhören" */
  onDismiss?: (track: Track) => void;
}

export function trackMenu(track: Track): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Als Nächstes spielen', onSelect: () => player.playNext([track]) },
    { label: 'Zur Warteschlange hinzufügen', onSelect: () => player.append([track]) },
    isFavorite('track', track.id)
      ? { label: 'Aus den Favoriten entfernen', onSelect: () => void toggleFavorite('track', track) }
      : { label: 'Zu den Favoriten', onSelect: () => void toggleFavorite('track', track) },
    { label: 'Zur Playlist hinzufügen …', onSelect: () => addToPlaylistDialog([track]) },
  ];
  const offline = getOffline();
  if (offline.ids.has(track.id)) items.push({ label: 'Offline-Kopie löschen', onSelect: () => void removeDownloads([track.id]) });
  else if (offline.enabled && !offline.progress.has(track.id)) items.push({ label: 'Herunterladen', onSelect: () => download([track]) });
  if (track.albumId) {
    const link = `/album/${track.albumId}?titel=${track.id}`;
    items.push({ label: track.albumDate ? 'Zum Gottesdienst' : 'Zum Album', onSelect: () => navigate(`/album/${track.albumId}`) });
    items.push({ label: 'Teilen', onSelect: () => void shareLink(track.title, link) });
  }
  return items;
}

export function TrackList({ tracks, variant = 'list', onPlay, ordinal = false, from, highlight, extraMenu, onDismiss }: Props) {
  const linked = useRef<HTMLLIElement>(null);
  useEffect(() => linked.current?.scrollIntoView({ block: 'center' }), [highlight]);
  const currentId = usePlayerSelect((s) => s.current?.id);
  const playing = usePlayerSelect((s) => s.playing);
  useMe(); // Herzen und Fortschritt aktuell halten
  const offline = useOffline();
  const multiDisc = variant === 'album' && !ordinal && new Set(tracks.map((t) => t.discNo ?? 1)).size > 1;

  const play = (index: number) => {
    if (tracks[index]?.id === currentId) player.toggle();
    else if (onPlay) onPlay(index);
    else player.playList(tracks, index, from ? { shuffle: false, from } : { shuffle: false });
  };

  return (
    <ol class={`tracks tracks-${variant}`}>
      {tracks.map((track, index) => {
        const isCurrent = track.id === currentId;
        const disc = track.discNo ?? 1;
        const showDisc = multiDisc && (index === 0 || (tracks[index - 1]!.discNo ?? 1) !== disc);
        const resume = savedProgress(track);
        const album = albumLabel(track.album, track.albumDate);
        // Sprecher aus dem Dateinamen ("Predigt - Titel - Name"), sonst nichts
        const who = track.speaker ?? '';
        return (
          <Fragment key={`${track.id}-${index}`}>
            {showDisc && <li class="disc-head">CD {disc}</li>}
            <li
              ref={track.id === highlight ? linked : undefined}
              class={`track${isCurrent ? ' is-current' : ''}${track.id === highlight ? ' is-linked' : ''}`}
              onClick={() => play(index)}
            >
              <span class="track-lead">
                {variant === 'album' ? (
                  <span class="track-no">{ordinal ? index + 1 : (track.trackNo ?? index + 1)}</span>
                ) : (
                  <Cover src={trackCoverUrl(track)} title={track.album ?? track.title} date={track.albumDate} class="cover-sm" />
                )}
                <button
                  type="button"
                  class="track-play"
                  aria-label={isCurrent && playing ? 'Pause' : `${track.title} abspielen`}
                  onClick={(event) => {
                    event.stopPropagation();
                    play(index);
                  }}
                >
                  {isCurrent && playing ? <Equalizer /> : <Icon name="play" size={18} />}
                </button>
              </span>
              <span class="track-main">
                <span class="track-title">{track.title}</span>
                <span class="track-sub">
                  {offline.ids.has(track.id) && <Icon name="downloaded" size={14} class="track-offline" />}
                  {who}
                  {variant === 'list' && album ? `${who ? ' · ' : ''}${album}` : ''}
                </span>
                {resume && (
                  <span class="track-progress" title={`Angehört bis ${formatTime(resume.position)}`}>
                    <i style={{ width: `${Math.min(100, (resume.position / resume.duration) * 100)}%` }} />
                  </span>
                )}
              </span>
              <span class="track-time">
                {resume ? `noch ${formatTime(resume.duration - resume.position)}` : formatTime(track.duration)}
              </span>
              {onDismiss && (
                <button
                  type="button"
                  class="icon-button track-dismiss"
                  aria-label={`${track.title} schließen`}
                  title="Schließen"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDismiss(track);
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              )}
              <Menu label={`Weitere Aktionen für ${track.title}`} title={track.title} items={extraMenu ? [...trackMenu(track), ...extraMenu(track, index)] : trackMenu(track)} />
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

export function Equalizer() {
  return (
    <span class="eq" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
