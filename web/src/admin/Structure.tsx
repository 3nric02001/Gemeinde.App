import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { formatCompactDate, plural } from '../format';
import { ErrorNote, Loading } from '../pages/common';
import { adminRequest } from './api';
import { setLeaveGuard } from '../router';
import { asGroup, ConditionGroup, describeCondition, isComplete, type Condition, type Leaf } from './Conditions';

export interface RecordingKind {
  name: string;
  plural: string;
  folderPattern: string;
  filePattern: string;
  albumTitle: string;
  trackTitle: string;
}

export type Player = 'sermon' | 'music';

/** Wenn … dann …: welcher Inhalt, was als Predigt gilt und welcher Player läuft */
export interface Policy {
  name: string;
  enabled: boolean;
  when: Condition;
  sermon?: boolean;
  player?: Player;
  /** Inhalt setzen statt ihn aus dem Dateinamen zu lesen */
  content?: string;
}

/** Art bestimmen: Wenn ein Albumordner passt, dann ist er diese Art, Musik oder Sonstiges */
export interface KindRule {
  name: string;
  enabled: boolean;
  when: Condition;
  kind: string;
  /** Nur Ordner mit Datum im Namen */
  datedOnly: boolean;
}

export interface Structure {
  kinds: RecordingKind[];
  kindRules: KindRule[];
  /** Art der übrigen Ordner mit Datum, auch Musik oder Sonstiges */
  defaultKind: string;
  contents: string[];
  /** Inhalte ohne Titel: ein einzelner Teil danach ist der Name ("Begrüßung - Jakob Rauschenberger") */
  untitled: string[];
  policies: Policy[];
  /** Albumbildung, Namen für Musik und Sonstiges, Predigt-Player nach Länge, Bibelstellen */
  library: Library;
}

export interface Library {
  discFolders: string[];
  mergeDatedSubfolders: boolean;
  splitByFileDate: boolean;
  albumTitle: string;
  trackTitle: string;
  looseTitle: string;
  sermonMinutes: number;
  passagePrefixes: string[];
  bookSpellings: string[];
}

const LIBRARY_PLACEHOLDER_HELP: Array<[string, string]> = [
  ['{ordner}', 'Name des Albumordners ohne Jahr, z. B. Chorlieder'],
  ['{jahr}', 'Jahr aus dem Ordnernamen, z. B. 2021 aus „Chorlieder (2021)“'],
  ['{titel}', 'Dateiname ohne Nummer und Endung'],
  ['{datei}', 'ganzer Dateiname ohne Endung'],
  ['{nr}', 'Nummer am Anfang des Dateinamens'],
];

/** Felder für „Art bestimmen“: Ordner, Pfad und Dateiname; Inhalt und Titel nach dem Muster hängen erst von der Art ab */
const KIND_FIELDS: Record<string, string> = {
  folder: 'Ordner im Pfad',
  path: 'Pfad',
  title: 'Dateiname',
};
const POLICY_FIELDS: Record<string, string> = {
  kind: 'Art',
  content: 'Inhalt',
  title: 'Titel',
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
};
const placeholderFor = (field: string) => POLICY_PLACEHOLDERS[field] ?? 'Suchbegriff';
const newFolderLeaf = (): Leaf => ({ field: 'folder', op: 'equals', value: '' });
const newPolicyLeaf = (): Leaf => ({ field: 'content', op: 'equals', value: '' });
const EMPTY_KIND_RULE: KindRule = { name: '', enabled: true, when: { match: 'all', conditions: [newFolderLeaf()] }, kind: '', datedOnly: true };
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
  /** Beispiele für Musik und Sonstiges nach den Vorlagen */
  others?: Array<{ folder: string; section: 'music' | 'other'; title: string; tracks: Array<{ file: string; title: string }> }>;
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
  folderPattern: '{datum}_{anlass}',
  filePattern: '{inhalt} - {titel} - {sprecher}',
  albumTitle: '{anlass}',
  trackTitle: '{inhalt}: {titel}',
};

type TextField = 'name' | 'plural' | 'folderPattern' | 'filePattern' | 'albumTitle' | 'trackTitle';

/** Bedingungen „Art ist genau <from>“ auf den neuen Namen der Art umstellen */
function renameKind(condition: Condition, from: string, to: string): Condition {
  if ('match' in condition) return { ...condition, conditions: condition.conditions.map((c) => renameKind(c, from, to)) };
  return condition.field === 'kind' && condition.op === 'equals' && condition.value === from ? { ...condition, value: to } : condition;
}

