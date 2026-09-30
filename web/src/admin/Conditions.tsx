/** Wie tief Gruppen verschachtelt werden können (muss zum Server passen) */
const MAX_DEPTH = 4;

/** Eine Bedingung: Feld, Vergleich, Wert (Playlist-Regeln und Policies im Regelwerk) */
export interface Leaf {
  field: string;
  op: string;
  value: string;
}

/** "all" = alle Bedingungen (UND), "any" = mindestens eine (ODER) */
export interface Group {
  match: 'all' | 'any';
  conditions: Condition[];
}

export type Condition = Leaf | Group;

const isGroup = (condition: Condition): condition is Group => 'match' in condition;

export interface ConditionProps {
  /** Felder zur Auswahl: Schlüssel → Beschriftung */
  fields: Record<string, string>;
  /** Vergleiche, die zu einem Feld passen: Schlüssel → Beschriftung */
  ops: (field: string) => Record<string, string>;
  newLeaf: () => Leaf;
  /** Platzhalter im Wertfeld je Feld */
  placeholder?: (field: string) => string;
}

/** Editor für verschachtelte Bedingungen mit UND/ODER */
export function ConditionGroup({
  group,
  depth = 0,
  onChange,
  onRemove,
  ...props
}: ConditionProps & {
  group: Group;
  depth?: number;
  onChange: (group: Group) => void;
  onRemove?: () => void;
}) {
  const set = (index: number, condition: Condition) =>
    onChange({ ...group, conditions: group.conditions.map((c, i) => (i === index ? condition : c)) });
  const remove = (index: number) => onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) });
  const canRemoveChild = group.conditions.length > 1 || depth > 0;
  const newGroup = (match: Group['match']): Group => ({ match, conditions: [props.newLeaf()] });

  return (
    <div class={`rule-group${depth > 0 ? ' is-nested' : ''}`} role="group" aria-label={depth ? 'Bedingungsgruppe' : 'Bedingungen'}>
      <div class="rule-group-head">
        <label class="field">
          <span class="visually-hidden">Verknüpfung</span>
          <select value={group.match} onChange={(e) => onChange({ ...group, match: (e.target as HTMLSelectElement).value as Group['match'] })}>
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
            <ConditionGroup {...props} group={condition} depth={depth + 1} onChange={(c) => set(index, c)} onRemove={() => remove(index)} />
          ) : (
            <ConditionRow {...props} leaf={condition} onChange={(c) => set(index, c)} onRemove={canRemoveChild ? () => remove(index) : undefined} />
          )}
        </div>
      ))}
      <div class="rule-group-add">
        <button type="button" class="button-secondary button-small" onClick={() => onChange({ ...group, conditions: [...group.conditions, props.newLeaf()] })}>
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

function ConditionRow({
  leaf,
  onChange,
  onRemove,
  fields,
  ops,
  placeholder,
}: ConditionProps & { leaf: Leaf; onChange: (leaf: Leaf) => void; onRemove?: () => void }) {
  const options = ops(leaf.field);
  const changeField = (field: string) => {
    // Passt der Vergleich nicht mehr zum Feld (Dauer ↔ Text), den ersten passenden nehmen
    const next = ops(field);
    onChange({ ...leaf, field, op: leaf.op in next ? leaf.op : Object.keys(next)[0]! });
  };
  return (
    <div class="rule-row">
      <select aria-label="Feld" value={leaf.field} onChange={(e) => changeField((e.target as HTMLSelectElement).value)}>
        {Object.entries(fields).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <select aria-label="Bedingung" value={leaf.op} onChange={(e) => onChange({ ...leaf, op: (e.target as HTMLSelectElement).value })}>
        {Object.entries(options).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <input
        aria-label="Suchbegriff"
        value={leaf.value}
        maxLength={200}
        placeholder={placeholder?.(leaf.field) ?? 'z. B. Predigt'}
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

/** Lesbare Form, z. B. Art ist genau „Gottesdienst“ und Inhalt ist genau „Predigt“ */
export function describeCondition(condition: Condition, labels: { fields: Record<string, string>; ops: Record<string, string> }, nested = false): string {
  if (!isGroup(condition)) {
    const unit = condition.field === 'duration' ? ' Min.' : '';
    const value = condition.field === 'duration' ? condition.value : `„${condition.value}“`;
    return `${labels.fields[condition.field] ?? condition.field} ${labels.ops[condition.op] ?? condition.op} ${value}${unit}`;
  }
  const text = condition.conditions.map((c) => describeCondition(c, labels, true)).join(condition.match === 'all' ? ' und ' : ' oder ');
  return nested && condition.conditions.length > 1 ? `(${text})` : text;
}

/** Alle Bedingungen haben einen Wert und keine Gruppe ist leer */
export function isComplete(condition: Condition): boolean {
  return isGroup(condition) ? condition.conditions.length > 0 && condition.conditions.every(isComplete) : condition.value.trim().length > 0;
}

/** Im Editor ist die oberste Ebene immer eine Gruppe, damit sich jederzeit Bedingungen ergänzen lassen. */
export const asGroup = (condition: Condition): Group => (isGroup(condition) ? condition : { match: 'all', conditions: [condition] });
