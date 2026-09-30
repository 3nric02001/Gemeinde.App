import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { formatCompactDate, plural } from '../format';
import { ErrorNote, Loading } from '../pages/common';
import { adminRequest } from './api';

export interface RecordingKind {
  name: string;
  plural: string;
  folder: string;
  folderPattern: string;
  filePattern: string;
  albumTitle: string;
  trackTitle: string;
  sermon: string;
  preferTags: boolean;
}

export interface Structure {
  kinds: RecordingKind[];
  contents: string[];
  /** Inhalte ohne Titel: ein einzelner Teil danach ist der Name ("Begrüßung - Jakob Rauschenberger") */
  untitled: string[];
}

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
      tracks: Array<{ file: string; title: string; content: string | null; matched: boolean }>;
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
  folder: '',
  folderPattern: '{datum}_{anlass}',
  filePattern: '{inhalt} - {titel} - {sprecher}',
  albumTitle: '{anlass}',
  trackTitle: '{inhalt}: {titel}',
  sermon: '',
  preferTags: false,
};

type TextField = Exclude<keyof RecordingKind, 'preferTags'>;

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
  const updateKind = (index: number, patch: Partial<RecordingKind>) =>
    change({ ...draft, kinds: draft.kinds.map((kind, i) => (i === index ? { ...kind, ...patch } : kind)) });
  const moveKind = (index: number, delta: number) => {
    const kinds = [...draft.kinds];
    const [kind] = kinds.splice(index, 1);
    kinds.splice(index + delta, 0, kind!);
    change({ ...draft, kinds });
  };

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
        Hier steht, wie die App Gottesdienste, Bibelstunden und andere Aufnahmen in der Nextcloud erkennt und wie sie Ordner- und
        Dateinamen liest. Es gilt die erste Art, deren Ordner im Pfad vorkommt; eine Art ohne Ordner nimmt alle übrigen Ordner mit
        Datum. Trennzeichen sind austauschbar: „ - “, „_“ und „.“ passen aufeinander. Musik ohne Datum im Ordner bleibt davon
        unberührt.
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
            {text(index, 'folder', 'Erkennen am Ordner', 'Ordnername irgendwo im Pfad; leer: alle übrigen Ordner mit Datum', 'z. B. Bibelstunden')}
            {text(index, 'sermon', 'Inhalt der Predigt', 'Liefert Sprecher und Bibelstelle; leer: alle Aufnahmen', 'z. B. Predigt')}
            {text(index, 'folderPattern', 'Ordnername', 'z. B. 2026_08_30_Einschulung', '{datum}_{anlass}')}
            {text(index, 'filePattern', 'Dateiname (ohne Endung)', 'z. B. Predigt - Der gute Hirte - Pastor Meier', '{inhalt} - {titel} - {sprecher}')}
            {text(index, 'albumTitle', 'Name des Albums', 'Leer oder ohne Wert: der Name der Art', '{anlass}')}
            {text(index, 'trackTitle', 'Titel einer Aufnahme', 'Leere Platzhalter fallen samt Trennern weg', '{inhalt}: {titel}')}
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
