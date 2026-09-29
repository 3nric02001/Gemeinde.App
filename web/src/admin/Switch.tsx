/** Schalter für An/Aus-Einstellungen (Sichtbarkeit, Anmeldung erlaubt); technisch eine Checkbox mit role="switch". */
export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label class={`switch${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="switch-track" aria-hidden="true" />
      <span class="switch-label">{label}</span>
    </label>
  );
}