/** „Dann“ einer Policy in Worten, für die eingeklappte Regel */
function describePolicy(policy: Policy): string {
  const parts = [
    policy.content && `Inhalt „${policy.content}“`,
    policy.sermon === true ? 'Predigt' : policy.sermon === false ? 'keine Predigt' : undefined,
    policy.player === 'sermon' ? 'Predigt-Player' : policy.player === 'music' ? 'Musik-Player' : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nichts festgelegt';
}

/**
 * Eine Regel „Wenn … dann …“ in einer geordneten Liste: Name, Reihenfolge, Aktiv, Bedingung; „Dann“ kommt als children.
 * Eingeklappt steht sie als ein Satz da; neue oder unvollständige Regeln sind aufgeklappt.
 */
function RuleCard({
  name,
  index,
  count,
  enabled,
  when,
  then,
  fields,
  newLeaf,
  onChange,
  onMove,
  onRemove,
  children,
}: {
  name: string;
  index: number;
  count: number;
  enabled: boolean;
  when: Condition;
  /** „Dann“ in Worten, z. B. „Bibelstunde“ oder „Predigt, Predigt-Player“ */
  then: string;
  fields: Record<string, string>;
  newLeaf: () => Leaf;
  onChange: (patch: { name?: string; enabled?: boolean; when?: Condition }) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  children: ComponentChildren;
}) {
  const label = name || `Regel ${index + 1}`;
  const [open, setOpen] = useState(() => !isComplete(when));
  const sentence = isComplete(when) ? `Wenn ${describeCondition(when, { fields, ops: { ...TEXT_OPS, ...DURATION_OPS } })} → ${then}` : 'Bedingung unvollständig';
  return (
    <details
      class={`structure-policy structure-rule${enabled ? '' : ' is-disabled'}`}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span class="structure-rule-name">
          {label}
          {!enabled && <span class="badge badge-muted">inaktiv</span>}
        </span>
        <span class="structure-rule-sentence">{sentence}</span>
      </summary>
      <div class="section-head">
        <label class="field structure-policy-name">
          <span class="visually-hidden">Name der Regel</span>
          <input
            value={name}
            maxLength={80}
            placeholder={`Regel ${index + 1}`}
            onInput={(e) => onChange({ name: (e.target as HTMLInputElement).value })}
          />
        </label>
        <span class="admin-track-actions">
          <button type="button" class="icon-button" aria-label={`${label} nach oben`} disabled={index === 0} onClick={() => onMove(-1)}>
            <Icon name="down" size={18} class="flip" />
          </button>
          <button type="button" class="icon-button" aria-label={`${label} nach unten`} disabled={index === count - 1} onClick={() => onMove(1)}>
            <Icon name="down" size={18} />
          </button>
          <button type="button" class="icon-button" aria-label={`${label} entfernen`} onClick={onRemove}>
            <Icon name="close" size={18} />
          </button>
        </span>
      </div>
      <label class="admin-check">
        <input type="checkbox" checked={enabled} onChange={(e) => onChange({ enabled: (e.target as HTMLInputElement).checked })} />
        Aktiv
      </label>
      <h3>Wenn</h3>
      <ConditionGroup
        group={asGroup(when)}
        fields={fields}
        ops={opsFor}
        newLeaf={newLeaf}
        placeholder={placeholderFor}
        onChange={(next) => onChange({ when: next })}
      />
      <h3>Dann</h3>
      {children}
    </details>
  );
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
  // Stand auf dem Server, um ungespeicherte Änderungen zu erkennen
  const [saved, setSaved] = useState<Structure | undefined>();
  const [defaults, setDefaults] = useState<Structure | undefined>();
  const [preview, setPreview] = useState<Preview | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminRequest<{ structure: Structure; defaults: Structure }>('GET', '/api/admin/structure')
      .then((body) => {
        setDraft(body.structure);
        setSaved(body.structure);
        setDefaults(body.defaults);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
  // Wer mit ungespeicherten Änderungen weggeht, wird gefragt: beim Schließen des Tabs und bei Links in der App
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    setLeaveGuard(() => window.confirm('Die Änderungen an der Zuordnung sind noch nicht gespeichert. Trotzdem verlassen?'));
    return () => {
      window.removeEventListener('beforeunload', warn);
      setLeaveGuard(undefined);
    };
  }, [dirty]);

  if (!draft) return error ? <ErrorNote message={error} /> : <Loading />;

  const change = (next: Structure) => {
    setDraft(next);
    setMessage(undefined);
  };
  const updateKind = (index: number, patch: Partial<RecordingKind>) => {
    const before = draft.kinds[index]!.name;
    const kinds = draft.kinds.map((kind, i) => (i === index ? { ...kind, ...patch } : kind));
    // Umbenennen: „Art bestimmen“ und Policies mit „Art ist genau …“ ziehen mit
    if (patch.name === undefined || !before) return change({ ...draft, kinds });
    const to = patch.name;
    change({
      ...draft,
      kinds,
      kindRules: draft.kindRules.map((rule) => (rule.kind === before ? { ...rule, kind: to } : rule)),
      defaultKind: draft.defaultKind === before ? to : draft.defaultKind,
      policies: draft.policies.map((policy) => ({ ...policy, when: renameKind(policy.when, before, to) })),
    });
  };
  const moveKind = (index: number, delta: number) => change({ ...draft, kinds: move(draft.kinds, index, delta) });
  const policies = draft.policies;
  const kindRules = draft.kindRules;
  const updateKindRule = (index: number, patch: Partial<KindRule>) =>
    change({ ...draft, kindRules: kindRules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });
  const kindOptions = (
    <>
      {draft.kinds.map((kind) => (
        <option key={kind.name} value={kind.name}>
          {kind.name || 'Neue Art'}
        </option>
      ))}
      <option value="Musik">Musik</option>
      <option value="Sonstiges">Sonstiges</option>
    </>
  );
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
        setSaved(body.structure);
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
        Das Regelwerk arbeitet in drei Schritten: Zuerst bestimmt es die Art eines Albumordners (Gottesdienst, Bibelstunde oder eine
        eigene Art), dann liest es Ordner- und Dateinamen nach den Mustern dieser Art, zuletzt legen die Policies fest, was als
        Predigt gilt und welcher Player läuft. Einzelne Alben und Titel lassen sich im Album-Editor von Hand korrigieren.
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

      <section class="shelf admin-panel structure-policies structure-kind-rules">
        <h2>1. Art bestimmen</h2>
        <p class="admin-hint">
          Für jeden Albumordner gilt die erste passende Regel. Eine Regel passt, wenn der Ordner oder eine Datei darin passt, etwa
          über den Ordnernamen. Passt keine, bekommen Ordner mit Datum die Vorgabe unten; alles andere ist Sonstiges. Musik ist,
          was eine Regel oder die Verwaltung am Album zu Musik macht.
        </p>
        {kindRules.map((rule, index) => (
          <RuleCard
            key={index}
            name={rule.name}
            index={index}
            count={kindRules.length}
            enabled={rule.enabled}
            when={rule.when}
            then={rule.kind || 'Musik'}
            fields={KIND_FIELDS}
            newLeaf={newFolderLeaf}
            onChange={(patch) => updateKindRule(index, patch)}
            onMove={(delta) => change({ ...draft, kindRules: move(kindRules, index, delta) })}
            onRemove={() => change({ ...draft, kindRules: kindRules.filter((_, i) => i !== index) })}
          >
            <div class="structure-grid">
              <label class="field">
                <span>Art</span>
                <select value={rule.kind || 'Musik'} onChange={(e) => updateKindRule(index, { kind: (e.target as HTMLSelectElement).value })}>
                  {kindOptions}
                </select>
              </label>
            </div>
            <label class="admin-check">
              <input
                type="checkbox"
                checked={rule.datedOnly}
                onChange={(e) => updateKindRule(index, { datedOnly: (e.target as HTMLInputElement).checked })}
              />
              Nur Ordner mit Datum im Namen
            </label>
          </RuleCard>
        ))}
        <div class="structure-policy structure-default-kind">
          <label class="field">
            <span>Sonst, bei Ordnern mit Datum</span>
            <select value={draft.defaultKind || 'Musik'} onChange={(e) => change({ ...draft, defaultKind: (e.target as HTMLSelectElement).value })}>
              {kindOptions}
            </select>
          </label>
        </div>
        <div class="actions">
          <button
            type="button"
            class="button-secondary"
            disabled={kindRules.length >= 30}
            onClick={() => change({ ...draft, kindRules: [...kindRules, { ...structuredClone(EMPTY_KIND_RULE), kind: draft.kinds[0]?.name ?? '' }] })}
          >
            Regel hinzufügen
          </button>
        </div>
      </section>

      <h2 class="structure-step">2. Arten: Ordner- und Dateinamen lesen</h2>
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
        <h2>3. Policies: Inhalt, Predigt und Player</h2>
        <p class="admin-hint">
          Wenn … dann …: Die Liste gilt von oben nach unten, für jede Wirkung entscheidet die erste passende Policy. Eine Predigt
          liefert Sprecher und Bibelstelle des Albums. Der Predigt-Player hat Sprünge, Tempo und merkt sich die Stelle. Passt keine
          Policy, ist ein Titel keine Predigt und bekommt ab 10 Minuten Länge den Predigt-Player. „Inhalt setzen“ geht dem Dateinamen
          vor und wird zuerst entschieden: Bedingungen auf den Inhalt sehen dann schon den gesetzten Inhalt.
        </p>
        <datalist id="policy-contents">
          {draft.contents.filter(Boolean).map((content) => (
            <option key={content} value={content} />
          ))}
        </datalist>
        {policies.map((policy, index) => (
          <RuleCard
            key={index}
            name={policy.name}
            index={index}
            count={policies.length}
            enabled={policy.enabled}
            when={policy.when}
            then={describePolicy(policy)}
            fields={POLICY_FIELDS}
            newLeaf={newPolicyLeaf}
            onChange={(patch) => updatePolicy(index, patch)}
            onMove={(delta) => change({ ...draft, policies: move(policies, index, delta) })}
            onRemove={() => change({ ...draft, policies: policies.filter((_, i) => i !== index) })}
          >
            <div class="structure-grid">
              <label class="field">
                <span>Inhalt setzen</span>
                <input
                  value={policy.content ?? ''}
                  maxLength={60}
                  list="policy-contents"
                  placeholder="nicht festlegen"
                  onInput={(e) => {
                    const value = (e.target as HTMLInputElement).value;
                    updatePolicy(index, { content: value.trim() ? value : undefined });
                  }}
                />
              </label>
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
          </RuleCard>
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

      <LibrarySection library={draft.library} onChange={(library) => change({ ...draft, library })} />

      {/* Immer sichtbar am unteren Rand, damit Änderungen oben auf der Seite nicht verloren gehen */}
      <div class={`structure-bar${dirty ? ' is-dirty' : ''}`}>
        <p class="structure-bar-state">
          {error ? (
            <span class="admin-error" role="alert">
              {error}
            </span>
          ) : message ? (
            <span role="status">{message}</span>
          ) : dirty ? (
            <span>
              <i class="structure-dot" aria-hidden="true" /> Ungespeicherte Änderungen
            </span>
          ) : (
            <span class="admin-hint">Alles gespeichert</span>
          )}
        </p>
        {dirty && saved && (
          <button type="button" class="button-secondary" disabled={busy} onClick={() => change(structuredClone(saved))}>
            Verwerfen
          </button>
        )}
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

/** Eine Zeile je Eintrag; leere Zeilen verwirft der Server */
const lines = (value: string) => value.split('\n').map((line) => line.trimStart());

/**
 * Albumbildung und Namen: welche Unterordner zum Album gehören, wie Musik und Sonstiges heißen, ab wann der
 * Predigt-Player läuft und woran Bibelstellen erkannt werden.
 */
function LibrarySection({ library, onChange }: { library: Library; onChange: (library: Library) => void }) {
  const set = (patch: Partial<Library>) => onChange({ ...library, ...patch });
  const list = (key: 'discFolders' | 'passagePrefixes' | 'bookSpellings', label: string, hint: string, rows = 4) => (
    <label class="field">
      <span>{label}</span>
      <textarea id={`library-${key}`} rows={rows} value={library[key].join('\n')} onInput={(e) => set({ [key]: lines((e.target as HTMLTextAreaElement).value) })} />
      <small class="field-hint">{hint}</small>
    </label>
  );
  const text = (key: 'albumTitle' | 'trackTitle' | 'looseTitle', label: string, hint: string) => (
    <label class="field">
      <span>{label}</span>
      <input id={`library-${key}`} value={library[key]} maxLength={200} onInput={(e) => set({ [key]: (e.target as HTMLInputElement).value })} />
      <small class="field-hint">{hint}</small>
    </label>
  );
  return (
    <section class="shelf admin-panel structure-library">
      <h2>Albumbildung und Namen</h2>
      <p class="admin-hint">
        Gilt für alle Ordner, auch für Musik und Sonstiges. Änderungen wirken nach „Speichern und anwenden“ sofort, ohne neuen
        Scan.
      </p>

      <h3>Alben aus Ordnern</h3>
      {list('discFolders', 'Unterordner, die zum Album darüber gehören', 'Mit Nummer dahinter, z. B. „CD 2“ oder „Teil 1“; eine Zeile je Wort.', 6)}
      <label class="admin-check">
        <input
          type="checkbox"
          checked={library.mergeDatedSubfolders}
          onChange={(e) => set({ mergeDatedSubfolders: (e.target as HTMLInputElement).checked })}
        />
        Unterordner eines Ordners mit Datum gehören zu dessen Album („2026-09-27/Predigt“ und „2026-09-27/Lobpreis“ sind ein
        Gottesdienst)
      </label>
      <label class="admin-check">
        <input type="checkbox" checked={library.splitByFileDate} onChange={(e) => set({ splitByFileDate: (e.target as HTMLInputElement).checked })} />
        Ordner ohne Datum, in denen die meisten Dateien ein Datum im Namen tragen, je Datum in eigene Alben teilen
        („Predigten/2026-08-02 Meier - Psalm 23.mp3“)
      </label>

      <h3>Namen für Musik und Sonstiges</h3>
      <div class="admin-fields admin-fields-2">
        {text('albumTitle', 'Name des Albums', 'Vorgabe {ordner}; z. B. „{ordner} ({jahr})“')}
        {text('trackTitle', 'Titel', 'Vorgabe {titel}; z. B. „{nr}. {titel}“')}
      </div>
      <dl class="structure-placeholders">
        {LIBRARY_PLACEHOLDER_HELP.map(([name, help]) => (
          <div key={name}>
            <dt>
              <code>{name}</code>
            </dt>
            <dd>{help}</dd>
          </div>
        ))}
      </dl>
      {text('looseTitle', 'Name für Dateien direkt im Musikordner', 'Vorgabe „Einzeltitel“')}

      <h3>Predigt-Player</h3>
      <label class="field structure-minutes">
        <span>Ohne passende Policy ab so vielen Minuten</span>
        <input
          id="library-sermonMinutes"
          type="number"
          min={0}
          max={600}
          step={1}
          value={library.sermonMinutes}
          onInput={(e) => set({ sermonMinutes: Number((e.target as HTMLInputElement).value) })}
        />
        <small class="field-hint">Solche Titel bekommen Sprünge, Tempo und Weiterhören. Policies gehen vor.</small>
      </label>

      <h3>Bibelstellen</h3>
      <div class="admin-fields admin-fields-2">
        {list(
          'passagePrefixes',
          'Wörter vor einer Bibelstelle im Dateinamen',
          '„Text_Richter 7,1-4“ wird „Richter 7,1-4“, „Bergpredigt Text_Matthäus 7“ wird „Bergpredigt (Matthäus 7)“.',
        )}
        {list('bookSpellings', 'Weitere Schreibweisen von Bibelbüchern', 'Zusätzlich zu den üblichen Namen und Abkürzungen, z. B. „Kollosser“.')}
      </div>
    </section>
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
              <span class="badge badge-attention"> {plural(kind.unmatchedFiles, 'Datei passt', 'Dateien passen')} nicht zum Muster</span>
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
                      {!track.matched && <span class="badge badge-attention">passt nicht</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
      {preview.others && preview.others.length > 0 && (
        <div class="admin-panel">
          <h3>Musik und Sonstiges</h3>
          {preview.others.map((example) => (
            <div key={example.folder} class="structure-example">
              <p class="track-title">
                {example.title} <span class="badge badge-muted">{example.section === 'music' ? 'Musik' : 'Sonstiges'}</span>
              </p>
              <p class="track-sub">{example.folder}</p>
              <ul class="structure-files">
                {example.tracks.map((track) => (
                  <li key={track.file}>
                    <span class="structure-file">{track.file}</span>
                    <span aria-hidden="true">→</span>
                    <span>{track.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
