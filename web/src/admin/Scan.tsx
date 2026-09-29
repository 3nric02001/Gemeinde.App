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
  removed: number;
  failed: number;
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
  if (status.state === 'failed') return 'Der letzte Scan ist fehlgeschlagen.';
  const changes = [
    status.added && `${status.added.toLocaleString('de-DE')} neu`,
    status.updated && `${status.updated.toLocaleString('de-DE')} geändert`,
    status.removed && `${status.removed.toLocaleString('de-DE')} entfernt`,
  ].filter(Boolean);
  return `${plural(status.filesSeen, 'Titel', 'Titel')} in der Nextcloud${changes.length ? `, zuletzt ${changes.join(', ')}` : ''}.`;
}

/** Stand des Abgleichs mit der Nextcloud und Knopf für einen sofortigen Scan. */
export function ScanPanel() {
  const [status, setStatus] = useState<ScanStatus | undefined>();
  const [error, setError] = useState<string | undefined>();

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

  const start = async () => {
    try {
      const result = await adminRequest<{ status: Omit<ScanStatus, 'lastSuccessAt' | 'folders'> }>('POST', '/api/scan');
      setStatus((prev) => ({ ...result.status, lastSuccessAt: prev?.lastSuccessAt ?? null, folders: prev?.folders ?? [] }));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const running = status?.state === 'running';
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
        <button type="button" class="button-secondary" disabled={!status || running} onClick={() => void start()}>
          {running ? 'Scan läuft …' : 'Jetzt scannen'}
        </button>
      </div>
      {status && status.state !== 'running' && status.failed > 0 && (
        <p class="admin-error">{plural(status.failed, 'Datei konnte', 'Dateien konnten')} nicht gelesen werden.</p>
      )}
      {status?.lastError && status.state !== 'running' && (
        <p class={status.state === 'failed' ? 'admin-error' : 'admin-hint'}>
          {status.state === 'failed' ? 'Fehler' : 'Erste Ursache'}: {status.lastError}
        </p>
      )}
      {error && (
        <p class="admin-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
