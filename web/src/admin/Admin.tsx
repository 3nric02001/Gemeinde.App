import { useEffect, useState } from 'preact/hooks';
import { coverUrl, query, type Page } from '../api';
import { hasRole, useAuth } from '../auth';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { albumTitle, formatCompactDate, plural } from '../format';
import { useDebounced } from '../hooks';
import { match, navigate, type Location } from '../router';
import { Empty, ErrorNote, Loading } from '../pages/common';
import { AdminSectionSelect, ACCESS_SECTIONS } from './Access';
import { adminRequest, type AdminAlbum, type AdminAlbumDetail } from './api';
import { AlbumEditor } from './AlbumEditor';
import { CategoriesAdmin, CategoryEditor } from './Categories';
import { QualityPanel } from './Quality';
import { ReplacementsPanel } from './Replacements';
import { ScanPanel } from './Scan';
import { StructurePanel } from './Structure';

/** Verwaltung unter /admin: Alben für Manager und Admins, Benutzer, Gruppen und Anmeldung nur für Admins. */
export function Admin({ location }: { location: Location }) {
  const { user } = useAuth();
  // 401 behandelt adminRequest selbst (zurück zur Anmeldung); hier bleibt nichts zu tun.
  const onError = () => undefined;

  if (!hasRole(user, 'manager')) {
    return (
      <div class="page">
        <Empty title="Kein Zugriff">
          Die Verwaltung ist nur für Manager und Admins. <a href="/">Zur Startseite</a>
        </Empty>
      </div>
    );
  }

  const album = match('/admin/album/:id', location.path);
  const category = match('/admin/kategorie/:id', location.path);
  const admin = hasRole(user, 'admin');
  const accessSection = ACCESS_SECTIONS.find((s) => s.path === location.path);
  const section = admin ? accessSection : undefined;
  let content;
  // Manager, die einem Link auf eine Admin-Seite folgen, sollen wissen, warum sie nichts sehen.
  if (accessSection && !admin) {
    content = (
      <Empty title="Nur für Admins">
        „{accessSection.label}“ können nur Admins sehen und ändern. <a href="/admin">Zu den Alben</a>
      </Empty>
    );
  } else if (album && /^\d+$/.test(album.id!)) content = <AlbumEditor key={album.id} id={Number(album.id)} onError={onError} />;
  else if (category && (category.id === 'neu' || /^\d+$/.test(category.id!))) {
    const id = category.id === 'neu' ? undefined : Number(category.id);
    content = <CategoryEditor key={category.id} id={id} onError={onError} />;
  } else if (location.path === '/admin/kategorien') content = <CategoriesAdmin onError={onError} />;
  else if (location.path === '/admin/pruefen') content = <QualityPanel />;
  else if (location.path === '/admin/zuordnung') content = <StructurePanel />;
  else if (location.path === '/admin/schreibweisen') content = <ReplacementsPanel />;
  else if (section) content = <section.Component params={location.params} />;
  else content = <AlbumsAdmin params={location.params} onError={onError} />;

  return (
    <div class={`page admin${album || category ? ' admin-editing' : ''}`}>
      <div class="admin-layout">
        <AdminSectionSelect path={location.path} admin={admin} />
        <div class="admin-content">{content}</div>
      </div>
    </div>
  );
}

/** Filter der Albumliste nach dem, was ein Manager sucht, mit ihrer Abfrage an den Server */
const FILTERS = [
  { value: '', label: 'Alle', query: {} },
  { value: 'gottesdienste', label: 'Gottesdienste', query: { dated: 'true' } },
  { value: 'musik', label: 'Musik', query: { dated: 'false' } },
  { value: 'eigene', label: 'Playlists', query: { kind: 'manual' } },
  { value: 'ausgeblendet', label: 'Ausgeblendet', query: { hidden: 'true' } },
  { value: 'ohne-sprecher', label: 'Sprecher fehlt', query: { noSpeaker: 'true' } },
] as const;
const EMPTY: Record<string, string> = {
  gottesdienste: 'Keine Gottesdienste gefunden',
  musik: 'Keine Musik gefunden',
  eigene: 'Noch keine Playlists',
  ausgeblendet: 'Keine ausgeblendeten Alben',
  'ohne-sprecher': 'Alle Gottesdienste haben einen Sprecher',
};
const PAGE = 100;

