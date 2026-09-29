import type { Album, DatedFolder, Facets, Page, Track } from '../api';
import { query, trackCoverUrl } from '../api';
import { useAuth } from '../auth';
import { Shelf } from '../components/AlbumCard';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { InstallHint } from '../components/InstallHint';
import { TrackList } from '../components/TrackList';
import { decadeLabel, formatDuration, formatLongDate, plural, withoutDate } from '../format';
import { useApi } from '../hooks';
import { useMe } from '../me';
import { Empty } from './common';
import { folderHref, playFolder } from './Dates';

/** Genres, die für Gottesdienste stehen; die Genre-Reihe auf Start zeigt Musik */
const SERVICE_GENRE = /gottesdienst|predigt/i;

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
  const latest = useApi<Page<DatedFolder>>('/api/dates?limit=1');
  const personal = useApi<{ resume: Array<Track & { position: number }>; recent: Album[] }>('/api/me/home');
  // Gottesdienste und Musik getrennt, damit dieselben Karten nicht zweimal untereinander stehen
  const services = useApi<Page<Album>>('/api/albums?dated=true&sort=date&limit=13');
  const recent = useApi<Page<Album>>('/api/albums?dated=false&sort=recent&limit=12');
  const facets = useApi<Facets>('/api/facets');
  const topGenre = facets.data?.genres.find((genre) => !SERVICE_GENRE.test(genre.value))?.value;
  const genreAlbums = useApi<Page<Album>>(
    topGenre ? `/api/albums${query({ genre: topGenre, dated: 'false', limit: 12, sort: 'year' })}` : undefined,
  );
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

  return (
    <div class="page">
      <h1 class="page-title">{title}</h1>

      <InstallHint />

      {service && <LatestService folder={service} />}

      {resume.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Weiterhören</h2>
          </div>
          <TrackList tracks={resume} />
        </section>
      )}

      <Shelf title="Zuletzt gehört" albums={personal.data?.recent ?? []} />

      <Shelf
        title="Weitere Gottesdienste"
        href="/datum"
        albums={(services.data?.items ?? []).filter((album) => album.id !== service?.albumId).slice(0, 12)}
      />
      <Shelf title="Neue Musik" href="/alben?sort=recent" albums={recent.data?.items ?? []} />
      {topGenre && (
        <Shelf title={topGenre} href={`/alben${query({ genre: topGenre, sort: 'year' })}`} albums={genreAlbums.data?.items ?? []} />
      )}
      <Shelf title="Deine Favoriten" href="/favoriten" albums={me.favorites?.albums.slice(0, 12) ?? []} />

      {facets.data && facets.data.genres.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Stöbern nach Genre</h2>
          </div>
          <div class="tiles">
            {facets.data.genres.slice(0, 6).map((genre) => (
              <a key={genre.value} class="tile" href={`/alben${query({ genre: genre.value, sort: 'year' })}`}>
                {genre.value}
              </a>
            ))}
          </div>
        </section>
      )}

      {facets.data && facets.data.decades.length > 1 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Nach Jahrzehnt</h2>
          </div>
          <div class="chips-row">
            {facets.data.decades.map((d) => (
              <a key={d.value} class="chip" href={`/alben${query({ decade: d.value, sort: 'year' })}`}>
                {decadeLabel(d.value)}
              </a>
            ))}
          </div>
        </section>
      )}

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
function LatestService({ folder }: { folder: DatedFolder }) {
  const occasion = withoutDate(folder.name);
  return (
    <section class="latest">
      <a class="latest-link" href={folderHref(folder.folder)}>
        <Cover
          src={folder.coverTrackId ? trackCoverUrl({ id: folder.coverTrackId }) : undefined}
          title={folder.name}
          date={folder.date}
          class="latest-cover"
          eager
        />
        <span class="latest-text">
          <span class="eyebrow">Letzter Gottesdienst</span>
          <span class="latest-title">{occasion || formatLongDate(folder.date)}</span>
          <span class="latest-sub">
            {[occasion ? formatLongDate(folder.date) : undefined, folder.speaker, folder.passage].filter(Boolean).join(' · ')}
          </span>
        </span>
      </a>
      <button
        type="button"
        class="button-primary latest-play"
        onClick={() => void playFolder(folder.folder)}
        aria-label={`${occasion || formatLongDate(folder.date)} abspielen`}
      >
        <Icon name="play" size={20} /> Abspielen
      </button>
    </section>
  );
}
