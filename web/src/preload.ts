import { streamUrl } from './api';

/**
 * Den nächsten Titel der Warteschlange kurz vor dem Ende des laufenden in den Speicher holen,
 * damit der Wechsel ohne Nachladen klappt: aus dem Netz als Ganzes, bei Offline-Kopien schon
 * entschlüsselt. Es liegt immer höchstens ein Titel bereit.
 */

/** So viele Sekunden (echte Zeit, Tempo eingerechnet) vor dem Ende beginnt das Vorladen */
export const PRELOAD_LEAD_SECONDS = 30;
/** Größere Dateien (lange Predigten in hoher Qualität) werden normal gestreamt */
export const PRELOAD_MAX_BYTES = 40 * 1024 * 1024;

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

/** Datensparmodus oder sehr langsames Netz: dann nichts auf Vorrat laden */
export function saveDataPreferred(nav: Navigator = navigator): boolean {
  const connection = (nav as Navigator & { connection?: NetworkInformation }).connection;
  if (!connection) return false;
  return connection.saveData === true || connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g';
}

export interface PreloadDeps {
  /** Titel liegt verschlüsselt auf dem Gerät */
  isDownloaded: (trackId: number) => boolean;
  /** Entschlüsselte Offline-Kopie */
  readDownload: (trackId: number) => Promise<Blob | undefined>;
  fetch?: typeof fetch;
  saveData?: () => boolean;
}

interface Pending {
  trackId: number;
  controller: AbortController;
  blob?: Blob;
}

export class Preloader {
  private pending: Pending | undefined;

  constructor(private readonly deps: PreloadDeps) {}

  /** Welcher Titel gerade vorgeladen wird oder bereitliegt */
  get trackId(): number | undefined {
    return this.pending?.trackId;
  }

  /** Bereitliegenden Titel übernehmen (danach gehört der Blob dem Aufrufer) */
  take(trackId: number): Blob | undefined {
    const pending = this.pending;
    if (!pending || pending.trackId !== trackId || !pending.blob) return undefined;
    this.pending = undefined;
    return pending.blob;
  }

  /**
   * `trackId` vorladen; ein anderer vorgeladener Titel wird verworfen. `undefined` verwirft nur.
   * Mehrfache Aufrufe für denselben Titel laden nicht erneut.
   */
  want(trackId: number | undefined): void {
    if (this.pending?.trackId === trackId) return;
    this.clear();
    if (trackId === undefined) return;
    const offline = this.deps.isDownloaded(trackId);
    // Offline-Kopien kosten kein Datenvolumen, nur der Stream richtet sich nach dem Sparmodus.
    if (!offline && (this.deps.saveData ?? saveDataPreferred)()) return;
    const pending: Pending = { trackId, controller: new AbortController() };
    this.pending = pending;
    void (offline ? this.deps.readDownload(trackId) : this.fetchStream(trackId, pending.controller.signal))
      .catch(() => undefined)
      .then((blob) => {
        // Fehlgeschlagen oder zu groß: der Eintrag bleibt ohne Blob stehen, damit nicht bei jedem
        // Zeit-Update neu geladen wird; der Player streamt dann wie gewohnt.
        if (this.pending === pending && blob) pending.blob = blob;
      });
  }

  /** Laufendes Vorladen abbrechen und Bereitliegendes vergessen (z. B. beim Abmelden) */
  clear(): void {
    this.pending?.controller.abort();
    this.pending = undefined;
  }

  private async fetchStream(trackId: number, signal: AbortSignal): Promise<Blob | undefined> {
    const response = await (this.deps.fetch ?? fetch)(streamUrl(trackId), { signal, credentials: 'same-origin' });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const length = Number(response.headers.get('content-length'));
    if (!Number.isFinite(length) || length <= 0 || length > PRELOAD_MAX_BYTES) {
      await response.body.cancel().catch(() => undefined);
      return undefined;
    }
    const type = response.headers.get('content-type') ?? '';
    return new Blob([await response.arrayBuffer()], { type });
  }
}
