import { Fragment } from 'preact';
import { trackCoverUrl, type Track } from '../api';
import { albumLabel, formatTime } from '../format';
import { isFavorite, savedProgress, toggleFavorite, useMe } from '../me';
import { player, usePlayerSelect } from '../player';
import { navigate } from '../router';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { Menu } from './Menu';

interface Props {
  tracks: Track[];
  /** Albumansicht: Tracknummer statt Cover, Album nicht wiederholen */
  variant?: 'album' | 'list';
  /** In der Albumansicht wird der Interpret nur gezeigt, wenn er vom Album-Interpreten abweicht */
  albumArtist?: string;
  /** Wird statt `tracks` in die Warteschlange gelegt, z. B. alle Treffer statt der sichtbaren */
  onPlay?: (index: number) => void;
  /** Laufende Nummer statt Tracknummer, z. B. in selbst zusammengestellten Alben */
  ordinal?: boolean;
}

export function trackMenu(track: Track) {
  const items = [
    { label: 'Als Nächstes spielen', onSelect: () => player.playNext([track]) },
    { label: 'Zur Warteschlange hinzufügen', onSelect: () => player.append([track]) },
    isFavorite('track', track.id)
      ? { label: 'Aus den Favoriten entfernen', onSelect: () => void toggleFavorite('track', track) }
      : { label: 'Zu den Favoriten', onSelect: () => void toggleFavorite('track', track) },
  ];
  if (track.albumId) items.push({ label: 'Zum Album', onSelect: () => navigate(`/album/${track.albumId}`) });
  items.push({ label: 'Zum Interpreten', onSelect: () => navigate(`/interpret/${encodeURIComponent(track.artist)}`) });
  return items;
}

export function TrackList({ tracks, variant = 'list', albumArtist, onPlay, ordinal = false }: Props) {
  const currentId = usePlayerSelect((s) => s.current?.id);
  const playing = usePlayerSelect((s) => s.playing);
  useMe(); // Herzen und Fortschritt aktuell halten
  const multiDisc = variant === 'album' && !ordinal && new Set(tracks.map((t) => t.discNo ?? 1)).size > 1;

  const play = (index: number) => {
    if (tracks[index]?.id === currentId) player.toggle();
    else if (onPlay) onPlay(index);
    else player.playList(tracks, index, { shuffle: false });
  };

  return (
    <ol class={`tracks tracks-${variant}`}>
      {tracks.map((track, index) => {
        const isCurrent = track.id === currentId;
        const disc = track.discNo ?? 1;
        const showDisc = multiDisc && (index === 0 || (tracks[index - 1]!.discNo ?? 1) !== disc);
        const resume = savedProgress(track);
        const album = albumLabel(track.album, track.albumDate);
        // In der Albumansicht Interpret nur, wenn er abweicht; der Sprecher einer Predigt steht immer da.
        const who = track.speaker ?? (variant === 'album' && track.artist === albumArtist ? '' : track.artist);
        return (
          <Fragment key={`${track.id}-${index}`}>
            {showDisc && <li class="disc-head">CD {disc}</li>}
            <li
              class={`track${isCurrent ? ' is-current' : ''}`}
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
              <Menu label={`Weitere Aktionen für ${track.title}`} items={trackMenu(track)} />
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
