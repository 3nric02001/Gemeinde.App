import type { Album, Facets, Page, Track } from '../api';
import { coverUrl, kindLabel, query } from '../api';
import { useAuth } from '../auth';
import { AlbumCard, playAlbum, Shelf } from '../components/AlbumCard';
import { Cover } from '../components/Cover';
import { FavoritesCard } from '../components/FavoritesCard';
import { PlaylistCard } from '../components/PlaylistCard';
import { Icon } from '../components/Icon';
import { InstallHint } from '../components/InstallHint';
import { TrackList } from '../components/TrackList';
import { formatDuration, formatLongDate, formatTime, plural, withoutDate } from '../format';
import { useApi } from '../hooks';
import { useMe } from '../me';
import { usePlaylists, type PlaylistSummary } from '../playlists';
import { LiveTile } from './Live';
import { useLive } from '../live';
import { Empty } from './common';
import type { DatedAlbum } from './Dates';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 11) return 'Guten Morgen';
  if (hour < 18) return 'Guten Tag';
  return 'Guten Abend';
}

/** Vorname für die Begrüßung; der lokale Admin heißt einfach "Administrator" und wird nicht angesprochen. */
function firstName(name: string | undefined, kind: string | undefined): string | undefined {
  if (!name || kind === 'local') return undefined;
  return name.trim().split(/\s+/)[0];
}

export function Home() {
  const { user } = useAuth();
  const me = useMe();
  const latest = useApi<Page<DatedAlbum>>('/api/dates?limit=1');
  const personal = useApi<{
    resume: Array<Track & { position: number }>;
    recent: Array<Album & { playedAt?: number }>;
    recentPlaylists?: Array<PlaylistSummary & { playedAt?: number }>;
  }>('/api/me/home');
  const facets = useApi<Facets>('/api/facets');
  const live = useLive();
  const playlists = usePlaylists();
  // Eigene und geteilte Playlists, zuletzt geänderte zuerst
  const myPlaylists = [...playlists.own, ...playlists.shared].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  const recordings = [...(facets.data?.recordings ?? [])].sort((a, b) => (b.latest ?? '').localeCompare(a.latest ?? ''));
  const name = firstName(user?.name, user?.kind);
  const title = name ? `${greeting()}, ${name}` : greeting();

  if (facets.data && facets.data.totals.albums === 0) {
    return (
      <div class="page">
        <h1 class="page-title">{title}</h1>
        <Empty title="Noch keine Musik da">
          Die Bibliothek wird aus der Nextcloud gelesen. Sobald der erste Scan durch ist, erscheinen hier die Alben.
        </Empty>
      </div>
    );
  }

  const service = latest.data?.items[0];
  // Nur Titel, die noch nicht fertig gehört sind (die Liste vom Server kann ein paar Sekunden alt sein)
  const resume = (personal.data?.resume ?? []).filter((track) => me.progress.has(track.id));
  // Ist der aktuelle Gottesdienst angefangen, zeigt ihn die große Karte zum Weiterhören; darunter nicht noch einmal
  const serviceResume = service ? resume.find((track) => track.albumId === service.id) : undefined;
  const otherResume = resume.filter((track) => track !== serviceResume);
  // Alben und Playlists (eigene, geteilte, die der Verwaltung) gemischt, zuletzt gehörte zuerst
  const recent = [
    ...(personal.data?.recent ?? []).filter((album) => album.id !== service?.id).map((album) => ({ at: album.playedAt ?? 0, album })),
    ...(personal.data?.recentPlaylists ?? []).map((playlist) => ({ at: playlist.playedAt ?? 0, playlist })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div class="page">
      <h1 class="page-title">{title}</h1>

      <InstallHint />

      {/* Sendet der Livestream gerade, steht er ganz oben */}
      {live && <LiveTile live />}

      {service && <LatestService album={service} resume={serviceResume} />}

      {!live && <LiveTile live={live} />}

      {otherResume.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Weiterhören</h2>
          </div>
          <TrackList tracks={otherResume} />
        </section>
      )}

      <Shelf
        title="Zuletzt gehört"
        albums={[]}
        lead={
          recent.length
            ? recent.map((item) =>
                'album' in item ? (
                  <AlbumCard key={`a${item.album.id}`} album={item.album} />
                ) : (
                  <PlaylistCard key={`p${item.playlist.id}`} playlist={item.playlist} />
                ),
              )
            : undefined
        }
      />

      {/* Je Art aus dem Regelwerk eine Reihe (Gottesdienste, Bibelstunden …), die mit dem jüngsten Eintrag zuerst */}
      {recordings.map((kind) => (
        <RecordingShelf
          key={kind.name}
          name={kind.name}
          title={recordings.length === 1 ? `Weitere ${kind.plural}` : kind.plural}
          skip={service?.id}
        />
      ))}
      {/* Die Titel mit Herz als Playlist vorne, dahinter die Alben mit Herz */}
      <Shelf
        title="Deine Favoriten"
        href="/favoriten"
        albums={me.favorites?.albums.slice(0, 12) ?? []}
        lead={me.favorites?.tracks.length ? <FavoritesCard tracks={me.favorites.tracks} /> : undefined}
      />
      <Shelf
        title="Deine Playlists"
        href="/playlists"
        albums={[]}
        lead={myPlaylists.length ? myPlaylists.map((playlist) => <PlaylistCard key={playlist.id} playlist={playlist} />) : undefined}
      />

      {facets.data && (
        <p class="stats">
          {plural(facets.data.totals.albums, 'Album', 'Alben')} · {plural(facets.data.totals.tracks, 'Titel', 'Titel')} ·{' '}
          {formatDuration(facets.data.totals.duration)}
        </p>
      )}
    </div>
  );
}

