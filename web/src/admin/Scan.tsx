import { useEffect, useState } from 'preact/hooks';
import { plural } from '../format';
import { adminRequest } from './api';

export interface ScanStatus {
  state: 'idle' | 'running' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  filesSeen: number;
  toRead: number;
  read: number;
  added: number;
  updated: number;
  /** Umbenannte oder verschobene Dateien, die Favoriten und Weiterhören behalten */
  moved?: number;
  removed: number;
  failed: number;
  /** Fehlende Titel, die zur Sicherheit noch nicht entfernt wurden */
  heldBack?: number;
  lastError: string | null;
  /** Ende des letzten erfolgreichen Scans, auch über Neustarts hinweg */
  lastSuccessAt: string | null;
  /** Gescannte Ordner in der Nextcloud */
  folders: string[];
}

/** Wie oft der Stand abgefragt wird, solange ein Scan läuft */
export const POLL_MS = 2000;

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'noch nie';

function summary(status: ScanStatus): string {
  if (status.state === 'running') {
    if (status.toRead === 0) return 'Scan läuft: Ordner in der Nextcloud werden gelesen …';
    return `Scan läuft: ${status.read.toLocaleString('de-DE')} von ${plural(status.toRead, 'Datei', 'Dateien')} gelesen`;
  }
  if (status.heldBack) return 'Der letzte Scan wartet auf eine Bestätigung.';
  if (status.state === 'failed') return 'Der letzte Scan ist fehlgeschlagen.';
  const changes = [
    status.added && `${status.added.toLocaleString('de-DE')} neu`,
    status.updated && `${status.updated.toLocaleString('de-DE')} geändert`,
    status.moved && `${status.moved.toLocaleString('de-DE')} verschoben`,
    status.removed && `${status.removed.toLocaleString('de-DE')} entfernt`,
  ].filter(Boolean);
  return `${plural(status.filesSeen, 'Titel', 'Titel')} in der Nextcloud${changes.length ? `, zuletzt ${changes.join(', ')}` : ''}.`;
}

/** Stand des Abgleichs mit der Nextcloud und Knopf für einen sofortigen Scan. */
export function ScanPanel() {
  const [status, setStatus] = useState<ScanStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  // Der Abgleich läuft von selbst; Einzelheiten nur bei Bedarf oder wenn etwas nicht stimmt.
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      setStatus(await adminRequest<ScanStatus>('GET', '/api/scan'));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(), []);
  useEffect(() => {
    if (status?.state !== 'running') return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const start = async (removeMissing = false) => {
    // Wer selbst scannt, will das Ergebnis sehen: Einzelheiten bleiben danach offen.
    setOpen(true);
    if (
      removeMissing &&
      !confirm(
        `${plural(status?.heldBack ?? 0, 'Titel', 'Titel')} aus der Bibliothek entfernen? Favoriten und Weiterhören-Stellen dieser Titel gehen dabei verloren.`,
      )
    ) {
      return;
    }
    try {
      const result = await adminRequest<{ status: Omit<ScanStatus, 'lastSuccessAt' | 'folders'> }>(
        'POST',
        '/api/scan',
        removeMissing ? { removeMissing: true } : undefined,
      );
      setStatus((prev) => ({ ...result.status, lastSuccessAt: prev?.lastSuccessAt ?? null, folders: prev?.folders ?? [] }));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const running = status?.state === 'running';
  const problem = Boolean(
    error || (status && status.state !== 'running' && (status.state === 'failed' || status.failed > 0 || (status.heldBack ?? 0) > 0)),
  );
  const expanded = open || problem || running;
  const scanButton = (
    <button type="button" class="button-secondary" disabled={!status || running} onClick={() => void start()}>
      {running ? 'Scan läuft …' : 'Jetzt scannen'}
    </button>
  );

  if (!expanded) {
    return (
      <section class="admin-panel scan-panel scan-compact" aria-label="Abgleich mit der Nextcloud">
        <p class="scan-line" role="status" onClick={() => status && setOpen(true)}>
          <strong>Nextcloud:</strong>{' '}
          {status ? (
            <>
              {plural(status.filesSeen, 'Titel', 'Titel')} · abgeglichen {when(status.lastSuccessAt)}
            </>
          ) : (
            'wird geladen …'
          )}
        </p>
        <button type="button" class="more-link" disabled={!status} onClick={() => setOpen(true)}>
          Details
        </button>
        {scanButton}
      </section>
    );
  }

  return (
    <section class="admin-panel scan-panel" aria-label="Abgleich mit der Nextcloud">
      <div class="scan-head">
        <div>
          <h2>Abgleich mit der Nextcloud</h2>
          {status && (
            <p class="scan-summary" role="status">
              {summary(status)}
            </p>
          )}
          {status && <p class="admin-hint">Zuletzt erfolgreich: {when(status.lastSuccessAt)}</p>}
          {status && status.folders?.length > 0 && (
            <p class="admin-hint scan-folders">
              Ordner: {status.folders.join(' · ')}
            </p>
          )}
        </div>
        {scanButton}
      </div>
      {status && status.state !== 'running' && status.failed > 0 && (
        <p class="admin-error">{plural(status.failed, 'Datei konnte', 'Dateien konnten')} nicht gelesen werden.</p>
      )}
      {status?.lastError && status.state !== 'running' && (
        <p class={status.state === 'failed' ? 'admin-error' : 'admin-hint'}>
          {status.state === 'failed' ? 'Fehler' : 'Erste Ursache'}: {status.lastError}
        </p>
      )}
      {status && status.state !== 'running' && (status.heldBack ?? 0) > 0 && (
        <div class="scan-held">
          <p class="admin-hint">
            Prüfe zuerst, ob die Ordner in der Nextcloud wirklich leer sind (z. B. externer Speicher nicht eingehängt). Wenn die
            Titel absichtlich gelöscht wurden, hier bestätigen.
          </p>
          <button type="button" class="button-secondary" onClick={() => void start(true)}>
            {plural(status.heldBack ?? 0, 'Titel', 'Titel')} entfernen
          </button>
        </div>
      )}
      {error && (
        <p class="admin-error" role="alert">
          {error}
        </p>
      )}
      {open && !problem && !running && (
        <button type="button" class="more-link scan-less" onClick={() => setOpen(false)}>
          Weniger anzeigen
        </button>
      )}
    </section>
  );
}
