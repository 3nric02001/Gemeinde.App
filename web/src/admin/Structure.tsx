import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { formatCompactDate, plural } from '../format';
import { ErrorNote, Loading } from '../pages/common';
import { adminRequest } from './api';
import { asGroup, ConditionGroup, type Condition, type Leaf } from './Conditions';

export interface RecordingKind {
  name: string;
  plural: string;
  /** Woran die Art ihre Ordner erkennt; null: alle übrigen Ordner mit Datum */
  match: Condition | null;
  /** Nur Ordner mit Datum im Namen */
  datedOnly: boolean;
  folderPattern: string;
  filePattern: string;
  albumTitle: string;
  trackTitle: string;
  preferTags: boolean;
}

export type Player = 'sermon' | 'music';

/** Wenn … dann …: was als Predigt gilt und welcher Player läuft */
export interface Policy {
  name: string;
  enabled: boolean;
  when: Condition;
  sermon?: boolean;
  player?: Player;
}

export interface Structure {
  kinds: RecordingKind[];
  contents: string[];
  /** Inhalte ohne Titel: ein einzelner Teil danach ist der Name ("Begrüßung - Jakob Rauschenberger") */
  untitled: string[];
  policies: Policy[];
}

const FOLDER_FIELDS: Record<string, string> = { folder: 'Ordner im Pfad', path: 'Pfad' };
const POLICY_FIELDS: Record<string, string> = {
  kind: 'Art',
  content: 'Inhalt',
  title: 'Titel',
  artist: 'Interpret',
  album: 'Album (Tag)',
  genre: 'Genre',
  folder: 'Ordner im Pfad',
  path: 'Pfad',
  duration: 'Dauer (Minuten)',
};
const TEXT_OPS: Record<string, string> = { equals: 'ist genau', contains: 'enthält', not_contains: 'enthält nicht', starts: 'beginnt mit' };
const DURATION_OPS: Record<string, string> = { at_least: 'mindestens', less_than: 'kürzer als' };
const opsFor = (field: string) => (field === 'duration' ? DURATION_OPS : TEXT_OPS);
const POLICY_PLACEHOLDERS: Record<string, string> = {
  kind: 'z. B. Gottesdienst',
  content: 'z. B. Predigt',
  folder: 'z. B. Bibelstunden',
  path: 'z. B. Jugend',
  duration: 'z. B. 20',
  genre: 'z. B. Predigt',
};
const placeholderFor = (field: string) => POLICY_PLACEHOLDERS[field] ?? 'Suchbegriff';
const newFolderLeaf = (): Leaf => ({ field: 'folder', op: 'equals', value: '' });
const newPolicyLeaf = (): Leaf => ({ field: 'content', op: 'equals', value: '' });
const EMPTY_POLICY: Policy = { name: '', enabled: true, when: { match: 'all', conditions: [newPolicyLeaf()] }, sermon: true, player: 'sermon' };

interface Preview {
  kinds: Array<{
    name: string;
    albums: number;
    unmatchedFiles: number;
    examples: Array<{
      folder: string;
      date: string | undefined;
      title: string;
      speaker: string | null;
      passage: string | null;
      tracks: Array<{ file: string; title: string; content: string | null; matched: boolean; sermon: boolean; player: Player }>;
    }>;
  }>;
}

const PLACEHOLDER_HELP: Array<[string, string]> = [
  ['{datum}', 'Datum wie 2026_08_30, 2026-08-30 oder 30.08.2026'],
  ['{anlass}', 'Anlass im Ordnernamen, z. B. Einschulung'],
  ['{bibelstelle}', 'Bibelstelle, z. B. Matthäus 9, 27-38'],
  ['{inhalt}', 'Lied, Predigt, Gebet … (Liste unten)'],
  ['{titel}', 'Titel einer Aufnahme'],
  ['{sprecher}', 'Name des Predigers'],
  ['{nr}', 'Laufende Nummer, z. B. 001'],
];

