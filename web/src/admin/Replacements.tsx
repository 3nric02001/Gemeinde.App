import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { plural } from '../format';
import { ErrorNote, Loading } from '../pages/common';
import { adminRequest } from './api';

export interface Replacement {
  id: number;
  search: string;
  replacement: string;
  wholeWord: boolean;
}

interface Change {
  id: number;
  before: string;
  after: string;
}

interface Preview {
  tracks: { total: number; items: Change[] };
  albums: { total: number; items: Change[] };
}

const EMPTY = { search: '', replacement: '', wholeWord: true };

/** Verwaltung → Schreibweisen: Tippfehler in Titeln und Albumnamen ersetzen, z. B. „Tema“ durch „Thema“ */
export function ReplacementsPanel() {
  const [items, setItems] = useState<Replacement[] | undefined>();
  const [draft, setDraft] = useState<Omit<Replacement, 'id'> & { id?: number }>(EMPTY);
  const [preview, setPreview] = useState<Preview | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = () =>
    adminRequest<{ items: Replacement[] }>('GET', '/api/admin/replacements')
      .then((body) => setItems(body.items))
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  if (!items) return error ? <ErrorNote message={error} /> : <Loading />;

  const change = (patch: Partial<typeof draft>) => {
    setDraft({ ...draft, ...patch });
    setPreview(undefined);
    setMessage(undefined);
  };

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      if (done) setMessage(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showPreview = () =>
    run(async () => setPreview(await adminRequest<Preview>('POST', '/api/admin/replacements/preview', draft)));

  const save = () =>
    run(async () => {
      const { id, ...body } = draft;
      if (id) await adminRequest('PUT', `/api/admin/replacements/${id}`, body);
      else await adminRequest('POST', '/api/admin/replacements', body);
      setDraft(EMPTY);
      setPreview(undefined);
      await load();
    }, 'Gespeichert. Titel und Alben sind angepasst.');

  const remove = (item: Replacement) =>
    run(async () => {
      await adminRequest('DELETE', `/api/admin/replacements/${item.id}`);
      if (draft.id === item.id) setDraft(EMPTY);
      await load();
    }, `„${item.search}“ wird nicht mehr ersetzt.`);

  return (
    <>
      <h1 class="page-title">Schreibweisen</h1>
      <p class="admin-hint">
        Tippfehler, die in vielen Titeln stehen, lassen sich hier einmal für alle korrigieren, z. B. „Tema“ durch „Thema“. Das gilt
        für Titel und Albumnamen in der App und in der Suche; die Dateien in der Nextcloud bleiben, wie sie sind. Von Hand
        korrigierte Titel und Alben behalten ihren Namen.
      </p>

      {items.length > 0 && (
        <ul class="admin-list" aria-label="Ersetzungen">
          {items.map((item) => (
            <li key={item.id} class="admin-row admin-row-plain">
              <span class="track-main">
                <span class="track-title">
                  {item.search} → {item.replacement || <em>entfernen</em>}
                </span>
                <span class="track-sub">{item.wholeWord ? 'Nur ganze Wörter' : 'Auch innerhalb von Wörtern'}</span>
              </span>
              <span class="admin-track-actions">
                <button
                  type="button"
                  class="icon-button"
                  aria-label={`„${item.search}“ bearbeiten`}
                  onClick={() => change({ ...item })}
                >
                  <Icon name="edit" size={18} />
                </button>
                <button type="button" class="icon-button" aria-label={`„${item.search}“ löschen`} disabled={busy} onClick={() => void remove(item)}>
                  <Icon name="close" size={18} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        class="admin-panel admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2>{draft.id ? 'Ersetzung bearbeiten' : 'Neue Ersetzung'}</h2>
        <div class="admin-inline">
          <label class="field">
            <span>Falsch geschrieben</span>
            <input
              value={draft.search}
              placeholder="z. B. Tema"
              maxLength={100}
              onInput={(e) => change({ search: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>Richtig</span>
            <input
              value={draft.replacement}
              placeholder="z. B. Thema"
              maxLength={100}
              onInput={(e) => change({ replacement: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>
        <label class="admin-check">
          <input type="checkbox" checked={draft.wholeWord} onChange={(e) => change({ wholeWord: (e.target as HTMLInputElement).checked })} />
          Nur ganze Wörter (sonst wird „Tema“ auch in „Tematik“ ersetzt)
        </label>
        <small class="field-hint">
          Groß- und Kleinschreibung spielt beim Suchen keine Rolle; ein großgeschriebener Fund bleibt groß. Leer bei „Richtig“
          entfernt das Wort.
        </small>
        {error && (
          <p class="admin-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p class="admin-hint" role="status">
            {message}
          </p>
        )}
        <div class="actions">
          <button type="button" class="button-secondary" disabled={busy || !draft.search.trim()} onClick={() => void showPreview()}>
            Vorschau
          </button>
          <button type="submit" class="button-primary" disabled={busy || !draft.search.trim()}>
            Speichern und anwenden
          </button>
          {draft.id && (
            <button type="button" class="button-secondary" onClick={() => change(EMPTY)}>
              Abbrechen
            </button>
          )}
        </div>
      </form>

      {preview && <PreviewList preview={preview} />}
    </>
  );
}

function PreviewList({ preview }: { preview: Preview }) {
  const { tracks, albums } = preview;
  if (!tracks.total && !albums.total) {
    return (
      <p class="count" role="status">
        Kein Titel und kein Album würde sich ändern.
      </p>
    );
  }
  const list = (label: string, part: Preview['tracks'], one: string, many: string) =>
    part.total > 0 && (
      <div class="admin-panel">
        <h3>
          {label} <span class="badge badge-muted">{plural(part.total, one, many)}</span>
        </h3>
        <ul class="structure-files">
          {part.items.map((item) => (
            <li key={item.id}>
              <span class="track-sub">{item.before}</span>
              <span aria-hidden="true">→</span>
              <span>{item.after}</span>
            </li>
          ))}
        </ul>
        {part.total > part.items.length && <p class="count">… und {part.total - part.items.length} weitere</p>}
      </div>
    );
  return (
    <section class="shelf structure-preview" aria-label="Vorschau">
      <h2>Vorschau</h2>
      {list('Titel', tracks, 'Titel ändert sich', 'Titel ändern sich')}
      {list('Alben', albums, 'Album ändert sich', 'Alben ändern sich')}
    </section>
  );
}
