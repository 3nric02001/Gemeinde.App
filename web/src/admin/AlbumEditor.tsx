import { useEffect, useState } from 'preact/hooks';
import { query, type Page, type Track } from '../api';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { formatDuration, formatTime, plural } from '../format';
import { useDebounced } from '../hooks';
import { navigate } from '../router';
import { ErrorNote, Loading } from '../pages/common';
import { adminRequest, type AdminAlbum, type AdminAlbumDetail, type AlbumFields } from './api';

interface Props {
  id: number;
  onError: (error: Error) => void;
}

export function AlbumEditor({ id, onError }: Props) {
  const [album, setAlbum] = useState<AdminAlbumDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [picking, setPicking] = useState(false);

  /** Führt eine Änderung aus; der Server antwortet mit dem neuen Stand des Albums. */
  const run = async (action: () => Promise<AdminAlbumDetail | void>) => {
    setBusy(true);
    try {
      const next = await action();
      if (next) setAlbum(next);
      setError(undefined);
    } catch (e) {
      onError(e as Error);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => void run(() => adminRequest<AdminAlbumDetail>('GET', `/api/admin/albums/${id}`)), [id]);

  if (!album) return error ? <ErrorNote message={error} /> : <Loading />;

  const manual = album.kind === 'manual';
  const base = `/api/admin/albums/${id}`;
  const ids = album.tracks.map((t) => t.id);

  const move = (index: number, delta: number) => {
    const order = [...ids];
    const [item] = order.splice(index, 1);
    order.splice(index + delta, 0, item!);
    void run(() => adminRequest('PUT', `${base}/tracks`, { trackIds: order }));
  };
  const toggle = (trackId: number) => {
    const next = new Set(selected);
    if (next.has(trackId)) next.delete(trackId);
    else next.add(trackId);
    setSelected(next);
  };

  return (
    <>
      <a class="more-link admin-back" href="/admin">
        <Icon name="back" size={16} /> Alle Alben
      </a>
      <header class="hero admin-hero">
        <Cover albumId={album.id} hasCover={album.hasCover} title={album.title} class="cover-hero" eager />
        <div class="hero-text">
          <span class="eyebrow">
            {manual ? 'Eigenes Album' : 'Automatisches Album'}
            {album.hidden && ' · ausgeblendet'}
          </span>
          <h1>{album.title}</h1>
          <p class="hero-sub">{album.artist}</p>
          <p class="hero-meta">
            {plural(album.trackCount, 'Titel', 'Titel')}, {formatDuration(album.duration)}
            {!album.hidden && (
              <>
                {' · '}
                <a href={`/album/${album.id}`}>Im Player öffnen</a>
              </>
            )}
          </p>
        </div>
      </header>

      {error && <p class="admin-error" role="alert">{error}</p>}

      <DetailsForm album={album} busy={busy} onSave={(fields) => run(() => adminRequest('PATCH', base, fields))} />

      <section class="shelf">
        <div class="section-head">
          <h2>Titel</h2>
          {selected.size > 0 && (
            <div class="admin-selection">
              <span>{selected.size} ausgewählt</span>
              <button type="button" class="button-secondary" onClick={() => setPicking(true)}>
                Zu eigenem Album hinzufügen
              </button>
              <button type="button" class="more-link" onClick={() => setSelected(new Set())}>
                Auswahl aufheben
              </button>
            </div>
          )}
        </div>
        {album.tracks.length === 0 ? (
          <p class="admin-hint">{manual ? 'Noch keine Titel. Füge unten welche hinzu.' : 'Alle Titel wurden herausgenommen.'}</p>
        ) : (
          <ol class="admin-tracks">
            {album.tracks.map((track, index) => (
              <li key={track.id} class="admin-track">
                <input
                  type="checkbox"
                  checked={selected.has(track.id)}
                  aria-label={`${track.title} auswählen`}
                  onChange={() => toggle(track.id)}
                />
                <span class="track-no">{index + 1}</span>
                <span class="track-main">
                  <span class="track-title">{track.title}</span>
                  <span class="track-sub">
                    {track.artist}
                    {track.album && track.album !== album.title ? ` · ${track.album}` : ''}
                  </span>
                </span>
                <span class="track-time">{formatTime(track.duration)}</span>
                <span class="admin-track-actions">
                  {manual && (
                    <>
                      <button type="button" class="icon-button" aria-label="Nach oben" disabled={busy || index === 0} onClick={() => move(index, -1)}>
                        <Icon name="down" size={18} class="flip" />
                      </button>
                      <button
                        type="button"
                        class="icon-button"
                        aria-label="Nach unten"
                        disabled={busy || index === album.tracks.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <Icon name="down" size={18} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    class="icon-button"
                    aria-label={manual ? `${track.title} entfernen` : `${track.title} aus dem Album nehmen`}
                    title={manual ? 'Entfernen' : 'Aus dem Album nehmen'}
                    disabled={busy}
                    onClick={() => void run(() => adminRequest('DELETE', `${base}/tracks/${track.id}`))}
                  >
                    <Icon name="close" size={18} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {album.excluded.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Herausgenommen</h2>
          </div>
          <p class="admin-hint">Diese Titel gehören laut Tags und Ordner zu diesem Album, werden hier aber nicht angezeigt.</p>
          <ul class="admin-tracks">
            {album.excluded.map((track) => (
              <li key={track.id} class="admin-track admin-track-plain">
                <span class="track-main">
                  <span class="track-title">{track.title}</span>
                  <span class="track-sub">{track.artist}</span>
                </span>
                <span class="track-time">{formatTime(track.duration)}</span>
                <button
                  type="button"
                  class="button-secondary button-small"
                  disabled={busy}
                  onClick={() => void run(() => adminRequest('POST', `${base}/tracks/${track.id}/restore`))}
                >
                  Zurückholen
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {album.missing.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Derzeit nicht in der Nextcloud</h2>
          </div>
          <p class="admin-hint">Sobald die Dateien wieder da sind, erscheinen sie nach dem nächsten Scan automatisch im Album.</p>
          <ul class="admin-paths">
            {album.missing.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </section>
      )}

      {manual && (
        <AddTracks
          albumId={id}
          existing={new Set(ids)}
          busy={busy}
          onAdd={(trackIds, move) => run(() => adminRequest('POST', `${base}/tracks`, { trackIds, move }))}
        />
      )}

      <section class="shelf admin-danger">
        {manual ? (
          <button
            type="button"
            class="button-secondary"
            disabled={busy}
            onClick={() => {
              if (!confirm(`Album „${album.title}“ löschen? Die Titel selbst bleiben erhalten.`)) return;
              void run(async () => {
                await adminRequest('DELETE', base);
                navigate('/admin');
              });
            }}
          >
            Album löschen
          </button>
        ) : (
          <label class="admin-check">
            <input
              type="checkbox"
              checked={album.hidden}
              disabled={busy}
              onChange={(e) => void run(() => adminRequest('PATCH', base, { hidden: (e.target as HTMLInputElement).checked }))}
            />
            Für Hörer ausblenden (z. B. wenn die Titel jetzt in eigenen Alben stehen)
          </label>
        )}
      </section>

      {picking && (
        <AddToAlbum
          source={album}
          trackIds={ids.filter((trackId) => selected.has(trackId))}
          onClose={(done) => {
            setPicking(false);
            if (done) {
              setSelected(new Set());
              void run(() => adminRequest('GET', `/api/admin/albums/${id}`));
            }
          }}
          onError={onError}
        />
      )}
    </>
  );
}

function DetailsForm({ album, busy, onSave }: { album: AdminAlbumDetail; busy: boolean; onSave: (fields: Partial<AlbumFields>) => void }) {
  const initial = () => ({
    title: album.title,
    artist: album.artist,
    year: album.year ? String(album.year) : '',
    genre: album.genre ?? '',
  });
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial()), [album]);

  // Nur geänderte Felder senden: Was nicht angefasst wird, bleibt automatisch.
  const changes: Partial<AlbumFields> = {};
  if (form.title.trim() !== album.title) changes.title = form.title.trim() || null;
  if (form.artist.trim() !== album.artist) changes.artist = form.artist.trim() || null;
  if (form.year.trim() !== (album.year ? String(album.year) : '')) changes.year = form.year.trim() ? Number(form.year) : null;
  if (form.genre.trim() !== (album.genre ?? '')) changes.genre = form.genre.trim() || null;
  const yearValid = !form.year.trim() || /^\d{4}$/.test(form.year.trim());
  const dirty = Object.keys(changes).length > 0;
  const overridden = Object.values(album.overrides).some((value) => value !== null);
  const manual = album.kind === 'manual';

  const field = (name: keyof typeof form, label: string, props: Record<string, unknown> = {}) => (
    <label class="field">
      <span>
        {label}
        {!manual && album.overrides[name] !== null && <em> · angepasst</em>}
      </span>
      <input
        value={form[name]}
        onInput={(e) => setForm({ ...form, [name]: (e.target as HTMLInputElement).value })}
        {...props}
      />
    </label>
  );

  return (
    <form
      class="admin-panel admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && yearValid) onSave(changes);
      }}
    >
      <div class="admin-fields">
        {field('title', 'Titel', { maxLength: 200, required: manual })}
        {field('artist', 'Interpret', { maxLength: 200, placeholder: 'Automatisch aus den Titeln' })}
        {field('year', 'Jahr', { inputMode: 'numeric', maxLength: 4, placeholder: 'Automatisch' })}
        {field('genre', 'Genre', { maxLength: 100, placeholder: 'Automatisch' })}
      </div>
      <div class="actions">
        <button type="submit" class="button-primary" disabled={busy || !dirty || !yearValid}>
          Speichern
        </button>
        {dirty && (
          <button type="button" class="button-secondary" onClick={() => setForm(initial())}>
            Verwerfen
          </button>
        )}
        {!manual && overridden && !dirty && (
          <button
            type="button"
            class="button-secondary"
            disabled={busy}
            onClick={() => onSave({ title: null, artist: null, year: null, genre: null })}
          >
            Automatische Werte wiederherstellen
          </button>
        )}
        {!yearValid && <span class="admin-error">Jahr bitte vierstellig</span>}
      </div>
    </form>
  );
}

function AddTracks({
  albumId,
  existing,
  busy,
  onAdd,
}: {
  albumId: number;
  existing: Set<number>;
  busy: boolean;
  onAdd: (trackIds: number[], move: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [move, setMove] = useState(false);
  const q = useDebounced(text.trim(), 200);
  const [results, setResults] = useState<Track[] | undefined>();
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!q) {
      setResults(undefined);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/tracks${query({ q, limit: 50 })}`, { signal: controller.signal })
      .then((res) => res.json() as Promise<Page<Track>>)
      .then((page) => {
        setResults(page.items);
        setTotal(page.total);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [q, albumId]);

  const addable = (results ?? []).filter((t) => !existing.has(t.id));

  return (
    <section class="shelf admin-panel">
      <div class="section-head">
        <h2>Titel hinzufügen</h2>
      </div>
      <form class="search-box" role="search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={20} />
        <input
          type="search"
          value={text}
          placeholder="Titel, Interpret oder Album suchen"
          aria-label="Titel zum Hinzufügen suchen"
          autocomplete="off"
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
      </form>
      <label class="admin-check">
        <input type="checkbox" checked={move} onChange={(e) => setMove((e.target as HTMLInputElement).checked)} />
        Aus ihrem automatischen Album herausnehmen (verschieben statt zusätzlich eintragen)
      </label>
      {results && (
        <>
          <div class="admin-results-head">
            <span class="count">
              {plural(total, 'Treffer', 'Treffer')}
              {total > results.length && `, die ersten ${results.length} angezeigt`}
            </span>
            {addable.length > 1 && (
              <button type="button" class="button-secondary button-small" disabled={busy} onClick={() => onAdd(addable.map((t) => t.id), move)}>
                Alle {addable.length} hinzufügen
              </button>
            )}
          </div>
          <ul class="admin-tracks">
            {results.map((track) => (
              <li key={track.id} class="admin-track admin-track-plain">
                <span class="track-main">
                  <span class="track-title">{track.title}</span>
                  <span class="track-sub">
                    {track.artist}
                    {track.album ? ` · ${track.album}` : ''}
                  </span>
                </span>
                <span class="track-time">{formatTime(track.duration)}</span>
                {existing.has(track.id) ? (
                  <span class="badge badge-muted">Im Album</span>
                ) : (
                  <button type="button" class="button-secondary button-small" disabled={busy} onClick={() => onAdd([track.id], move)}>
                    Hinzufügen
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Dialog: ausgewählte Titel in ein bestehendes oder neues eigenes Album übernehmen. */
function AddToAlbum({
  source,
  trackIds,
  onClose,
  onError,
}: {
  source: AdminAlbumDetail;
  trackIds: number[];
  onClose: (done: boolean) => void;
  onError: (error: Error) => void;
}) {
  const [targets, setTargets] = useState<AdminAlbum[] | undefined>();
  const [target, setTarget] = useState<number | 'new'>('new');
  const [title, setTitle] = useState('');
  const [move, setMove] = useState(source.kind === 'auto');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminRequest<Page<AdminAlbum>>('GET', '/api/admin/albums?kind=manual&sort=title&limit=500')
      .then((page) => {
        const others = page.items.filter((a) => a.id !== source.id);
        setTargets(others);
        if (others.length) setTarget(others[0]!.id);
      })
      .catch((e: Error) => {
        onError(e);
        setError(e.message);
      });
  }, []);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (target === 'new') await adminRequest('POST', '/api/admin/albums', { title: title.trim(), trackIds, move });
      else await adminRequest('POST', `/api/admin/albums/${target}/tracks`, { trackIds, move });
      onClose(true);
    } catch (e) {
      onError(e as Error);
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="admin-dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose(false)}>
      <form class="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="add-to-album" onSubmit={submit}>
        <h2 id="add-to-album">{plural(trackIds.length, 'Titel', 'Titel')} zu eigenem Album hinzufügen</h2>
        {!targets ? (
          <Loading />
        ) : (
          <label class="field">
            <span>Album</span>
            <select value={String(target)} onChange={(e) => {
              const value = (e.target as HTMLSelectElement).value;
              setTarget(value === 'new' ? 'new' : Number(value));
            }}>
              {targets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
              <option value="new">Neues Album …</option>
            </select>
          </label>
        )}
        {target === 'new' && (
          <label class="field">
            <span>Titel des neuen Albums</span>
            <input value={title} maxLength={200} placeholder="z. B. Predigten" autoFocus onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          </label>
        )}
        <label class="admin-check">
          <input type="checkbox" checked={move} onChange={(e) => setMove((e.target as HTMLInputElement).checked)} />
          {source.kind === 'auto'
            ? `Aus „${source.title}“ herausnehmen (verschieben)`
            : 'Aus ihrem automatischen Album herausnehmen'}
        </label>
        {error && <p class="admin-error" role="alert">{error}</p>}
        <div class="actions">
          <button type="submit" class="button-primary" disabled={busy || !targets || (target === 'new' && !title.trim())}>
            Hinzufügen
          </button>
          <button type="button" class="button-secondary" onClick={() => onClose(false)}>
            Abbrechen
          </button>
        </div>
      </form>
    </div>
  );
}