const EMPTY_KIND: RecordingKind = {
  name: '',
  plural: '',
  match: { match: 'all', conditions: [newFolderLeaf()] },
  datedOnly: true,
  folderPattern: '{datum}_{anlass}',
  filePattern: '{inhalt} - {titel} - {sprecher}',
  albumTitle: '{anlass}',
  trackTitle: '{inhalt}: {titel}',
  preferTags: false,
};

type TextField = 'name' | 'plural' | 'folderPattern' | 'filePattern' | 'albumTitle' | 'trackTitle';

/** Bedingungen „Art ist genau <from>“ auf den neuen Namen der Art umstellen */
function renameKind(condition: Condition, from: string, to: string): Condition {
  if ('match' in condition) return { ...condition, conditions: condition.conditions.map((c) => renameKind(c, from, to)) };
  return condition.field === 'kind' && condition.op === 'equals' && condition.value === from ? { ...condition, value: to } : condition;
}

/** Eintrag in einer Liste um `delta` verschieben */
function move<T>(list: T[], index: number, delta: number): T[] {
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(index + delta, 0, item!);
  return next;
}

/** Verwaltung → Zuordnung: Regelwerk für Gottesdienste, Bibelstunden und andere Aufnahmen */
export function StructurePanel() {
  const [draft, setDraft] = useState<Structure | undefined>();
  const [defaults, setDefaults] = useState<Structure | undefined>();
  const [preview, setPreview] = useState<Preview | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminRequest<{ structure: Structure; defaults: Structure }>('GET', '/api/admin/structure')
      .then((body) => {
        setDraft(body.structure);
        setDefaults(body.defaults);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!draft) return error ? <ErrorNote message={error} /> : <Loading />;

  const change = (next: Structure) => {
    setDraft(next);
    setMessage(undefined);
  };
  const updateKind = (index: number, patch: Partial<RecordingKind>) => {
    const before = draft.kinds[index]!.name;
    const kinds = draft.kinds.map((kind, i) => (i === index ? { ...kind, ...patch } : kind));
    // Umbenennen: Policies mit „Art ist genau …“ ziehen mit
    const policies =
      patch.name !== undefined && before
        ? (draft.policies ?? []).map((policy) => ({ ...policy, when: renameKind(policy.when, before, patch.name!) }))
        : draft.policies;
    change({ ...draft, kinds, policies });
  };
  const moveKind = (index: number, delta: number) => change({ ...draft, kinds: move(draft.kinds, index, delta) });
  const policies = draft.policies ?? [];
  const updatePolicy = (index: number, patch: Partial<Policy>) =>
    change({ ...draft, policies: policies.map((policy, i) => (i === index ? { ...policy, ...patch } : policy)) });

  const run = async (action: 'preview' | 'save') => {
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'preview') {
        setPreview(await adminRequest<Preview>('POST', '/api/admin/structure/preview', draft));
      } else {
        const body = await adminRequest<{ structure: Structure }>('PUT', '/api/admin/structure', draft);
        setDraft(body.structure);
        setPreview(await adminRequest<Preview>('POST', '/api/admin/structure/preview', body.structure));
        setMessage('Gespeichert. Die Alben sind neu gebildet.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const text = (index: number, field: TextField, label: string, hint?: string, placeholder?: string) => (
    <label class="field">
      <span>{label}</span>
      <input
        id={`kind-${index}-${field}`}
        value={draft.kinds[index]![field]}
        placeholder={placeholder}
        maxLength={200}
        onInput={(e) => updateKind(index, { [field]: (e.target as HTMLInputElement).value })}
      />
      {hint && <small class="field-hint">{hint}</small>}
    </label>
  );

  return (
    <form
      class="structure-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void run('save');
      }}
    >
      <h1 class="page-title">Zuordnung von Aufnahmen</h1>
      <p class="admin-hint">
        Hier steht, wie die App Gottesdienste, Bibelstunden und eigene Arten von Aufnahmen in der Nextcloud erkennt, wie sie Ordner-
        und Dateinamen liest und was als Predigt gilt. Es gilt die erste Art, deren Bedingung passt; eine Art ohne Bedingung nimmt
        alle übrigen Ordner mit Datum. Trennzeichen sind austauschbar: „ - “, „_“ und „.“ passen aufeinander. Einzelne Alben
        lassen sich im Album-Editor einer anderen Art zuordnen.
      </p>

      <details class="admin-panel structure-help">
        <summary>Platzhalter in Mustern und Vorlagen</summary>
        <dl>
          {PLACEHOLDER_HELP.map(([name, help]) => (
            <div key={name}>
              <dt>
                <code>{name}</code>
              </dt>
              <dd>{help}</dd>
            </div>
          ))}
        </dl>
      </details>

      {draft.kinds.map((kind, index) => (
        <section key={index} class="shelf admin-panel structure-kind">
          <div class="section-head">
            <h2>{kind.name || 'Neue Art'}</h2>
            <span class="admin-track-actions">
              <button type="button" class="icon-button" aria-label={`${kind.name} nach oben`} disabled={index === 0} onClick={() => moveKind(index, -1)}>
                <Icon name="down" size={18} class="flip" />
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label={`${kind.name} nach unten`}
                disabled={index === draft.kinds.length - 1}
                onClick={() => moveKind(index, 1)}
              >
                <Icon name="down" size={18} />
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label={`${kind.name} entfernen`}
                disabled={draft.kinds.length === 1}
                onClick={() => change({ ...draft, kinds: draft.kinds.filter((_, i) => i !== index) })}
              >
                <Icon name="close" size={18} />
              </button>
            </span>
          </div>
          <div class="structure-grid">
            {text(index, 'name', 'Name', undefined, 'z. B. Bibelstunde')}
            {text(index, 'plural', 'Mehrzahl', 'Für Überschriften und Filter', 'z. B. Bibelstunden')}
            {text(index, 'folderPattern', 'Ordnername', 'z. B. 2026_08_30_Einschulung', '{datum}_{anlass}')}
            {text(index, 'filePattern', 'Dateiname (ohne Endung)', 'z. B. Predigt - Der gute Hirte - Pastor Meier', '{inhalt} - {titel} - {sprecher}')}
            {text(index, 'albumTitle', 'Name des Albums', 'Leer oder ohne Wert: der Name der Art', '{anlass}')}
            {text(index, 'trackTitle', 'Titel einer Aufnahme', 'Leere Platzhalter fallen samt Trennern weg', '{inhalt}: {titel}')}
          </div>
          <div class="structure-match">
            <h3>Erkennen an</h3>
            {kind.match ? (
              <>
                <ConditionGroup
                  group={asGroup(kind.match)}
                  fields={FOLDER_FIELDS}
                  ops={opsFor}
                  newLeaf={newFolderLeaf}
                  placeholder={(field) => (field === 'folder' ? 'z. B. Bibelstunden' : 'z. B. Jugend')}
                  onChange={(match) => updateKind(index, { match })}
                />
                <label class="admin-check">
                  <input
                    type="checkbox"
                    checked={kind.datedOnly}
                    onChange={(e) => updateKind(index, { datedOnly: (e.target as HTMLInputElement).checked })}
                  />
                  Nur Ordner mit Datum im Namen
                </label>
                <button type="button" class="more-link" onClick={() => updateKind(index, { match: null, datedOnly: true })}>
                  Ohne Bedingung: alle übrigen Ordner mit Datum
                </button>
              </>
            ) : (
              <p class="admin-hint">
                Alle übrigen Ordner mit Datum.{' '}
                <button
                  type="button"
                  class="more-link"
                  onClick={() => updateKind(index, { match: { match: 'all', conditions: [newFolderLeaf()] } })}
                >
                  Bedingung festlegen
                </button>
              </p>
            )}
          </div>
          <label class="admin-check">
            <input
              type="checkbox"
              checked={kind.preferTags}
              onChange={(e) => updateKind(index, { preferTags: (e.target as HTMLInputElement).checked })}
            />
            Tags der Datei (Titel, Album, Interpret) statt des Dateinamens verwenden, wenn es welche gibt
          </label>
        </section>
      ))}

      <div class="actions">
        <button
          type="button"
          class="button-secondary"
          disabled={draft.kinds.length >= 10}
          onClick={() => change({ ...draft, kinds: [...draft.kinds, { ...EMPTY_KIND }] })}
        >
          Art hinzufügen
        </button>
        {defaults && (
          <button type="button" class="button-secondary" onClick={() => change(structuredClone(defaults))}>
            Vorgabe laden
          </button>
        )}
      </div>

      <section class="shelf admin-panel structure-policies">
        <h2>Policies: Predigt und Player</h2>
        <p class="admin-hint">
          Wenn … dann …: Die Liste gilt von oben nach unten, für jede Wirkung entscheidet die erste passende Policy. Eine Predigt
          liefert Sprecher und Bibelstelle des Albums. Der Predigt-Player hat Sprünge, Tempo und merkt sich die Stelle. Passt keine
          Policy, ist ein Titel keine Predigt und bekommt ab 10 Minuten Länge den Predigt-Player.
        </p>
        {policies.map((policy, index) => (
          <div key={index} class={`structure-policy${policy.enabled ? '' : ' is-disabled'}`}>
            <div class="section-head">
              <label class="field structure-policy-name">
                <span class="visually-hidden">Name der Policy</span>
                <input
                  value={policy.name}
                  maxLength={80}
                  placeholder={`Policy ${index + 1}`}
                  onInput={(e) => updatePolicy(index, { name: (e.target as HTMLInputElement).value })}
                />
              </label>
              <span class="admin-track-actions">
                <button
                  type="button"
                  class="icon-button"
                  aria-label={`${policy.name || `Policy ${index + 1}`} nach oben`}
                  disabled={index === 0}
                  onClick={() => change({ ...draft, policies: move(policies, index, -1) })}
                >
                  <Icon name="down" size={18} class="flip" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label={`${policy.name || `Policy ${index + 1}`} nach unten`}
                  disabled={index === policies.length - 1}
                  onClick={() => change({ ...draft, policies: move(policies, index, 1) })}
                >
                  <Icon name="down" size={18} />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label={`${policy.name || `Policy ${index + 1}`} entfernen`}
                  onClick={() => change({ ...draft, policies: policies.filter((_, i) => i !== index) })}
                >
                  <Icon name="close" size={18} />
                </button>
              </span>
            </div>
            <label class="admin-check">
              <input
                type="checkbox"
                checked={policy.enabled}
                onChange={(e) => updatePolicy(index, { enabled: (e.target as HTMLInputElement).checked })}
              />
              Aktiv
            </label>
            <h3>Wenn</h3>
            <ConditionGroup
              group={asGroup(policy.when)}
              fields={POLICY_FIELDS}
              ops={opsFor}
              newLeaf={newPolicyLeaf}
              placeholder={placeholderFor}
              onChange={(when) => updatePolicy(index, { when })}
            />
            <h3>Dann</h3>
            <div class="structure-grid">
              <label class="field">
                <span>Gilt als Predigt</span>
                <select
                  value={policy.sermon === undefined ? '' : policy.sermon ? 'yes' : 'no'}
                  onChange={(e) => {
                    const value = (e.target as HTMLSelectElement).value;
                    updatePolicy(index, { sermon: value === '' ? undefined : value === 'yes' });
                  }}
                >
                  <option value="">nicht festlegen</option>
                  <option value="yes">ja, liefert Sprecher und Bibelstelle</option>
                  <option value="no">nein</option>
                </select>
              </label>
              <label class="field">
                <span>Player</span>
                <select
                  value={policy.player ?? ''}
                  onChange={(e) => {
                    const value = (e.target as HTMLSelectElement).value;
                    updatePolicy(index, { player: value ? (value as Player) : undefined });
                  }}
                >
                  <option value="">nicht festlegen</option>
                  <option value="sermon">Predigt-Player</option>
                  <option value="music">Musik-Player</option>
                </select>
              </label>
            </div>
          </div>
        ))}
        <div class="actions">
          <button
            type="button"
            class="button-secondary"
            disabled={policies.length >= 50}
            onClick={() => change({ ...draft, policies: [...policies, structuredClone(EMPTY_POLICY)] })}
          >
            Policy hinzufügen
          </button>
        </div>
      </section>

      <section class="shelf admin-panel">
        <h2>Inhalte</h2>
        <p class="admin-hint">
          Was am Anfang eines Dateinamens stehen kann, eine Zeile je Inhalt. Nötig vor allem für Inhalte aus mehreren Wörtern
          („Gebet und Segen“); einzelne Wörter erkennt die App auch so.
        </p>
        <label class="field">
          <span>Bekannte Inhalte</span>
          <textarea
            id="structure-contents"
            rows={6}
            value={draft.contents.join('\n')}
            onInput={(e) =>
              change({
                ...draft,
                contents: (e.target as HTMLTextAreaElement).value.split('\n').map((line) => line.trimStart()),
              })
            }
          />
        </label>
        <label class="field">
          <span>Inhalte ohne Titel</span>
          <textarea
            id="structure-untitled"
            rows={5}
            value={(draft.untitled ?? []).join('\n')}
            onInput={(e) =>
              change({
                ...draft,
                untitled: (e.target as HTMLTextAreaElement).value.split('\n').map((line) => line.trimStart()),
              })
            }
          />
          <small class="field-hint">
            Folgt nach einem dieser Inhalte nur ein Teil, ist das der Name: „Begrüßung - Jakob Rauschenberger“ wird „Begrüßung“
            mit Jakob Rauschenberger, bei „Lied - Großer Gott“ bleibt „Großer Gott“ der Titel.
          </small>
        </label>
      </section>

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
        <button type="button" class="button-secondary" disabled={busy} onClick={() => void run('preview')}>
          Vorschau
        </button>
        <button type="submit" class="button-primary" disabled={busy}>
          Speichern und anwenden
        </button>
      </div>

      {preview && <PreviewList preview={preview} />}
    </form>
  );
}

