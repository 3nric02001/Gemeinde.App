import { useEffect, useState } from 'preact/hooks';
import { plural } from '../format';
import { useDebounced } from '../hooks';
import { ConditionGroup } from './Conditions';
import {
  adminRequest,
  describeRule,
  isComplete,
  isGroup,
  RULE_FIELD_LABELS,
  RULE_OP_LABELS,
  type AdminAlbumDetail,
  type RuleCondition,
  type RuleGroup,
  type RuleLeaf,
} from './api';

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
        Alle Titel, auf die eine Regel passt, kommen automatisch in diese Playlist, auch solche, die später in die Nextcloud
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
        <ConditionGroup
          group={editing.condition}
          fields={RULE_FIELD_LABELS}
          ops={() => RULE_OP_LABELS}
          newLeaf={newLeaf}
          onChange={(condition) => setEditing({ ...editing, condition: condition as RuleGroup })}
        />
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
