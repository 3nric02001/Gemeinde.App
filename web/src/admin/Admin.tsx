import { useEffect, useState } from 'preact/hooks';
import { ApiError, coverUrl, query, type Page } from '../api';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { plural } from '../format';
import { useDebounced } from '../hooks';
import { match, navigate, type Location } from '../router';
import { Empty, ErrorNote, Loading } from '../pages/common';
import { adminRequest, getToken, setToken, type AdminAlbum, type AdminAlbumDetail } from './api';
import { AlbumEditor } from './AlbumEditor';
import { CategoriesAdmin, CategoryEditor } from './Categories';

/** Verwaltung unter /admin: vorerst mit ADMIN_TOKEN, später über OIDC-Rollen. */
export function Admin({ location }: { location: Location }) {
  const [token, setTokenState] = useState(getToken);
  const [notice, setNotice] = useState<string | undefined>();

  const logout = (message?: string) => {
    setToken(null);
    setTokenState(null);
    setNotice(message);
  };
  // Abgelaufenes oder falsches Token: zurück zur Anmeldung statt Fehlermeldungen auf jeder Seite.
  const onError = (error: Error) => {
    if (error instanceof ApiError && error.status === 401) logout('Das Admin-Token ist nicht (mehr) gültig.');
  };

  if (!token) {
    return (
      <Login
        notice={notice}
        onLogin={(value) => {
          setToken(value);
          setTokenState(value);
          setNotice(undefined);
        }}
      />
    );
  }

  const album = match('/admin/album/:id', location.path);
  const category = match('/admin/kategorie/:id', location.path);
  const onCategories = location.path === '/admin/kategorien';
  let content;
  if (album && /^\d+$/.test(album.id!)) content = <AlbumEditor key={album.id} id={Number(album.id)} onError={onError} />;
  else if (category && (category.id === 'neu' || /^\d+$/.test(category.id!))) {
    const id = category.id === 'neu' ? undefined : Number(category.id);
    content = <CategoryEditor key={category.id} id={id} onError={onError} />;
  } else if (onCategories) content = <CategoriesAdmin onError={onError} />;
  else content = <AlbumsAdmin params={location.params} onError={onError} onLogout={() => logout()} />;

  const inCategories = onCategories || Boolean(category);
  return (
    <div class="page admin">
      {!album && !category && (
        <nav class="chips-row admin-tabs" aria-label="Verwaltung">
          <a class={`chip${inCategories ? '' : ' is-on'}`} href="/admin" aria-current={inCategories ? undefined : 'page'}>
            Alben
          </a>
          <a class={`chip${inCategories ? ' is-on' : ''}`} href="/admin/kategorien" aria-current={inCategories ? 'page' : undefined}>
            Kategorien
          </a>
        </nav>
      )}
      {content}
    </div>
  );
}

function Login({ notice, onLogin }: { notice?: string; onLogin: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(notice);
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setToken(token);
    try {
      await adminRequest('GET', '/api/admin/session');
      onLogin(token);
    } catch (e) {
      setToken(null);
      setError(e instanceof ApiError && e.status === 401 ? 'Das Token stimmt nicht.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="page admin">
      <form class="admin-login" onSubmit={submit}>
        <h1 class="page-title">Verwaltung</h1>
        <p class="admin-hint">
          Bis zur Anmeldung mit Gemeinde-Konto gilt das <code>ADMIN_TOKEN</code> aus der Server-Konfiguration.
        </p>
        <label class="field">
          <span>Admin-Token</span>
          <input
            type="password"
            value={value}
            autocomplete="current-password"
            autoFocus
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
        </label>
        {error && <p class="admin-error" role="alert">{error}</p>}
        <button type="submit" class="button-primary" disabled={busy || !value.trim()}>
          Anmelden
        </button>
      </form>
    </div>
  );
}

type KindFilter = '' | 'manual' | 'auto';
const PAGE = 100;

function AlbumsAdmin({ params, onError, onLogout }: { params: URLSearchParams; onError: (e: Error) => void; onLogout: () => void }) {
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
        `/api/admin/albums${query({ q, kind, sort: 'title', limit: PAGE, offset })}`,
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
          <button type="button" class="button-secondary" onClick={onLogout}>
            Abmelden
          </button>
        </div>
      </div>
      <p class="admin-hint">
        Eigene Alben stellst du aus beliebigen Titeln zusammen; ein Titel kann in mehreren Alben stehen. Automatische Alben
        lassen sich umbenennen, ausblenden oder um einzelne Titel kürzen. Alle Änderungen bleiben bei neuen Scans erhalten.
      </p>

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
                  <Cover src={album.hasCover ? coverUrl(album.id) : undefined} title={album.title} class="cover-sm" />
                  <span class="track-main">
                    <span class="track-title">{album.title}</span>
                    <span class="track-sub">
                      {album.artist} · {plural(album.trackCount, 'Titel', 'Titel')}
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
