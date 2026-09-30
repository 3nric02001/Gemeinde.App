import { useEffect, useState } from 'preact/hooks';
import { loadAuth, useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { TrackList } from '../components/TrackList';
import { formatBytes, plural } from '../format';
import { removeDownloads, storageEstimate, useOffline } from '../offline';
import { player } from '../player';
import { Empty } from './common';

/** "Heruntergeladen": offline gespeicherte Titel; ohne Netz die einzige Seite mit Inhalt. */
export function Downloads() {
  const offline = useOffline();
  const { offline: noServer } = useAuth();
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | undefined>();
  useEffect(() => void storageEstimate().then(setEstimate), [offline.items.length]);

  const tracks = offline.items.map((item) => item.track);
  const size = offline.items.reduce((sum, item) => sum + item.size, 0);
  const pending = offline.progress.size;

  return (
    <div class="page">
      <h1 class="page-title">Heruntergeladen</h1>
      {noServer && (
        <div class="offline-note" role="status">
          <span>Keine Verbindung zum Server. Du kannst die heruntergeladenen Titel hören.</span>
          <button type="button" class="button-secondary" onClick={() => void loadAuth()}>
            Erneut verbinden
          </button>
        </div>
      )}
      {!offline.enabled && !tracks.length ? (
        <Empty title="Offline hören ist nicht verfügbar">
          Die Verwaltung hat es ausgeschaltet, oder dieser Browser kann keine Titel speichern.
        </Empty>
      ) : !tracks.length && !pending ? (
        <Empty title="Noch nichts heruntergeladen">
          Tippe bei einem Album oder Gottesdienst auf den Pfeil nach unten, um es ohne Internet zu hören.
        </Empty>
      ) : (
        <>
          <p class="hero-meta">
            {plural(tracks.length, 'Titel', 'Titel')}, {formatBytes(size)}
            {pending > 0 && ` · ${plural(pending, 'Titel wird', 'Titel werden')} geladen`}
            {offline.expiresAt && ` · ohne Internet hörbar bis ${new Date(offline.expiresAt).toLocaleDateString('de-DE')}`}
          </p>
          {offline.error && (
            <p class="admin-error" role="alert">
              {offline.error}
            </p>
          )}
          {tracks.length > 0 && (
            <>
              <div class="actions">
                <button type="button" class="button-primary" onClick={() => player.playList(tracks, 0, { shuffle: false })}>
                  <Icon name="play" size={20} /> Abspielen
                </button>
                <button type="button" class="button-secondary" onClick={() => player.playShuffled(tracks)}>
                  <Icon name="shuffle" size={18} /> Zufällig
                </button>
                <button
                  type="button"
                  class="button-secondary"
                  onClick={() => {
                    if (window.confirm('Alle heruntergeladenen Titel von diesem Gerät löschen?')) {
                      void removeDownloads(tracks.map((track) => track.id));
                    }
                  }}
                >
                  Alle löschen
                </button>
              </div>
              <TrackList tracks={tracks} />
            </>
          )}
        </>
      )}
      {estimate && (
        <p class="admin-hint">
          Speicher im Browser: {formatBytes(estimate.usage)} von {formatBytes(estimate.quota)} belegt. Die Titel liegen
          verschlüsselt nur in dieser App und werden beim Abmelden gelöscht.
        </p>
      )}
    </div>
  );
}
