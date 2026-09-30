import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { plural } from '../format';
import { ErrorNote, Loading } from '../pages/common';
import { adminRequest } from './api';

interface ArtistEntry {
  name: string;
  trackCount: number;
  target: string | null;
}

interface ArtistState {
  items: ArtistEntry[];
  suggestions: Array<{ names: string[]; target: string }>;
  aliases: Array<{ source: string; target: string }>;
}

const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Verwaltung → Interpreten: Namen, die die automatische Erkennung unterschiedlich schreibt, unter einem
 * Namen zusammenführen oder einen einzelnen umbenennen. Gilt für Titel, Alben, Sprecher und Kategorien.
 */
export function ArtistsPanel() {
  const [state, setState] = useState<ArtistState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  /** Gewählter Zielname je Vorschlag (sonst der mit den meisten Titeln) */
  const [chosen, setChosen] = useState<Record<string, string>>({});

  useEffect(() => {
    adminRequest<ArtistState>('GET', '/api/admin/artists')
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!state) return error ? <ErrorNote message={error} /> : <Loading />;

  const counts = new Map(state.items.map((item) => [item.name, item.trackCount]));
  const run = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      setState(await adminRequest<ArtistState>('POST', path, body));
      setSelected(new Set());
      setTarget('');
      setMessage(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** Zusammenführen; ein einzelner ausgewählter Name wird damit umbenannt */
  const merge = (sources: string[], goal: string, rename = false) =>
    run(
      '/api/admin/artists/merge',
      { sources, target: goal },
      rename ? `„${sources[0]}“ heißt jetzt „${goal}“.` : `Unter „${goal}“ zusammengeführt.`,
    );
  const unmerge = (source: string) => run('/api/admin/artists/unmerge', { source }, `„${source}“ steht wieder für sich.`);

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
    // Vorschlag für den Zielnamen: der Name mit den meisten Titeln
    const best = [...next].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0];
    setTarget(best ?? '');
  };

  const needle = fold(q.trim());
  const visible = state.items.filter((item) => !needle || fold(item.name).includes(needle) || fold(item.target ?? '').includes(needle));
  const byTarget = new Map<string, string[]>();
  for (const { source, target: goal } of state.aliases) byTarget.set(goal, [...(byTarget.get(goal) ?? []), source]);
  const names = [...selected];

  return (
    <>
      <h1 class="page-title">Interpreten</h1>
      <p class="admin-hint">
        Hat die automatische Erkennung denselben Interpreten oder Sprecher unterschiedlich geschrieben, führst du die Namen
        hier zusammen, zum Beispiel „J. Rauschenberger“ unter „Jakob Rauschenberger“. Das gilt für Titel, Alben, Sprecher,
        die Interpretenliste und Kategorien; die Dateien in der Nextcloud bleiben unverändert. Einen einzelnen Namen
        auswählen heißt umbenennen.
      </p>

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

      {state.suggestions.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Vorschläge</h2>
          </div>
          <p class="admin-hint">
            Diese Namen sehen nach derselben Person oder Gruppe aus. Ein Klick auf einen Namen wählt ihn als gemeinsamen Namen.
          </p>
          <ul class="artist-suggestions">
            {state.suggestions.map((suggestion) => {
              const id = suggestion.names.join('|');
              const goal = chosen[id] ?? suggestion.target;
              return (
                <li key={id} class="admin-panel artist-suggestion">
                  <span class="artist-names" role="radiogroup" aria-label="Name, unter dem zusammengeführt wird">
                    {suggestion.names.map((name) => (
                      <button
                        key={name}
                        type="button"
                        role="radio"
                        aria-checked={name === goal}
                        class={`artist-name${name === goal ? ' is-target' : ''}`}
                        title="Als Namen wählen"
                        onClick={() => setChosen({ ...chosen, [id]: name })}
                      >
                        {name} <small>{counts.get(name) ?? 0}</small>
                      </button>
                    ))}
                  </span>
                  <button
                    type="button"
                    class="button-secondary"
                    disabled={busy}
                    onClick={() => void merge(suggestion.names.filter((n) => n !== goal), goal)}
                  >
                    Unter „{goal}“ zusammenführen
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {byTarget.size > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Zusammengeführt</h2>
          </div>
          <ul class="admin-list">
            {[...byTarget].map(([goal, sources]) => (
              <li key={goal} class="admin-row admin-row-plain artist-merged">
                <span class="track-main">
                  <span class="track-title">{goal}</span>
                  <span class="artist-sources">
                    {sources.map((source) => (
                      <span key={source} class="artist-source">
                        {source}
                        <button
                          type="button"
                          class="icon-button"
                          aria-label={`„${source}“ wieder trennen`}
                          title="Wieder trennen"
                          disabled={busy}
                          onClick={() => void unmerge(source)}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </span>
                    ))}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="shelf">
        <div class="section-head">
          <h2>Alle Namen</h2>
          <span class="count">{plural(state.items.length, 'Name', 'Namen')}</span>
        </div>
        <form class="search-box" role="search" onSubmit={(e) => e.preventDefault()}>
          <Icon name="search" size={20} />
          <input
            id="artist-search"
            type="search"
            value={q}
            placeholder="Namen suchen"
            aria-label="Namen suchen"
            autocomplete="off"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
        </form>

        {names.length > 0 && (
          <form
            class="admin-panel artist-action"
            onSubmit={(e) => {
              e.preventDefault();
              void merge(names, target, names.length === 1);
            }}
          >
            <label class="field">
              <span>
                {names.length === 1 ? `„${names[0]}“ umbenennen in` : `${names.length} Namen zusammenführen unter`}
              </span>
              <input
                id="artist-target"
                list="artist-target-options"
                value={target}
                maxLength={200}
                onInput={(e) => setTarget((e.target as HTMLInputElement).value)}
              />
              <datalist id="artist-target-options">
                {names.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            <div class="actions">
              <button
                type="submit"
                class="button-primary"
                disabled={busy || !target.trim() || (names.length === 1 && names[0] === target.trim())}
              >
                {names.length === 1 ? 'Umbenennen' : 'Zusammenführen'}
              </button>
              <button type="button" class="button-secondary" onClick={() => setSelected(new Set())}>
                Auswahl aufheben
              </button>
            </div>
          </form>
        )}

        <ul class="admin-list artist-list">
          {visible.map((item) => (
            <li key={item.name}>
              <label class={`admin-row admin-row-plain artist-row${item.target ? ' is-merged' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.has(item.name)}
                  disabled={Boolean(item.target)}
                  aria-label={`${item.name} auswählen`}
                  onChange={() => toggle(item.name)}
                />
                <span class="track-main">
                  <span class="track-title">{item.name}</span>
                  <span class="track-sub">
                    {plural(item.trackCount, 'Titel', 'Titel')}
                    {item.target && ` · wird als „${item.target}“ geführt`}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {visible.length === 0 && <p class="admin-hint">Kein Name passt zur Suche.</p>}
      </section>
    </>
  );
}
