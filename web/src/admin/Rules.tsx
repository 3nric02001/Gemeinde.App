import { useEffect, useState } from 'preact/hooks';
import { plural } from '../format';
import { useDebounced } from '../hooks';
import {
  adminRequest,
  describeRule,
  isComplete,
  isGroup,
  RULE_FIELD_LABELS,
  RULE_OP_LABELS,
  type AdminAlbumDetail,
  type RuleCondition,
  type RuleField,
  type RuleGroup,
  type RuleLeaf,
  type RuleOp,
} from './api';

/** Wie tief Gruppen verschachtelt werden können (muss zum Server passen) */
const MAX_DEPTH = 4;

interface RuleInput {
  condition: RuleCondition;
  move: boolean;
}

const newLeaf = (): RuleLeaf => ({ field: 'title', op: 'contains', value: '' });
const newGroup = (match: RuleGroup['match'] = 'all'): RuleGroup => ({ match, conditions: [newLeaf()] });
/** Im Editor ist die oberste Ebene immer eine Gruppe, damit sich jederzeit Bedingungen ergänzen lassen. */
const asGroup = (condition: RuleCondition): RuleGroup => (isGroup(condition) ? condition : { match: 'all', conditions: [condition] });

/** Regeln füllen das Album automatisch, auch mit Titeln, die erst später in die Nextcloud kommen. */
export function Rules({
  album,
  busy,
  onSave,
  onDelete,
}: {
  album: AdminAlbumDetail;
  busy: boolean;
  onSave: (rule: RuleInput, ruleId?: number) => void;
  onDelete: (ruleId: number) => void;
}) {
  // Regel im Editor: neue (id undefined) oder eine bestehende, die gerade bearbeitet wird
  const [editing, setEditing] = useState<{ id?: number; condition: RuleGroup; move: boolean }>(() => ({
    condition: newGroup(),
    move: false,
  }));
  const reset = () => setEditing({ condition: newGroup(), move: false });

  return (
    <section class="shelf admin-panel">
      <div class="section-head">
        <h2>Regeln</h2>
      </div>
      <p class="admin-hint">
        Alle Titel, auf die eine Regel passt, kommen automatisch in dieses Album, auch solche, die später in die Nextcloud
        kommen. Bedingungen lassen sich in Gruppen mit UND/ODER verschachteln. Groß- und Kleinschreibung und Umlaute spielen
        keine Rolle. Mehrere Regeln gelten mit ODER.
      </p>
      {album.rules.length > 0 && (
        <ul class="admin-rules">
          {album.rules.map((rule) => (
            <li key={rule.id} class={editing.id === rule.id ? 'is-editing' : ''}>
              <span>
                {describeRule(rule.condition)}
                {rule.move && <span class="badge badge-muted">verschiebt</span>}
              </span>
              <span class="admin-rule-actions">
                <button
                  type="button"
                  class="button-secondary button-small"
                  disabled={busy}
                  onClick={() => setEditing({ id: rule.id, condition: asGroup(rule.condition), move: rule.move })}
                >
                  Bearbeiten
                </button>
                <button type="button" class="button-secondary button-small" disabled={busy} onClick={() => onDelete(rule.id)}>
                  Löschen
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        class="admin-rule-editor"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isComplete(editing.condition)) return;
          onSave({ condition: editing.condition, move: editing.move }, editing.id);
          reset();
        }}
      >
        <h3>{editing.id === undefined ? 'Neue Regel' : 'Regel bearbeiten'}</h3>
        <ConditionGroup group={editing.condition} depth={0} onChange={(condition) => setEditing({ ...editing, condition })} />
        <label class="admin-check">
          <input
            type="checkbox"
            checked={editing.move}
            onChange={(e) => setEditing({ ...editing, move: (e.target as HTMLInputElement).checked })}
          />
          Passende Titel aus ihrem automatischen Album herausnehmen (verschieben)
        </label>
        <Preview condition={editing.condition} />
        <div class="actions">
          <button type="submit" class="button-primary" disabled={busy || !isComplete(editing.condition)}>
            {editing.id === undefined ? 'Regel hinzufügen' : 'Regel speichern'}
          </button>
          {editing.id !== undefined && (
            <button type="button" class="button-secondary" onClick={reset}>
              Abbrechen
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function ConditionGroup({
  group,
  depth,
  onChange,
  onRemove,
}: {
  group: RuleGroup;
  depth: number;
  onChange: (group: RuleGroup) => void;
  onRemove?: () => void;
}) {
  const set = (index: number, condition: RuleCondition) =>
    onChange({ ...group, conditions: group.conditions.map((c, i) => (i === index ? condition : c)) });
  const remove = (index: number) => onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) });
  const canRemoveChild = group.conditions.length > 1 || depth > 0;

  return (
    <div class={`rule-group${depth > 0 ? ' is-nested' : ''}`} role="group" aria-label={depth ? 'Bedingungsgruppe' : 'Bedingungen'}>
      <div class="rule-group-head">
        <label class="field">
          <span class="visually-hidden">Verknüpfung</span>
          <select value={group.match} onChange={(e) => onChange({ ...group, match: (e.target as HTMLSelectElement).value as RuleGroup['match'] })}>
            <option value="all">Alle Bedingungen (UND)</option>
            <option value="any">Mindestens eine (ODER)</option>
          </select>
        </label>
        {onRemove && (
          <button type="button" class="more-link" onClick={onRemove}>
            Gruppe entfernen
          </button>
        )}
      </div>
      {group.conditions.map((condition, index) => (
        <div key={index} class="rule-item">
          {index > 0 && <span class="rule-joiner">{group.match === 'all' ? 'und' : 'oder'}</span>}
          {isGroup(condition) ? (
            <ConditionGroup group={condition} depth={depth + 1} onChange={(c) => set(index, c)} onRemove={() => remove(index)} />
          ) : (
            <ConditionRow leaf={condition} onChange={(c) => set(index, c)} onRemove={canRemoveChild ? () => remove(index) : undefined} />
          )}
        </div>
      ))}
      <div class="rule-group-add">
        <button type="button" class="button-secondary button-small" onClick={() => onChange({ ...group, conditions: [...group.conditions, newLeaf()] })}>
          + Bedingung
        </button>
        {depth + 1 < MAX_DEPTH && (
          <button
            type="button"
            class="button-secondary button-small"
            onClick={() => onChange({ ...group, conditions: [...group.conditions, newGroup(group.match === 'all' ? 'any' : 'all')] })}
          >
            + Gruppe
          </button>
        )}
      </div>
    </div>
  );
}

function ConditionRow({ leaf, onChange, onRemove }: { leaf: RuleLeaf; onChange: (leaf: RuleLeaf) => void; onRemove?: () => void }) {
  return (
    <div class="rule-row">
      <select aria-label="Feld" value={leaf.field} onChange={(e) => onChange({ ...leaf, field: (e.target as HTMLSelectElement).value as RuleField })}>
        {Object.entries(RULE_FIELD_LABELS).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <select aria-label="Bedingung" value={leaf.op} onChange={(e) => onChange({ ...leaf, op: (e.target as HTMLSelectElement).value as RuleOp })}>
        {Object.entries(RULE_OP_LABELS).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <input
        aria-label="Suchbegriff"
        value={leaf.value}
        maxLength={200}
        placeholder="z. B. Predigt"
        onInput={(e) => onChange({ ...leaf, value: (e.target as HTMLInputElement).value })}
      />
      {onRemove ? (
        <button type="button" class="icon-button" aria-label="Bedingung entfernen" onClick={onRemove}>
          ×
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

function Preview({ condition }: { condition: RuleCondition }) {
  const complete = isComplete(condition);
  const key = useDebounced(complete ? JSON.stringify(condition) : '', 250);
  const [preview, setPreview] = useState<{ total: number; items: Array<{ id: number; title: string }> }>();

  useEffect(() => {
    if (!key) {
      setPreview(undefined);
      return;
    }
    let active = true;
    adminRequest<typeof preview>('POST', '/api/admin/rules/preview', { condition: JSON.parse(key) })
      .then((result) => active && setPreview(result))
      .catch(() => active && setPreview(undefined));
    return () => {
      active = false;
    };
  }, [key]);

  if (!complete || !preview) return null;
  return (
    <p class="admin-hint" aria-live="polite">
      Trifft {plural(preview.total, 'Titel', 'Titel')}
      {preview.items.length > 0 && `: ${preview.items.slice(0, 5).map((t) => t.title).join(', ')}${preview.total > 5 ? ' …' : ''}`}
    </p>
  );
}
