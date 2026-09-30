import { useEffect } from 'preact/hooks';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { player } from '../player';
import { useLive } from '../live';
import { Empty } from './common';

/**
 * Livestream: die in der Verwaltung eingestellte Seite eingebettet (z. B. Owncast unter /embed/video/).
 * Die CSP des Servers lässt genau diese Adresse als frame-src zu.
 */
export function Live() {
  const { livestream } = useAuth();
  const live = useLive();

  // Zwei Tonquellen gleichzeitig will niemand: laufende Musik anhalten
  useEffect(() => {
    if (livestream && player.getState().playing) player.toggle();
  }, [Boolean(livestream)]);

  if (!livestream) {
    return (
      <div class="page">
        <Empty title="Kein Livestream">
          Der Livestream ist gerade nicht eingerichtet. <a href="/">Zur Startseite</a>
        </Empty>
      </div>
    );
  }

  return (
    <div class="page">
      <h1 class="page-title">
        {livestream.title}
        {live && <LiveBadge />}
      </h1>
      {/* Ohne Übertragung statt eines schwarzen Felds ein Hinweis; beginnt der Stream, erscheint er von selbst */}
      {live === false ? (
        <div class="live-off">
          <Icon name="live" size={32} />
          <p>
            <strong>Gerade keine Übertragung.</strong>
            <br />
            Sobald der Stream beginnt, erscheint er hier von selbst.
          </p>
        </div>
      ) : (
        <div class="live-frame">
          <iframe
            src={livestream.url}
            title={livestream.title}
            allow="autoplay; fullscreen; picture-in-picture"
            referrerpolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-presentation"
          />
        </div>
      )}
      <p class="live-hint">
        {live === null ? 'Läuft gerade keine Übertragung, zeigt der Player das an. ' : ''}Klappt es hier nicht,{' '}
        <a href={livestream.url} target="_blank" rel="noopener noreferrer">
          den Stream im Browser öffnen
        </a>
        .
      </p>
    </div>
  );
}

/** Roter Punkt "Live", solange gesendet wird */
export function LiveBadge() {
  return (
    <span class="live-badge">
      <i aria-hidden="true" />
      Live
    </span>
  );
}

/**
 * Kachel auf der Startseite. Sendet der Stream, steht sie groß über dem aktuellen Gottesdienst (`live`), sonst
 * schlicht weiter unten. Ist der Status unbekannt, sieht sie aus wie früher.
 */
export function LiveTile({ live }: { live: boolean | null }) {
  const { livestream } = useAuth();
  if (!livestream) return null;
  const sub = live ? 'Jetzt live mitverfolgen' : live === false ? 'Gerade keine Übertragung' : 'Gottesdienst live mitverfolgen';
  return (
    <a class={`live-tile${live ? ' is-live' : live === false ? ' is-off' : ''}`} href="/live">
      <span class="live-tile-icon" aria-hidden="true">
        <Icon name="live" size={live === false ? 20 : 26} />
      </span>
      <span class="live-tile-text">
        <span class="live-tile-title">
          {livestream.title}
          {live && <LiveBadge />}
        </span>
        <span class="live-tile-sub">{sub}</span>
      </span>
      <Icon name="forward" size={20} class="live-tile-chevron" />
    </a>
  );
}
