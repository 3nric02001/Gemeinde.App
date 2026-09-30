import { useEffect, useState } from 'preact/hooks';
import { coverUrl, query, type Page, type Track } from '../api';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { albumTitle, formatCompactDate, formatDuration, formatTime, plural, serviceLine, withoutDate } from '../format';
import { useDebounced } from '../hooks';
import { navigate } from '../router';
import { ErrorNote, Loading } from '../pages/common';
import {
  adminRequest,
  adminUpload,
  type AdminAlbum,
  type AdminAlbumDetail,
  type AlbumFields,
  type Change,
  type TrackEdit,
  type TrackFields,
} from './api';
import { Rules } from './Rules';
import { Switch } from './Switch';

interface Props {
  id: number;
  onError: (error: Error) => void;
}

/** Bildformate, die der Server beim Hochladen annimmt */
const COVER_TYPES = 'image/jpeg,image/png,image/webp';

/** "Zuletzt geändert von Anna Beispiel am 29.09.2026, 22:13: Album bearbeitet (Sprecher)" */
export function describeLastChange(change: Change): string {
  const when = new Date(change.at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  return `Zuletzt geändert von ${change.userName} am ${when}: ${change.action}`;
}

export function AlbumEditor({ id, onError }: Props) {
  const [album, setAlbum] = useState<AdminAlbumDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<number | undefined>();
  // Das Cover bleibt einen Tag im Browser-Cache; nach dem Hochladen die neue Fassung erzwingen.
  const [coverVersion, setCoverVersion] = useState(0);
  // Jeder neue Stand vom Server setzt das Formular darauf zurück.
  const [revision, setRevision] = useState(0);

  /** Führt eine Änderung aus; der Server antwortet mit dem neuen Stand des Albums. */
  const run = async (action: () => Promise<AdminAlbumDetail | void>) => {
    setBusy(true);
    try {
      const next = await action();
      if (next) {
        setAlbum(next);
        setRevision((r) => r + 1);
      }
      setError(undefined);
      return true;
    } catch (e) {
      onError(e as Error);
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => void run(() => adminRequest<AdminAlbumDetail>('GET', `/api/admin/albums/${id}`)), [id]);

  if (!album) return error ? <ErrorNote message={error} /> : <Loading />;

  const manual = album.kind === 'manual';
  const dated = Boolean(album.date);
  const name = albumTitle(album.title, album.date, album.recording);
  const base = `/api/admin/albums/${id}`;
  const ids = album.tracks.map((t) => t.id);
  const viaRule = new Set(album.ruleTrackIds);
  const edits = new Map(album.trackEdits.map((edit) => [edit.id, edit]));

  const move = (index: number, delta: number) => {
    const order = [...ids];
    const [item] = order.splice(index, 1);
    order.splice(index + delta, 0, item!);
    void run(() => adminRequest('PUT', `${base}/tracks`, { trackIds: order }));
  };
  const toggle = (trackId: number) => {
    const next = new Set(selected);
    if (next.has(trackId)) next.delete(trackId);
    else next.add(trackId);
    setSelected(next);
  };
  const changeCover = (file: File | null) =>
    void run(async () => {
      const next = file
        ? await adminUpload<AdminAlbumDetail>(`${base}/cover`, file)
        : await adminRequest<AdminAlbumDetail>('DELETE', `${base}/cover`);
      setCoverVersion(Date.now());
      return next;
    });

  return (
    <>
      <a class="more-link admin-back" href="/admin">
        <Icon name="back" size={16} /> Alle Alben
      </a>
      {/* Kopf wie bei den Hörern, damit man sieht, was man bearbeitet */}
      <header class="hero admin-hero">
        <div class="admin-cover">
          <Cover
            src={album.hasCover ? `${coverUrl(album.id)}${coverVersion ? `?v=${coverVersion}` : ''}` : undefined}
            title={name}
            date={album.date}
            class="cover-hero"
            eager
          />
          <div class="admin-cover-actions">
            <label class={`button-secondary button-small admin-file${busy ? ' is-disabled' : ''}`}>
              {album.customCover ? 'Bild ersetzen' : 'Bild hochladen'}
              <input
                type="file"
                accept={COVER_TYPES}
                disabled={busy}
                onChange={(e) => {
                  const input = e.target as HTMLInputElement;
                  const file = input.files?.[0];
                  input.value = '';
                  if (file) changeCover(file);
                }}
              />
            </label>
            {album.customCover && (
              <button type="button" class="more-link" disabled={busy} onClick={() => changeCover(null)}>
                Eigenes Bild entfernen
              </button>
            )}
          </div>
        </div>
        <div class="hero-text">
          <span class="eyebrow">{dated ? album.recording || 'Gottesdienst' : manual ? 'Playlist' : 'Automatisches Album'}</span>
          <h1>{name}</h1>
          <p class="hero-sub">{[dated ? serviceLine(album.date!) : album.year, album.speaker].filter(Boolean).join(' · ')}</p>
          <p class="hero-meta">
            {plural(album.trackCount, 'Titel', 'Titel')}, {formatDuration(album.duration)}
          </p>
          <div class="admin-visibility">
            <Switch
              checked={!album.hidden}
              disabled={busy}
              label="Für Hörer sichtbar"
              onChange={(visible) => void run(() => adminRequest('PATCH', base, { hidden: !visible }))}
            />
            {album.hidden ? (
              <span class="admin-hint">Hörer finden dieses Album nicht, z. B. weil die Titel jetzt in Playlists stehen.</span>
            ) : (
              <a class="button-secondary button-small" href={`/album/${album.id}`}>
                Ansehen
              </a>
            )}
          </div>
          {album.lastChange && <p class="admin-hint admin-last">{describeLastChange(album.lastChange)}</p>}
        </div>
      </header>

      {error && <p class="admin-error" role="alert">{error}</p>}

      <DetailsForm key={revision} album={album} busy={busy} onSave={(fields) => run(() => adminRequest('PATCH', base, fields))} />
      {album.kind === 'auto' && (
        <KindForm album={album} busy={busy} onSave={(recording) => run(() => adminRequest('PATCH', base, { recording }))} />
      )}

      <section class="shelf">
        <div class="section-head">
          <h2>Titel</h2>
          {selected.size > 0 && (
            <div class="admin-selection">
              <span>{selected.size} ausgewählt</span>
              <button type="button" class="button-secondary" onClick={() => setPicking(true)}>
                Zu Playlist hinzufügen
              </button>
              <button type="button" class="more-link" onClick={() => setSelected(new Set())}>
                Auswahl aufheben
              </button>
            </div>
          )}
        </div>
        {album.tracks.length === 0 ? (
          <p class="admin-hint">{manual ? 'Noch keine Titel. Füge unten welche hinzu.' : 'Alle Titel wurden herausgenommen.'}</p>
        ) : (
          <>
            <p class="admin-hint admin-tracks-hint">
              Mit dem Stift korrigierst du Name, Sprecher, Predigt und Player eines Titels. Mit den Häkchen wählst du Titel aus, um sie in eine
              Playlist zu übernehmen.
            </p>
            <ol class="admin-tracks">
              {album.tracks.map((track, index) => {
                const edit = edits.get(track.id);
                const corrected = Boolean(edit && (edit.title || edit.speaker));
                return [
                  <li key={track.id} class="admin-track">
                    <input
                      type="checkbox"
                      checked={selected.has(track.id)}
                      aria-label={`${track.title} auswählen`}
                      onChange={() => toggle(track.id)}
                    />
                    <span class="track-no">{index + 1}</span>
                    <span class="track-main">
                      <span class="track-title">
                        {track.title}
                        {corrected && <span class="badge badge-muted admin-inline-badge">korrigiert</span>}
                      </span>
                      <span class="track-sub">
                        {[track.speaker, track.album && track.album !== album.title ? track.album : null].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span class="track-time">
                      {viaRule.has(track.id) && <span class="badge badge-muted" title="Über eine Regel im Album">Regel</span>}{' '}
                      {track.player && (
                        <span class="badge badge-muted" title={policySource(edit, 'player')}>
                          {track.player === 'sermon' ? 'Predigt-Player' : 'Musik-Player'}
                        </span>
                      )}{' '}
                      {formatTime(track.duration)}
                    </span>
                    <span class="admin-track-actions">
                      <button
                        type="button"
                        class="icon-button"
                        aria-label={`${track.title} bearbeiten`}
                        aria-expanded={editing === track.id}
                        title="Name, Sprecher und Player bearbeiten"
                        disabled={busy}
                        onClick={() => setEditing(editing === track.id ? undefined : track.id)}
                      >
                        <Icon name="edit" size={18} />
                      </button>
                      {manual && (
                        <>
                          <button type="button" class="icon-button" aria-label="Nach oben" disabled={busy || index === 0} onClick={() => move(index, -1)}>
                            <Icon name="down" size={18} class="flip" />
                          </button>
                          <button
                            type="button"
                            class="icon-button"
                            aria-label="Nach unten"
                            disabled={busy || index === album.tracks.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            <Icon name="down" size={18} />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        class="icon-button"
                        aria-label={manual ? `${track.title} entfernen` : `${track.title} aus dem Album nehmen`}
                        title={manual ? 'Entfernen' : 'Aus dem Album nehmen'}
                        disabled={busy}
                        onClick={() => void run(() => adminRequest('DELETE', `${base}/tracks/${track.id}`))}
                      >
                        <Icon name="close" size={18} />
                      </button>
                    </span>
                  </li>,
                  editing === track.id && (
                    <li key={`${track.id}-edit`} class="admin-track-edit">
                      <TrackForm
                        track={track}
                        edit={edit}
                        recording={Boolean(album.recording)}
                        busy={busy}
                        onCancel={() => setEditing(undefined)}
                        onSave={async (fields) => {
                          if (await run(() => adminRequest('PATCH', `${base}/tracks/${track.id}`, fields))) setEditing(undefined);
                        }}
                      />
                    </li>
                  ),
                ];
              })}
            </ol>
          </>
        )}
      </section>
      {album.excluded.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Herausgenommen</h2>
          </div>
          <p class="admin-hint">Diese Titel gehören laut Ordner zu diesem Album, werden hier aber nicht angezeigt.</p>
          <ul class="admin-tracks">
            {album.excluded.map((track) => (
              <li key={track.id} class="admin-track admin-track-plain">
                <span class="track-main">
                  <span class="track-title">{track.title}</span>
                </span>
                <span class="track-time">{formatTime(track.duration)}</span>
                <button
                  type="button"
                  class="button-secondary button-small"
                  disabled={busy}
                  onClick={() => void run(() => adminRequest('POST', `${base}/tracks/${track.id}/restore`))}
                >
                  Zurückholen
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {album.missing.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Derzeit nicht in der Nextcloud</h2>
          </div>
          <p class="admin-hint">Sobald die Dateien wieder da sind, erscheinen sie nach dem nächsten Scan automatisch im Album.</p>
          <ul class="admin-paths">
            {album.missing.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </section>
      )}

      {album.movedByRule.length > 0 && (
        <section class="shelf">
          <div class="section-head">
            <h2>Durch Regeln verschoben</h2>
          </div>
          <p class="admin-hint">Diese Titel stehen jetzt in Playlists. Ändern lässt sich das über die Regel dort.</p>
          <ul class="admin-tracks">
            {album.movedByRule.map((track) => (
              <li key={track.id} class="admin-track admin-track-plain">
                <span class="track-main">
                  <span class="track-title">{track.title}</span>
                </span>
                <a class="more-link" href={`/admin/album/${track.albumId}`}>
                  {track.albumTitle}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {manual && (
        <Rules
          album={album}
          busy={busy}
          onSave={(rule, ruleId) =>
            run(() =>
              ruleId === undefined
                ? adminRequest('POST', `${base}/rules`, rule)
                : adminRequest('PUT', `${base}/rules/${ruleId}`, rule),
            )
          }
          onDelete={(ruleId) => run(() => adminRequest('DELETE', `${base}/rules/${ruleId}`))}
        />
      )}

      {manual && (
        <AddTracks
          albumId={id}
          existing={new Set(ids)}
          busy={busy}
          onAdd={(trackIds, move) => run(() => adminRequest('POST', `${base}/tracks`, { trackIds, move }))}
        />
      )}

      {manual && (
        <section class="shelf admin-danger">
          <button
            type="button"
            class="button-secondary"
            disabled={busy}
            onClick={() => {
              if (!confirm(`Playlist „${album.title}“ löschen? Die Titel selbst bleiben erhalten.`)) return;
              void run(async () => {
                await adminRequest('DELETE', base);
                navigate('/admin');
              });
            }}
          >
            Playlist löschen
          </button>
        </section>
      )}

      {picking && (
        <AddToAlbum
          source={album}
          trackIds={ids.filter((trackId) => selected.has(trackId))}
          onClose={(done) => {
            setPicking(false);
            if (done) {
              setSelected(new Set());
              void run(() => adminRequest('GET', `/api/admin/albums/${id}`));
            }
          }}
          onError={onError}
        />
      )}
    </>
  );
}

// Sprecher gibt es nur je Titel: ein Gottesdienst hat oft mehrere.
const TEXT_FIELDS = ['title', 'passage', 'description'] as const;
type FieldName = (typeof TEXT_FIELDS)[number] | 'year';
/** Ohne Anlass heißt eine Aufnahme wie ihre Art, etwa „Gottesdienst“ (siehe albumTitle) */
const noOccasion = (album: AdminAlbumDetail) => album.recording || 'Gottesdienst';

function DetailsForm({ album, busy, onSave }: { album: AdminAlbumDetail; busy: boolean; onSave: (fields: Partial<AlbumFields>) => void }) {
  const dated = Boolean(album.date);
  const manual = album.kind === 'manual';
  // Bei Gottesdiensten bearbeitet man den Anlass; das Datum steckt im Ordnernamen.
  const shown = (name: (typeof TEXT_FIELDS)[number]) => (name === 'title' && dated ? withoutDate(album.title) : (album[name] ?? ''));
  const initial = () => ({
    title: shown('title'),
    year: album.year ? String(album.year) : '',
    passage: album.passage ?? '',
    description: album.description ?? '',
  });
  const [form, setForm] = useState(initial);

  // Nur geänderte Felder senden: Was nicht angefasst wird, bleibt automatisch.
  const changes: Partial<AlbumFields> = {};
  for (const name of TEXT_FIELDS) {
    if (form[name].trim() === shown(name)) continue;
    changes[name] = form[name].trim() || (name === 'title' && dated ? noOccasion(album) : null);
  }
  if (form.year.trim() !== (album.year ? String(album.year) : '')) changes.year = form.year.trim() ? Number(form.year) : null;
  const yearValid = !form.year.trim() || /^\d{4}$/.test(form.year.trim());
  const dirty = Object.keys(changes).length > 0;
  const overridden = Object.values(album.overrides).some((value) => value !== null);
  // Predigt-Felder bei Musik nur, wenn dort schon etwas steht
  const sermon = dated || Boolean(album.passage);

  /** Woher ein Wert kommt; bei automatischen Alben mit „Zurücksetzen“ für Korrekturen */
  const source = (name: FieldName) => {
    if (manual) return null;
    if (album.overrides[name] !== null) {
      return (
        <p class="field-source">
          Von Hand geändert ·{' '}
          <button type="button" class="link-button" disabled={busy} onClick={() => onSave({ [name]: null })}>
            Zurücksetzen
          </button>
        </p>
      );
    }
    if (!form[name] || form[name] !== initial()[name]) return null;
    return <p class="field-source">{name === 'title' || name === 'year' ? 'Aus dem Ordnernamen' : 'Aus den Dateinamen'}</p>;
  };
  const field = (name: FieldName, text: string, props: Record<string, unknown> = {}) => (
    <div class="field-wrap">
      <label class="field">
        <span>{text}</span>
        <input
          value={form[name]}
          onInput={(e) => setForm({ ...form, [name]: (e.target as HTMLInputElement).value })}
          {...props}
        />
      </label>
      {source(name)}
    </div>
  );
  const passages = field('passage', 'Bibelstellen', { maxLength: 200, placeholder: 'z. B. Psalm 23; Joh 3,16' });
  const description = (
    <div class="field-wrap">
      <label class="field">
        <span>Beschreibung für Hörer</span>
        <textarea
          rows={3}
          maxLength={2000}
          value={form.description}
          placeholder={dated ? 'Ein, zwei Sätze zum Gottesdienst oder zur Predigt' : manual ? 'Ein, zwei Sätze zur Playlist' : 'Ein, zwei Sätze zum Album'}
          onInput={(e) => setForm({ ...form, description: (e.target as HTMLTextAreaElement).value })}
        />
      </label>
      {source('description')}
    </div>
  );

  return (
    <form
      class="admin-panel admin-form admin-form-wide"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && yearValid) onSave(changes);
      }}
    >
      {dated ? (
        <>
          <div class="admin-fields admin-fields-2">
            {field('title', 'Anlass', { maxLength: 200, placeholder: noOccasion(album) })}
            <div class="field-wrap">
              <div class="field">
                <span>Datum</span>
                <p class="field-static">{formatCompactDate(album.date!)}</p>
              </div>
              <p class="field-source">
                Aus dem Ordner „{album.folder.split('/').pop()}“. Zum Ändern den Ordner in der Nextcloud umbenennen.
              </p>
            </div>
          </div>
          {passages}
          {description}
        </>
      ) : (
        <>
          <div class="admin-fields">
            {field('title', 'Titel', { maxLength: 200, required: manual })}
            {field('year', 'Jahr', { inputMode: 'numeric', maxLength: 4, placeholder: 'Automatisch' })}
          </div>
          {sermon && passages}
          {description}
        </>
      )}
      <div class="actions">
        <button type="submit" class="button-primary" disabled={busy || !dirty || !yearValid}>
          Speichern
        </button>
        {dirty && (
          <button type="button" class="button-secondary" onClick={() => setForm(initial())}>
            Verwerfen
          </button>
        )}
        {!manual && overridden && !dirty && (
          <button
            type="button"
            class="button-secondary"
            disabled={busy}
            onClick={() =>
              onSave({ title: null, year: null, speaker: null, passage: null, description: null })
            }
          >
            Alles zurücksetzen
          </button>
        )}
        {!yearValid && <span class="admin-error">Jahr bitte vierstellig</span>}
      </div>
    </form>
  );
}

const AUTOMATIC = '\u0000auto';

/** Woher die Art eines Albums kommt, in Worten */
function kindSource(album: AdminAlbumDetail): string {
  const source = album.recordingSource;
  if (album.manualRecording != null || source?.by === 'manual') return 'Von Hand festgelegt, geht dem Regelwerk vor';
  if (source?.by === 'rule') return `Aus der Regel „${source.rule}“ in Verwaltung → Zuordnung → Art bestimmen`;
  if (source?.by === 'default') return 'Keine Regel passt: Vorgabe für Ordner mit Datum (Verwaltung → Zuordnung)';
  return 'Keine Regel in Verwaltung → Zuordnung → Art bestimmen passt';
}

/**
 * Art des Albums (Gottesdienst, Bibelstunde, eigene Arten aus Verwaltung → Zuordnung) von Hand festlegen.
 * Das geht den Bedingungen der Arten vor; „Keine Art“ macht aus einer Aufnahme wieder Musik.
 */
function KindForm({ album, busy, onSave }: { album: AdminAlbumDetail; busy: boolean; onSave: (recording: string | null) => void }) {
  const [kinds, setKinds] = useState<string[]>();
  useEffect(() => {
    adminRequest<{ structure: { kinds: Array<{ name: string }> } }>('GET', '/api/admin/structure')
      .then((body) => setKinds(body.structure.kinds.map((kind) => kind.name)))
      .catch(() => setKinds([]));
  }, []);
  const manual = album.manualRecording ?? null;
  const value = manual === null ? AUTOMATIC : manual;
  // Eine Art, die es im Regelwerk nicht mehr gibt, bleibt sichtbar, bis sie geändert wird
  const names = [...(kinds ?? []), ...(manual && kinds && !kinds.includes(manual) ? [manual] : [])];
  return (
    <div class="admin-panel admin-form admin-kind">
      <div class="field-wrap">
        <label class="field">
          <span>Art</span>
          <select
            value={value}
            disabled={busy || !kinds}
            onChange={(e) => {
              const next = (e.target as HTMLSelectElement).value;
              onSave(next === AUTOMATIC ? null : next);
            }}
          >
            <option value={AUTOMATIC}>Automatisch{manual === null && album.recording ? ` (${album.recording})` : manual === null ? ' (Musik)' : ''}</option>
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value="">Keine Art (Musik)</option>
          </select>
        </label>
        <p class="field-source">{kindSource(album)}</p>
      </div>
    </div>
  );
}

const PLAYER_NAMES = { sermon: 'Predigt-Player', music: 'Musik-Player' } as const;

/** Woher Predigt oder Player eines Titels kommen: Korrektur, Policy oder Länge */
function policySource(edit: TrackEdit | undefined, effect: 'sermon' | 'player'): string {
  if (edit?.[effect] !== null && edit?.[effect] !== undefined) return 'Von Hand festgelegt';
  const by = effect === 'sermon' ? edit?.auto?.sermonBy : edit?.auto?.playerBy;
  if (by) return `Policy „${by}“`;
  return effect === 'player' ? 'Keine Policy: nach Länge (ab 10 Minuten Predigt-Player)' : 'Keine Policy';
}

/** Was die Policies ergeben, als Text für „Automatisch (…)“ */
function autoLabel(edit: TrackEdit | undefined, effect: 'sermon' | 'player'): string {
  if (effect === 'sermon') {
    const value = edit?.auto?.sermon ? 'ja' : 'nein';
    return edit?.auto?.sermonBy ? `${value}, Policy „${edit.auto.sermonBy}“` : `${value}, keine Policy`;
  }
  const player = edit?.auto?.player;
  return player ? `${PLAYER_NAMES[player]}, Policy „${edit!.auto!.playerBy}“` : 'nach Länge, keine Policy';
}

/** Name, Sprecher, Predigt und Player eines einzelnen Titels korrigieren; leer heißt: wie in der Datei bzw. nach den Policies. */
function TrackForm({
  track,
  edit,
  recording,
  busy,
  onSave,
  onCancel,
}: {
  track: Track;
  edit: TrackEdit | undefined;
  /** Album ist eine Aufnahme (Gottesdienst …): dann zählt „gilt als Predigt“ */
  recording: boolean;
  busy: boolean;
  onSave: (fields: TrackFields) => void;
  onCancel: () => void;
}) {
  const currentSpeaker = edit?.speaker ?? edit?.fileSpeaker ?? '';
  const [title, setTitle] = useState(track.title);
  const [speaker, setSpeaker] = useState(currentSpeaker);
  const [sermon, setSermon] = useState<boolean | null>(edit?.sermon ?? null);
  const [playerChoice, setPlayerChoice] = useState<'sermon' | 'music' | null>(edit?.player ?? null);
  const changes: TrackFields = {};
  if (title.trim() !== track.title) changes.title = title.trim() || null;
  if (speaker.trim() !== currentSpeaker) changes.speaker = speaker.trim() || null;
  if (sermon !== (edit?.sermon ?? null)) changes.sermon = sermon;
  if (playerChoice !== (edit?.player ?? null)) changes.player = playerChoice;
  const corrected = Boolean(edit?.title || edit?.speaker || (edit?.sermon ?? null) !== null || (edit?.player ?? null) !== null);

  return (
    <form
      class="admin-track-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (Object.keys(changes).length) onSave(changes);
      }}
    >
      <div class="admin-fields admin-fields-2">
        <div class="field-wrap">
          <label class="field">
            <span>Name</span>
            <input value={title} maxLength={300} placeholder={edit?.fileTitle} autoFocus onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          </label>
          {edit?.title && <p class="field-source">Automatisch: „{edit.fileTitle}“</p>}
          {edit?.auto?.contentBy && (
            <p class="field-source">
              Inhalt „{edit.auto.content}“ laut Policy „{edit.auto.contentBy}“
            </p>
          )}
        </div>
        <div class="field-wrap">
          <label class="field">
            <span>Sprecher</span>
            <input
              value={speaker}
              maxLength={200}
              placeholder={edit?.fileSpeaker ?? 'z. B. Pastor Meier'}
              onInput={(e) => setSpeaker((e.target as HTMLInputElement).value)}
            />
          </label>
          {edit?.speaker && <p class="field-source">Automatisch: {edit.fileSpeaker ? `„${edit.fileSpeaker}“` : 'kein Sprecher'}</p>}
        </div>
        {recording && (
          <div class="field-wrap">
            <label class="field">
              <span>Gilt als Predigt</span>
              <select
                value={sermon === null ? '' : sermon ? 'yes' : 'no'}
                onChange={(e) => {
                  const value = (e.target as HTMLSelectElement).value;
                  setSermon(value === '' ? null : value === 'yes');
                }}
              >
                <option value="">Automatisch ({autoLabel(edit, 'sermon')})</option>
                <option value="yes">Ja, liefert Sprecher und Bibelstelle</option>
                <option value="no">Nein</option>
              </select>
            </label>
          </div>
        )}
        <div class="field-wrap">
          <label class="field">
            <span>Player</span>
            <select
              value={playerChoice ?? ''}
              onChange={(e) => setPlayerChoice(((e.target as HTMLSelectElement).value || null) as 'sermon' | 'music' | null)}
            >
              <option value="">Automatisch ({autoLabel(edit, 'player')})</option>
              <option value="sermon">Predigt-Player</option>
              <option value="music">Musik-Player</option>
            </select>
          </label>
        </div>
      </div>
      <p class="admin-hint">Die Korrektur bleibt auch nach neuen Scans erhalten; die Datei in der Nextcloud ändert sich nicht.</p>
      <div class="actions">
        <button type="submit" class="button-primary button-small" disabled={busy || !Object.keys(changes).length}>
          Speichern
        </button>
        <button type="button" class="button-secondary button-small" onClick={onCancel}>
          Abbrechen
        </button>
        {corrected && (
          <button
            type="button"
            class="more-link"
            disabled={busy}
            onClick={() => onSave({ title: null, speaker: null, sermon: null, player: null })}
          >
            Alles automatisch
          </button>
        )}
      </div>
    </form>
  );
}

function AddTracks({
  albumId,
  existing,
  busy,
  onAdd,
}: {
  albumId: number;
  existing: Set<number>;
  busy: boolean;
  onAdd: (trackIds: number[], move: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [move, setMove] = useState(false);
  const q = useDebounced(text.trim(), 200);
  const [results, setResults] = useState<Track[] | undefined>();
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!q) {
      setResults(undefined);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/tracks${query({ q, limit: 50 })}`, { signal: controller.signal })
      .then((res) => res.json() as Promise<Page<Track>>)
      .then((page) => {
        setResults(page.items);
        setTotal(page.total);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [q, albumId]);

  const addable = (results ?? []).filter((t) => !existing.has(t.id));

  return (
    <section class="shelf admin-panel">
      <div class="section-head">
        <h2>Titel hinzufügen</h2>
      </div>
      <form class="search-box" role="search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={20} />
        <input
          type="search"
          value={text}
          placeholder="Titel, Sprecher oder Album suchen"
          aria-label="Titel zum Hinzufügen suchen"
          autocomplete="off"
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
      </form>
      <label class="admin-check">
        <input type="checkbox" checked={move} onChange={(e) => setMove((e.target as HTMLInputElement).checked)} />
        Aus ihrem automatischen Album herausnehmen (verschieben statt zusätzlich eintragen)
      </label>
      {results && (
        <>
          <div class="admin-results-head">
            <span class="count">
              {plural(total, 'Treffer', 'Treffer')}
              {total > results.length && `, die ersten ${results.length} angezeigt`}
            </span>
            {addable.length > 1 && (
              <button type="button" class="button-secondary button-small" disabled={busy} onClick={() => onAdd(addable.map((t) => t.id), move)}>
                Alle {addable.length} hinzufügen
              </button>
            )}
          </div>
          <ul class="admin-tracks">
            {results.map((track) => (
              <li key={track.id} class="admin-track admin-track-plain">
                <span class="track-main">
                  <span class="track-title">{track.title}</span>
                  <span class="track-sub">{[track.speaker, track.album].filter(Boolean).join(' · ')}</span>
                </span>
                <span class="track-time">{formatTime(track.duration)}</span>
                {existing.has(track.id) ? (
                  <span class="badge badge-muted">Im Album</span>
                ) : (
                  <button type="button" class="button-secondary button-small" disabled={busy} onClick={() => onAdd([track.id], move)}>
                    Hinzufügen
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Dialog: ausgewählte Titel in eine bestehende oder neue Playlist übernehmen. */
function AddToAlbum({
  source,
  trackIds,
  onClose,
  onError,
}: {
  source: AdminAlbumDetail;
  trackIds: number[];
  onClose: (done: boolean) => void;
  onError: (error: Error) => void;
}) {
  const [targets, setTargets] = useState<AdminAlbum[] | undefined>();
  const [target, setTarget] = useState<number | 'new'>('new');
  const [title, setTitle] = useState('');
  const [move, setMove] = useState(source.kind === 'auto');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminRequest<Page<AdminAlbum>>('GET', '/api/admin/albums?kind=manual&sort=title&limit=500')
      .then((page) => {
        const others = page.items.filter((a) => a.id !== source.id);
        setTargets(others);
        if (others.length) setTarget(others[0]!.id);
      })
      .catch((e: Error) => {
        onError(e);
        setError(e.message);
      });
  }, []);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (target === 'new') await adminRequest('POST', '/api/admin/albums', { title: title.trim(), trackIds, move });
      else await adminRequest('POST', `/api/admin/albums/${target}/tracks`, { trackIds, move });
      onClose(true);
    } catch (e) {
      onError(e as Error);
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="admin-dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose(false)}>
      <form class="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="add-to-album" onSubmit={submit}>
        <h2 id="add-to-album">{plural(trackIds.length, 'Titel', 'Titel')} zu Playlist hinzufügen</h2>
        {!targets ? (
          <Loading />
        ) : (
          <label class="field">
            <span>Playlist</span>
            <select value={String(target)} onChange={(e) => {
              const value = (e.target as HTMLSelectElement).value;
              setTarget(value === 'new' ? 'new' : Number(value));
            }}>
              {targets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
              <option value="new">Neue Playlist …</option>
            </select>
          </label>
        )}
        {target === 'new' && (
          <label class="field">
            <span>Name der neuen Playlist</span>
            <input value={title} maxLength={200} placeholder="z. B. Predigten" autoFocus onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          </label>
        )}
        <label class="admin-check">
          <input type="checkbox" checked={move} onChange={(e) => setMove((e.target as HTMLInputElement).checked)} />
          {source.kind === 'auto'
            ? `Aus „${source.title}“ herausnehmen (verschieben)`
            : 'Aus ihrem automatischen Album herausnehmen'}
        </label>
        {error && <p class="admin-error" role="alert">{error}</p>}
        <div class="actions">
          <button type="submit" class="button-primary" disabled={busy || !targets || (target === 'new' && !title.trim())}>
            Hinzufügen
          </button>
          <button type="button" class="button-secondary" onClick={() => onClose(false)}>
            Abbrechen
          </button>
        </div>
      </form>
    </div>
  );
}
