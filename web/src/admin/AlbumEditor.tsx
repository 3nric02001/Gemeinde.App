import { useEffect, useState } from 'preact/hooks';
import { coverUrl, query, type Page, type Track } from '../api';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { formatDuration, formatTime, plural } from '../format';
import { useDebounced } from '../hooks';
import { navigate } from '../router';
import { ErrorNote, Loading } from '../pages/common';
import { adminRequest, type AdminAlbum, type AdminAlbumDetail, type AlbumFields, type TrackOverride } from './api';
import { Rules } from './Rules';

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
  /** Titel, dessen Inhalt, Titel und Name gerade korrigiert werden */
  const [correcting, setCorrecting] = useState<number | undefined>();

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
  const viaRule = new Set(album.ruleTrackIds);

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
        <Cover src={album.hasCover ? coverUrl(album.id) : undefined} title={album.title} class="cover-hero" eager />
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
                  <span class="track-title">
                    {track.title}
                    {album.trackFiles?.[track.id]?.override && <span class="badge badge-muted">korrigiert</span>}
                  </span>
                  <span class="track-sub">
                    {track.artist}
                    {track.album && track.album !== album.title ? ` · ${track.album}` : ''}
                    {album.trackFiles?.[track.id] && <span class="admin-file"> · {album.trackFiles[track.id]!.file}</span>}
                  </span>
                </span>
                <span class="track-time">
                  {viaRule.has(track.id) && <span class="badge badge-muted" title="Über eine Regel im Album">Regel</span>}{' '}
                  {formatTime(track.duration)}
                </span>
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
                    aria-label={`${track.title} korrigieren`}
                    title="Inhalt, Titel und Name korrigieren"
                    aria-expanded={correcting === track.id}
                    disabled={busy}
                    onClick={() => setCorrecting(correcting === track.id ? undefined : track.id)}
                  >
                    <Icon name="more" size={18} />
                  </button>
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
                {correcting === track.id && (
                  <TrackCorrection
                    track={track}
                    override={album.trackFiles?.[track.id]?.override ?? null}
                    busy={busy}
                    onCancel={() => setCorrecting(undefined)}
                    onSave={(fields) =>
                      void run(async () => {
                        const next = await adminRequest<AdminAlbumDetail>('PATCH', `${base}/tracks/${track.id}`, fields);
                        setCorrecting(undefined);
                        return next;
                      })
                    }
                  />
                )}
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

      {album.movedByRule.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Durch Regeln verschoben</h2>
          </div>
          <p class="admin-hint">Diese Titel stehen jetzt in eigenen Alben. Ändern lässt sich das über die Regel dort.</p>
          <ul class="admin-tracks">
            {album.movedByRule.map((track) => (
              <li key={track.id} class="admin-track admin-track-plain">
                <span class="track-main">
                  <span class="track-title">{track.title}</span>
                  <span class="track-sub">{track.artist}</span>
                </span>
                <a class="more-link" href={`/admin/album/${track.albumId}`}>
                  {track.albumTitle}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {manual && (
        <Rules
          album={album}
          busy={busy}
          onSave={(rule, ruleId) =>
            run(() =>
              ruleId === undefined
                ? adminRequest('POST', `${base}/rules`, rule)
                : adminRequest('PUT', `${base}/rules/${ruleId}`, rule),
            )
          }
          onDelete={(ruleId) => run(() => adminRequest('DELETE', `${base}/rules/${ruleId}`))}
        />
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

const TEXT_FIELDS = ['title', 'artist', 'genre', 'speaker', 'passage', 'description'] as const;

function DetailsForm({ album, busy, onSave }: { album: AdminAlbumDetail; busy: boolean; onSave: (fields: Partial<AlbumFields>) => void }) {
  const initial = () => ({
    title: album.title,
    artist: album.artist,
    year: album.year ? String(album.year) : '',
    genre: album.genre ?? '',
    speaker: album.speaker ?? '',
    passage: album.passage ?? '',
    description: album.description ?? '',
  });
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial()), [album]);

  // Nur geänderte Felder senden: Was nicht angefasst wird, bleibt automatisch.
  const changes: Partial<AlbumFields> = {};
  for (const name of TEXT_FIELDS) {
    if (form[name].trim() !== (album[name] ?? '')) changes[name] = form[name].trim() || null;
  }
  if (form.year.trim() !== (album.year ? String(album.year) : '')) changes.year = form.year.trim() ? Number(form.year) : null;
  const yearValid = !form.year.trim() || /^\d{4}$/.test(form.year.trim());
  const dirty = Object.keys(changes).length > 0;
  const overridden = Object.values(album.overrides).some((value) => value !== null);
  const manual = album.kind === 'manual';

  const label = (name: keyof typeof form, text: string) => (
    <span>
      {text}
      {!manual && album.overrides[name] !== null && <em> · angepasst</em>}
    </span>
  );
  const field = (name: keyof typeof form, text: string, props: Record<string, unknown> = {}) => (
    <label class="field">
      {label(name, text)}
      <input
        value={form[name]}
        onInput={(e) => setForm({ ...form, [name]: (e.target as HTMLInputElement).value })}
        {...props}
      />
    </label>
  );

  return (
    <form
      class="admin-panel admin-form admin-form-wide"
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
        {field('speaker', 'Sprecher', { maxLength: 200, placeholder: 'Aus dem Tag „Sprecher“' })}
        {field('passage', 'Bibelstelle', { maxLength: 200, placeholder: 'z. B. Psalm 23' })}
      </div>
      <label class="field">
        {label('description', 'Beschreibung für Hörer')}
        <textarea
          rows={3}
          maxLength={2000}
          value={form.description}
          placeholder="Ein, zwei Sätze zum Gottesdienst oder zur Predigt"
          onInput={(e) => setForm({ ...form, description: (e.target as HTMLTextAreaElement).value })}
        />
      </label>
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
            onClick={() =>
              onSave({ title: null, artist: null, year: null, genre: null, speaker: null, passage: null, description: null })
            }
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

/**
 * Korrektur einer Aufnahme, deren Dateiname nicht zum Regelwerk passt: Inhalt, Titel und Name
 * (bei der Predigt der Sprecher). Leere Felder nehmen wieder, was im Dateinamen steht.
 */
function TrackCorrection({
  track,
  override,
  busy,
  onSave,
  onCancel,
}: {
  track: Track;
  override: TrackOverride | null;
  busy: boolean;
  onSave: (fields: TrackOverride) => void;
  onCancel: () => void;
}) {
  const [content, setContent] = useState(override?.content ?? '');
  const [title, setTitle] = useState(override?.title ?? '');
  const [name, setName] = useState(override?.name ?? '');
  const value = (text: string) => (text.trim() ? text.trim() : null);
  const field = (id: string, label: string, text: string, set: (v: string) => void, placeholder: string) => (
    <label class="field">
      <span>{label}</span>
      <input id={`${id}-${track.id}`} value={text} placeholder={placeholder} maxLength={200} onInput={(e) => set((e.target as HTMLInputElement).value)} />
    </label>
  );
  return (
    <form
      class="admin-panel track-correction"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ content: value(content), title: value(title), name: value(name) });
      }}
    >
      <p class="admin-hint">Leere Felder nehmen, was im Dateinamen steht. Die Korrektur bleibt bei jedem Scan und beim Umbenennen erhalten.</p>
      <div class="structure-grid">
        {field('correct-content', 'Inhalt', content, setContent, track.content ?? 'z. B. Lied')}
        {field('correct-title', 'Titel', title, setTitle, 'aus dem Dateinamen')}
        {field('correct-name', 'Name (Sprecher oder Interpret)', name, setName, track.artist)}
      </div>
      <div class="actions">
        <button type="submit" class="button-primary" disabled={busy}>
          Speichern
        </button>
        {override && (
          <button type="button" class="button-secondary" disabled={busy} onClick={() => onSave({ content: null, title: null, name: null })}>
            Zurücksetzen
          </button>
        )}
        <button type="button" class="button-secondary" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}
