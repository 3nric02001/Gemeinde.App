import { useEffect } from 'preact/hooks';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { player } from '../player';
import { Empty } from './common';

/**
 * Livestream: die in der Verwaltung eingestellte Seite eingebettet (z. B. Owncast unter /embed/video/).
 * Die CSP des Servers lässt genau diese Adresse als frame-src zu.
 */
export function Live() {
  const { livestream } = useAuth();

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
      <h1 class="page-title">{livestream.title}</h1>
      <div class="live-frame">
        <iframe
          src={livestream.url}
          title={livestream.title}
          allow="autoplay; fullscreen; picture-in-picture"
          referrerpolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-presentation"
        />
      </div>
      <p class="live-hint">
        Läuft gerade keine Übertragung, zeigt der Player das an. Klappt es hier nicht,{' '}
        <a href={livestream.url} target="_blank" rel="noopener noreferrer">
          den Stream im Browser öffnen
        </a>
        .
      </p>
    </div>
  );
}

/** Kachel auf der Startseite */
export function LiveTile() {
  const { livestream } = useAuth();
  if (!livestream) return null;
  return (
    <a class="live-tile" href="/live">
      <span class="live-tile-icon" aria-hidden="true">
        <Icon name="live" size={26} />
      </span>
      <span class="live-tile-text">
        <span class="live-tile-title">{livestream.title}</span>
        <span class="live-tile-sub">Gottesdienst live mitverfolgen</span>
      </span>
      <Icon name="forward" size={20} class="live-tile-chevron" />
    </a>
  );
}
