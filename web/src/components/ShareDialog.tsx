import { useEffect, useState } from 'preact/hooks';
import { fetchPeople, sharePlaylist, type Person } from '../playlists';
import { showToast } from '../share';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

/** Ohne Groß/Klein und Akzente vergleichen */
const foldSearch = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** Eigene Playlist mit anderen Benutzern der App teilen; die sehen sie unter "Geteilt mit mir" und hören nur zu. */
export function ShareDialog({
  playlist,
  onClose,
  onSaved,
}: {
  playlist: { id: number; title: string; sharedWith: Person[] };
  onClose: () => void;
  onSaved: (sharedWith: Person[]) => void;
}) {
  const [people, setPeople] = useState<Person[]>();
  const [chosen, setChosen] = useState(() => new Set(playlist.sharedWith.map((p) => p.id)));
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchPeople()
      .then(setPeople)
      .catch((err: Error) => setError(err.message));
  }, []);

  const toggle = (id: number) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const sharedWith = await sharePlaylist(playlist.id, [...chosen]);
      onSaved(sharedWith);
      showToast(sharedWith.length ? `Geteilt mit ${sharedWith.length === 1 ? sharedWith[0]!.name : `${sharedWith.length} Personen`}` : 'Nicht mehr geteilt');
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const needle = foldSearch(filter);
  const shown = (people ?? []).filter((person) => !needle || foldSearch(person.name).includes(needle));
  return (
    <Dialog title={`„${playlist.title}“ teilen`} onClose={onClose}>
      <p class="dialog-sub">Die ausgewählten Personen finden die Playlist unter „Geteilt mit mir“ und können sie anhören, aber nicht ändern.</p>
      {people && people.length > 8 && (
        <label class="field">
          <span class="sr-only">Person suchen</span>
          <input type="search" placeholder="Name suchen" value={filter} onInput={(event) => setFilter((event.target as HTMLInputElement).value)} />
        </label>
      )}
      {people && !people.length && <p class="dialog-sub">Außer dir nutzt noch niemand die App.</p>}
      <ul class="pick-list">
        {shown.map((person) => (
          <li key={person.id}>
            <label class={`pick-row${chosen.has(person.id) ? ' is-on' : ''}`}>
              <input type="checkbox" class="sr-only" checked={chosen.has(person.id)} onChange={() => toggle(person.id)} />
              <span class="profile-avatar pick-avatar" aria-hidden="true">
                {[...person.name.trim()][0]?.toUpperCase() ?? '?'}
              </span>
              <span class="pick-text">
                <strong>{person.name}</strong>
              </span>
              <span class="pick-check" aria-hidden="true">
                {chosen.has(person.id) && <Icon name="check" size={18} />}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      <div class="dialog-actions">
        <button type="button" class="button-secondary" onClick={onClose}>
          Abbrechen
        </button>
        <button type="button" class="button-primary" disabled={busy || !people} onClick={() => void save()}>
          Speichern
        </button>
      </div>
    </Dialog>
  );
}