function AlbumsAdmin({ params, onError }: { params: URLSearchParams; onError: (e: Error) => void }) {
  const [text, setText] = useState(params.get('q') ?? '');
  const filter = FILTERS.find((f) => f.value === params.get('filter')) ?? FILTERS[0];
  const q = useDebounced(text.trim(), 200);
  const [albums, setAlbums] = useState<AdminAlbum[] | undefined>();
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  useEffect(() => navigate(`/admin${query({ q, filter: filter.value || undefined })}`, { replace: true }), [q, filter.value]);

  const load = async (offset: number) => {
    try {
      const page = await adminRequest<Page<AdminAlbum>>(
        'GET',
        `/api/admin/albums${query({ q, ...filter.query, sort: 'date', limit: PAGE, offset })}`,
      );
      setAlbums((prev) => (offset ? [...(prev ?? []), ...page.items] : page.items));
      setTotal(page.total);
      setError(undefined);
    } catch (e) {
      onError(e as Error);
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(0), [q, filter.value]);

  const filterHref = (value: string) => `/admin${query({ q, filter: value || undefined })}`;

  return (
    <>
      <div class="page-head">
        <h1 class="page-title">Alben verwalten</h1>
        <div class="actions">
          <button type="button" class="button-primary" onClick={() => setCreating(true)}>
            Neue Playlist
          </button>
        </div>
      </div>

      <ScanPanel />

      {creating && <NewAlbum onCancel={() => setCreating(false)} onError={onError} />}

      <form class="search-box" role="search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={20} />
        <input
          type="search"
          value={text}
          placeholder="Alben suchen"
          aria-label="Alben suchen"
          autocomplete="off"
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
      </form>
      <nav class="chips-row" aria-label="Alben filtern">
        {FILTERS.map((f) => (
          <a
            key={f.value}
            class={`chip${f.value === filter.value ? ' is-on' : ''}`}
            href={filterHref(f.value)}
            aria-current={f.value === filter.value ? 'true' : undefined}
          >
            {f.label}
          </a>
        ))}
      </nav>

      {error && !albums ? (
        <ErrorNote message={error} />
      ) : !albums ? (
        <Loading />
      ) : albums.length === 0 ? (
        <Empty title={(!q && EMPTY[filter.value]) || 'Keine Alben gefunden'} />
      ) : (
        <>
          <p class="count">{plural(total, 'Album', 'Alben')}</p>
          <ul class="admin-list">
            {albums.map((album) => (
              <li key={album.id}>
                <a href={`/admin/album/${album.id}`} class="admin-row">
                  <Cover src={album.hasCover ? coverUrl(album.id) : undefined} title={album.title} date={album.date} class="cover-sm" />
                  <span class="track-main">
                    {/* Name wie bei den Hörern; bei Gottesdiensten der gespeicherte Name klein dahinter */}
                    <span class="track-title">{albumTitle(album.title, album.date, album.recording)}</span>
                    <span class="track-sub">
                      {[
                        album.date && formatCompactDate(album.date),
                        album.speaker ?? (!album.date && album.year),
                        plural(album.trackCount, 'Titel', 'Titel'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      {album.date && ` · „${album.title}“`}
                    </span>
                  </span>
                  <span class="admin-badges">
                    {album.kind === 'manual' && <span class="badge">Playlist</span>}
                    {album.date && !album.speaker && <span class="badge badge-attention">Sprecher fehlt</span>}
                    {album.hidden && <span class="badge badge-muted">Ausgeblendet</span>}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {albums.length < total && (
            <button type="button" class="button-secondary admin-more" onClick={() => void load(albums.length)}>
              Weitere laden
            </button>
          )}
        </>
      )}

      <details class="admin-help">
        <summary>Wie funktionieren Alben?</summary>
        <p class="admin-hint">
          Automatische Alben entstehen beim Abgleich aus Ordnern und Dateinamen in der Nextcloud (ein Album je Ordner); Gottesdienste erkennt die App am Datum
          im Ordnernamen. Du kannst sie umbenennen, ergänzen, ausblenden oder um einzelne Titel kürzen. Playlists stellst du
          aus beliebigen Titeln zusammen; ein Titel kann in mehreren Playlists stehen. Alle Änderungen bleiben bei neuen Scans
          erhalten.
        </p>
      </details>
    </>
  );
}

function NewAlbum({ onCancel, onError }: { onCancel: () => void; onError: (e: Error) => void }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | undefined>();
  const submit = async (event: Event) => {
    event.preventDefault();
    try {
      const album = await adminRequest<AdminAlbumDetail>('POST', '/api/admin/albums', { title: title.trim() });
      navigate(`/admin/album/${album.id}`);
    } catch (e) {
      onError(e as Error);
      setError((e as Error).message);
    }
  };
  return (
    <form class="admin-panel" onSubmit={submit}>
      <label class="field">
        <span>Name der neuen Playlist</span>
        <input
          value={title}
          placeholder="z. B. Predigten 2024"
          autoFocus
          maxLength={200}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
      </label>
      {error && <p class="admin-error" role="alert">{error}</p>}
      <div class="actions">
        <button type="submit" class="button-primary" disabled={!title.trim()}>
          Anlegen und Titel hinzufügen
        </button>
        <button type="button" class="button-secondary" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}
