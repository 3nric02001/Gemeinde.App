import { useEffect, useState } from 'preact/hooks';
import { categoryUrl, query, type CategoryValue } from '../api';
import { Icon } from '../components/Icon';
import { plural } from '../format';
import { CATEGORIES_CHANGED, useDebounced } from '../hooks';
import { Empty, ErrorNote, Loading } from '../pages/common';
import { navigate } from '../router';
import { adminRequest, splitValues, tagLabel, type AdminCategory, type TagField } from './api';

const changed = () => window.dispatchEvent(new Event(CATEGORIES_CHANGED));

/** Liste aller Kategorien mit Reihenfolge */
export function CategoriesAdmin({ onError }: { onError: (e: Error) => void }) {
  const [items, setItems] = useState<AdminCategory[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    adminRequest<{ items: AdminCategory[] }>('GET', '/api/admin/categories')
      .then((data) => setItems(data.items))
      .catch((e: Error) => {
        onError(e);
        setError(e.message);
      });
  }, []);

  const move = async (index: number, delta: number) => {
    if (!items) return;
    const ids = items.map((c) => c.id);
    [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
    try {
      const data = await adminRequest<{ items: AdminCategory[] }>('PUT', '/api/admin/categories/order', { ids });
      setItems(data.items);
      changed();
    } catch (e) {
      onError(e as Error);
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div class="page-head">
        <h1 class="page-title">Kategorien</h1>
        <div class="actions">
          <a class="button-primary" href="/admin/kategorie/neu">
            Neue Kategorie
          </a>
        </div>
      </div>
      <p class="admin-hint">
        Eine Kategorie sammelt Werte aus einem oder mehreren Tag-Feldern der Musikdateien, z. B. „Interpreten“ aus Interpret und
        Album-Interpret. Werte lassen sich unter einem eigenen Namen zusammenfassen, etwa „Musik“ aus den Genres Musik und Lied.
      </p>
      {error && <ErrorNote message={error} />}
      {!items ? (
        !error && <Loading />
      ) : items.length === 0 ? (
        <Empty title="Noch keine Kategorien" />
      ) : (
        <ul class="admin-list">
          {items.map((category, index) => (
            <li key={category.id} class="admin-category">
              <a href={`/admin/kategorie/${category.id}`} class="admin-row admin-row-plain">
                <span class="track-main">
                  <span class="track-title">{category.name}</span>
                  <span class="track-sub">
                    {category.fields.map(tagLabel).join(', ')}
                    {category.groups.length > 0 && ` · ${plural(category.groups.length, 'Zusammenfassung', 'Zusammenfassungen')}`}
                  </span>
                </span>
                <span class="admin-badges">{!category.inNav && <span class="badge badge-muted">Nicht im Menü</span>}</span>
              </a>
              <span class="admin-track-actions">
                <button type="button" class="icon-button" aria-label={`${category.name} nach oben`} disabled={index === 0} onClick={() => void move(index, -1)}>
                  <Icon name="down" size={18} class="flip" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label={`${category.name} nach unten`}
                  disabled={index === items.length - 1}
                  onClick={() => void move(index, 1)}
                >
                  <Icon name="down" size={18} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface Draft {
  name: string;
  fields: string[];
  /** Werte als Text "Musik, Lied", damit man frei tippen kann */
  groups: Array<{ label: string; values: string }>;
  inNav: boolean;
  groupedOnly: boolean;
}

const toDraft = (c: AdminCategory): Draft => ({
  name: c.name,
  fields: c.fields,
  groups: c.groups.map((g) => ({ label: g.label, values: g.values.join(', ') })),
  inNav: c.inNav,
  groupedOnly: c.groupedOnly,
});

const toBody = (draft: Draft) => ({
  name: draft.name.trim(),
  fields: draft.fields,
  groups: draft.groups
    .map((g) => ({ label: g.label.trim(), values: splitValues(g.values) }))
    .filter((g) => g.label || g.values.length),
  inNav: draft.inNav,
  groupedOnly: draft.groupedOnly,
});

/** Kategorie anlegen oder bearbeiten: Name, Tag-Felder, zusammengefasste Werte */
export function CategoryEditor({ id, onError }: { id: number | undefined; onError: (e: Error) => void }) {
  const [draft, setDraft] = useState<Draft | undefined>(
    id === undefined ? { name: '', fields: [], groups: [], inNav: true, groupedOnly: false } : undefined,
  );
  const [saved, setSaved] = useState<AdminCategory | undefined>();
  const [fields, setFields] = useState<TagField[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  /** Tag-Feld, dessen Inhalt gerade angezeigt wird */
  const [inspected, setInspected] = useState<string | undefined>();

  const fail = (e: Error) => {
    onError(e);
    setError(e.message);
  };

  useEffect(() => {
    adminRequest<{ items: TagField[] }>('GET', '/api/admin/tag-fields')
      .then((data) => setFields(data.items))
      .catch(fail);
    if (id !== undefined) {
      adminRequest<{ items: AdminCategory[] }>('GET', '/api/admin/categories')
        .then((data) => {
          const found = data.items.find((c) => c.id === id);
          if (!found) return setError('Kategorie nicht gefunden');
          setSaved(found);
          setDraft(toDraft(found));
        })
        .catch(fail);
    }
  }, [id]);

  if (!draft) return error ? <ErrorNote message={error} /> : <Loading />;
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setGroup = (index: number, patch: Partial<Draft['groups'][number]>) =>
    update({ groups: draft.groups.map((g, i) => (i === index ? { ...g, ...patch } : g)) });
  const toggleField = (tag: string, on: boolean) =>
    update({ fields: on ? [...draft.fields, tag] : draft.fields.filter((f) => f !== tag) });

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (id === undefined) await adminRequest('POST', '/api/admin/categories', toBody(draft));
      else await adminRequest('PATCH', `/api/admin/categories/${id}`, toBody(draft));
      changed();
      navigate('/admin/kategorien');
    } catch (e) {
      fail(e as Error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (id === undefined || !confirm(`Kategorie „${saved?.name}“ löschen? Die Musik selbst bleibt unverändert.`)) return;
    try {
      await adminRequest('DELETE', `/api/admin/categories/${id}`);
      changed();
      navigate('/admin/kategorien');
    } catch (e) {
      fail(e as Error);
    }
  };

  // Felder, die (noch) in keiner Datei vorkommen, trotzdem anzeigen, damit man sie abwählen kann.
  const known = new Set(fields?.map((f) => f.tag));
  const allFields: TagField[] = [
    ...(fields ?? []),
    ...draft.fields.filter((f) => !known.has(f)).map((tag) => ({ tag, trackCount: 0, valueCount: 0, samples: [] })),
  ];

  return (
    <form class="admin-category-editor" onSubmit={save}>
      <a class="more-link admin-back" href="/admin/kategorien">
        <Icon name="back" size={18} /> Kategorien
      </a>
      <h1 class="page-title">{id === undefined ? 'Neue Kategorie' : saved?.name}</h1>

      <section class="shelf admin-panel">
        <label class="field">
          <span>Name</span>
          <input
            value={draft.name}
            maxLength={60}
            placeholder="z. B. Musik"
            autoFocus={id === undefined}
            onInput={(e) => update({ name: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label class="admin-check">
          <input type="checkbox" checked={draft.inNav} onChange={(e) => update({ inNav: (e.target as HTMLInputElement).checked })} />
          Im Menü und unter Suche anzeigen
        </label>
        {saved && (
          <p class="admin-hint">
            Adresse im Player: <a href={categoryUrl(saved.slug)}>{categoryUrl(saved.slug)}</a>
          </p>
        )}
      </section>

      <section class="shelf admin-panel">
        <h2>Tag-Felder</h2>
        <p class="admin-hint">Aus welchen Feldern der Musikdateien kommen die Werte? Mehrere Felder werden zusammengelegt.</p>
        {!fields ? (
          <Loading />
        ) : (
          <ul class="tag-fields">
            {allFields.map((field) => (
              <li key={field.tag}>
                <label class="admin-check tag-field">
                  <input
                    type="checkbox"
                    checked={draft.fields.includes(field.tag)}
                    onChange={(e) => toggleField(field.tag, (e.target as HTMLInputElement).checked)}
                  />
                  <span class="track-main">
                    <span class="track-title">
                      {tagLabel(field.tag)}
                      {tagLabel(field.tag) !== field.tag && <span class="tag-name"> {field.tag}</span>}
                    </span>
                    <span class="track-sub">
                      {field.trackCount
                        ? `${plural(field.trackCount, 'Titel', 'Titel')} · z. B. ${field.samples.join(', ')}`
                        : 'In keiner Datei vorhanden'}
                    </span>
                  </span>
                </label>
                {field.valueCount > 0 && (
                  <button
                    type="button"
                    class={`link-button${inspected === field.tag ? ' is-on' : ''}`}
                    aria-expanded={inspected === field.tag}
                    onClick={() => setInspected(inspected === field.tag ? undefined : field.tag)}
                  >
                    {inspected === field.tag ? 'Inhalt ausblenden' : `Inhalt anzeigen (${plural(field.valueCount, 'Wert', 'Werte')})`}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {inspected && (
          <TagContent
            key={inspected}
            tag={inspected}
            groupLabel={draft.groups.at(-1)?.label.trim() || undefined}
            onPick={
              draft.groups.length
                ? (value) => {
                    const last = draft.groups.length - 1;
                    const values = splitValues(draft.groups[last]!.values);
                    if (!values.some((v) => v.toLocaleLowerCase('de') === value.toLocaleLowerCase('de'))) {
                      setGroup(last, { values: [...values, value].join(', ') });
                    }
                  }
                : undefined
            }
            onClose={() => setInspected(undefined)}
          />
        )}
      </section>

      <section class="shelf admin-panel">
        <h2>Werte zusammenfassen</h2>
        <p class="admin-hint">
          Mehrere Tag-Werte unter einem Namen zeigen, z. B. „Musik“ aus Musik, Lied. Groß- und Kleinschreibung spielen keine Rolle.
        </p>
        {draft.groups.map((group, index) => (
          <div class="category-group" key={index}>
            <label class="field">
              <span>Anzeigen als</span>
              <input value={group.label} maxLength={100} placeholder="Musik" onInput={(e) => setGroup(index, { label: (e.target as HTMLInputElement).value })} />
            </label>
            <label class="field">
              <span>Tag-Werte, mit Komma getrennt</span>
              <input value={group.values} placeholder="Musik, Lied" onInput={(e) => setGroup(index, { values: (e.target as HTMLInputElement).value })} />
            </label>
            <button
              type="button"
              class="icon-button"
              aria-label={`„${group.label || 'Eintrag'}“ entfernen`}
              onClick={() => update({ groups: draft.groups.filter((_, i) => i !== index) })}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        ))}
        <button type="button" class="button-secondary button-small" onClick={() => update({ groups: [...draft.groups, { label: '', values: '' }] })}>
          + Zusammenfassung
        </button>
        {draft.groups.length > 0 && (
          <label class="admin-check">
            <input
              type="checkbox"
              checked={draft.groupedOnly}
              onChange={(e) => update({ groupedOnly: (e.target as HTMLInputElement).checked })}
            />
            Nur die zusammengefassten Werte zeigen, alle anderen ausblenden
          </label>
        )}
      </section>

      <Preview draft={draft} />

      {error && <p class="admin-error" role="alert">{error}</p>}
      <div class="actions">
        <button type="submit" class="button-primary" disabled={busy || !draft.name.trim() || draft.fields.length === 0}>
          {id === undefined ? 'Kategorie anlegen' : 'Speichern'}
        </button>
        <a class="button-secondary" href="/admin/kategorien">
          Abbrechen
        </a>
        {id !== undefined && (
          <button type="button" class="button-secondary" onClick={() => void remove()}>
            Löschen
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Aktueller Inhalt eines gescannten Tag-Felds, häufigste Werte zuerst. Mit einer Zusammenfassung
 * lässt sich ein Wert per Klick in deren Tag-Werte übernehmen.
 */
function TagContent({
  tag,
  groupLabel,
  onPick,
  onClose,
}: {
  tag: string;
  groupLabel: string | undefined;
  onPick?: (value: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 200);
  const [result, setResult] = useState<{ total: number; items: Array<{ value: string; trackCount: number }> } | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let current = true;
    adminRequest<{ total: number; items: Array<{ value: string; trackCount: number }> }>(
      'GET',
      `/api/admin/tag-fields/${encodeURIComponent(tag)}/values${query({ q, limit: 300 })}`,
    )
      .then((data) => current && (setResult(data), setError(undefined)))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [tag, q]);

  return (
    <div class="tag-content" role="region" aria-label={`Inhalt von ${tagLabel(tag)}`}>
      <div class="tag-content-head">
        <h3>
          Inhalt von „{tagLabel(tag)}“
          {result && <span class="tag-name"> {plural(result.total, 'Wert', 'Werte')}</span>}
        </h3>
        <button type="button" class="icon-button" aria-label="Inhalt schließen" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <form class="search-box search-box-small" role="search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={18} />
        <input
          type="search"
          value={text}
          placeholder="Werte filtern"
          aria-label="Werte filtern"
          autocomplete="off"
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
      </form>
      {onPick && (
        <p class="admin-hint">Klick auf einen Wert übernimmt ihn in {groupLabel ? `„${groupLabel}“` : 'die letzte Zusammenfassung'}.</p>
      )}
      {error ? (
        <p class="admin-error">{error}</p>
      ) : !result ? (
        <Loading />
      ) : result.items.length === 0 ? (
        <p class="admin-hint">Keine Werte gefunden.</p>
      ) : (
        <ul class="category-preview">
          {result.items.map((item) =>
            onPick ? (
              <li key={item.value}>
                <button type="button" class="value-chip" title={`Zu ${groupLabel ? `„${groupLabel}“` : 'Zusammenfassung'} hinzufügen`} onClick={() => onPick(item.value)}>
                  <span>{item.value}</span>
                  <small>{item.trackCount}</small>
                </button>
              </li>
            ) : (
              <li key={item.value}>
                <span>{item.value}</span>
                <small>{item.trackCount}</small>
              </li>
            ),
          )}
          {result.total > result.items.length && <li class="is-more">+ {result.total - result.items.length} weitere, über das Filterfeld finden</li>}
        </ul>
      )}
    </div>
  );
}

/** Werte, die die Kategorie mit der aktuellen Einstellung zeigen würde */
function Preview({ draft }: { draft: Draft }) {
  const body = toBody(draft);
  const key = useDebounced(JSON.stringify({ fields: body.fields, groups: body.groups, groupedOnly: body.groupedOnly }), 300);
  const [result, setResult] = useState<{ total: number; items: CategoryValue[] } | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const request = JSON.parse(key) as ReturnType<typeof toBody>;
    if (request.fields.length === 0) {
      setResult(undefined);
      return;
    }
    let current = true;
    adminRequest<{ total: number; items: CategoryValue[] }>('POST', '/api/admin/categories/preview', request)
      .then((data) => current && (setResult(data), setError(undefined)))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [key]);

  return (
    <section class="shelf admin-panel">
      <h2>Vorschau</h2>
      {body.fields.length === 0 ? (
        <p class="admin-hint">Wähle mindestens ein Tag-Feld.</p>
      ) : error ? (
        <p class="admin-error">{error}</p>
      ) : !result ? (
        <Loading />
      ) : result.total === 0 ? (
        <p class="admin-hint">Keine Werte gefunden.</p>
      ) : (
        <>
          <p class="count">{plural(result.total, 'Eintrag', 'Einträge')}</p>
          <ul class="category-preview">
            {result.items.slice(0, 60).map((item) => (
              <li key={item.value} class={item.grouped ? 'is-grouped' : ''} title={item.sources ? `aus ${item.sources.join(', ')}` : undefined}>
                <span>{item.value}</span>
                <small>{item.trackCount}</small>
              </li>
            ))}
            {result.total > 60 && <li class="is-more">+ {result.total - 60} weitere</li>}
          </ul>
        </>
      )}
    </section>
  );
}
