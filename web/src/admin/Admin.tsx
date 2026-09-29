import { useEffect, useState } from 'preact/hooks';
import { coverUrl, query, type Page } from '../api';
import { hasRole, useAuth } from '../auth';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { albumTitle, formatCompactDate, plural } from '../format';
import { useDebounced } from '../hooks';
import { match, navigate, type Location } from '../router';
import { Empty, ErrorNote, Loading } from '../pages/common';
import { AdminTabs, ACCESS_SECTIONS } from './Access';
import { adminRequest, type AdminAlbum, type AdminAlbumDetail } from './api';
import { AlbumEditor } from './AlbumEditor';
import { CategoriesAdmin, CategoryEditor } from './Categories';
import { ScanPanel } from './Scan';

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
  const section = hasRole(user, 'admin') ? ACCESS_SECTIONS.find((s) => s.path === location.path) : undefined;
  let content;
  if (album && /^\d+$/.test(album.id!)) content = <AlbumEditor key={album.id} id={Number(album.id)} onError={onError} />;
  else if (category && (category.id === 'neu' || /^\d+$/.test(category.id!))) {
    const id = category.id === 'neu' ? undefined : Number(category.id);
    content = <CategoryEditor key={category.id} id={id} onError={onError} />;
  } else if (location.path === '/admin/kategorien') content = <CategoriesAdmin onError={onError} />;
  else if (section) content = <section.Component />;
  else content = <AlbumsAdmin params={location.params} onError={onError} />;

  return (
    <div class="page admin">
      {!album && !category && <AdminTabs path={location.path} admin={hasRole(user, 'admin')} />}
      {content}
    </div>
  );
}

type KindFilter = '' | 'manual' | 'auto';
const PAGE = 100;

function AlbumsAdmin({ params, onError }: { params: URLSearchParams; onError: (e: Error) => void }) {
  const [text, setText] = useState(params.get('q') ?? '');
  const kind = (params.get('art') === 'eigene' ? 'manual' : params.get('art') === 'automatisch' ? 'auto' : '') as KindFilter;
  const q = useDebounced(text.trim(), 200);
  const [albums, setAlbums] = useState<AdminAlbum[] | undefined>();
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  const art = kind === 'manual' ? 'eigene' : kind === 'auto' ? 'automatisch' : undefined;
  useEffect(() => navigate(`/admin${query({ q, art })}`, { replace: true }), [q, art]);

  const load = async (offset: number) => {
    try {
      const page = await adminRequest<Page<AdminAlbum>>(
        'GET',
        `/api/admin/albums${query({ q, kind, sort: 'date', limit: PAGE, offset })}`,
      );
      setAlbums((prev) => (offset ? [...(prev ?? []), ...page.items] : page.items));
      setTotal(page.total);
      setError(undefined);
    } catch (e) {
      onError(e as Error);
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(0), [q, kind]);

  const filterHref = (value: string | undefined) => `/admin${query({ q, art: value })}`;

  return (
    <>
      <div class="page-head">
        <h1 class="page-title">Alben verwalten</h1>
        <div class="actions">
          <button type="button" class="button-primary" onClick={() => setCreating(true)}>
            Neues Album
          </button>
        </div>
      </div>
      <p class="admin-hint">
        Eigene Alben stellst du aus beliebigen Titeln zusammen; ein Titel kann in mehreren Alben stehen. Automatische Alben
        lassen sich umbenennen, ausblenden oder um einzelne Titel kürzen. Alle Änderungen bleiben bei neuen Scans erhalten.
      </p>

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
      <div class="chips-row">
        <a class={`chip${kind === '' ? ' is-on' : ''}`} href={filterHref(undefined)}>
          Alle
        </a>
        <a class={`chip${kind === 'manual' ? ' is-on' : ''}`} href={filterHref('eigene')}>
          Eigene Alben
        </a>
        <a class={`chip${kind === 'auto' ? ' is-on' : ''}`} href={filterHref('automatisch')}>
          Automatische
        </a>
      </div>

      {error && !albums ? (
        <ErrorNote message={error} />
      ) : !albums ? (
        <Loading />
      ) : albums.length === 0 ? (
        <Empty title={kind === 'manual' && !q ? 'Noch keine eigenen Alben' : 'Keine Alben gefunden'} />
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
                    <span class="track-title">{albumTitle(album.title, album.date)}</span>
                    <span class="track-sub">
                      {[album.date && formatCompactDate(album.date), album.artist, plural(album.trackCount, 'Titel', 'Titel')]
                        .filter(Boolean)
                        .join(' · ')}
                      {album.date && ` · „${album.title}“`}
                    </span>
                  </span>
                  <span class="admin-badges">
                    {album.kind === 'manual' && <span class="badge">Eigenes</span>}
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
        <span>Titel des neuen Albums</span>
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