/** Große Karte ganz oben: der neueste Gottesdienst zum direkten Abspielen */
function LatestService({ album, resume }: { album: DatedAlbum; resume?: Track & { position: number } }) {
  // Ohne Anlass steht das Datum groß; die Art steht schon darüber
  const occasion = withoutDate(album.title);
  return (
    <section class="latest">
      <a class="latest-link" href={`/album/${album.id}`}>
        <Cover
          src={album.hasCover ? coverUrl(album.id) : undefined}
          title={album.title}
          date={album.date}
          class="latest-cover"
          eager
        />
        <span class="latest-text">
          <span class="eyebrow">Aktuell · {kindLabel(album)}</span>
          <span class="latest-title">{occasion || formatLongDate(album.date)}</span>
          <span class="latest-sub">
            {[occasion ? formatLongDate(album.date) : undefined, album.passage].filter(Boolean).join(' · ')}
          </span>
          {resume && resume.duration ? (
            <span class="latest-resume">
              <span class="track-progress" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (resume.position / resume.duration) * 100)}%` }} />
              </span>
              {resume.title} · noch {formatTime(resume.duration - resume.position)}
            </span>
          ) : null}
        </span>
      </a>
      <button
        type="button"
        class="button-primary latest-play"
        onClick={() => void playAlbum(album.id, resume ? { trackId: resume.id } : {})}
        aria-label={`${occasion || formatLongDate(album.date)} ${resume ? 'weiterhören' : 'abspielen'}`}
      >
        <Icon name="play" size={20} /> {resume ? 'Weiterhören' : 'Abspielen'}
      </button>
    </section>
  );
}

/** Reihe mit den neuesten Aufnahmen einer Art */
function RecordingShelf({ name, title, skip }: { name: string; title: string; skip: number | undefined }) {
  const albums = useApi<Page<Album>>(`/api/albums${query({ dated: 'true', recording: name, sort: 'date', limit: 13 })}`);
  return (
    <Shelf
      title={title}
      href={`/datum${query({ art: name })}`}
      albums={(albums.data?.items ?? []).filter((album) => album.id !== skip).slice(0, 12)}
    />
  );
}