function PreviewList({ preview }: { preview: Preview }) {
  return (
    <section class="shelf structure-preview" aria-label="Vorschau">
      <h2>Vorschau</h2>
      {preview.kinds.map((kind) => (
        <div key={kind.name} class="admin-panel">
          <h3>
            {kind.name} <span class="badge badge-muted">{plural(kind.albums, 'Album', 'Alben')}</span>
            {kind.unmatchedFiles > 0 && (
              <span class="badge"> {plural(kind.unmatchedFiles, 'Datei passt', 'Dateien passen')} nicht zum Muster</span>
            )}
          </h3>
          {kind.examples.map((example) => (
            <div key={example.folder} class="structure-example">
              <p class="track-title">
                {example.title}
                {example.date && <span class="track-sub"> · {formatCompactDate(example.date)}</span>}
              </p>
              <p class="track-sub">
                {[example.speaker && `Sprecher: ${example.speaker}`, example.passage && `Bibelstelle: ${example.passage}`, example.folder]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <ul class="structure-files">
                {example.tracks.map((track) => (
                  <li key={track.file} class={track.matched ? '' : 'is-unmatched'}>
                    <span class="structure-file">{track.file}</span>
                    <span aria-hidden="true">→</span>
                    <span>
                      {track.title}
                      {track.content && <span class="badge badge-muted">{track.content}</span>}
                      {track.sermon && <span class="badge badge-muted">Predigt</span>}
                      {track.player === 'sermon' && <span class="badge badge-muted">Predigt-Player</span>}
                      {!track.matched && <span class="badge">passt nicht</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
