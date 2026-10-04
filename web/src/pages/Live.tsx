import { useEffect, useState } from 'preact/hooks';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { canPlayLive, player, usePlayerSelect } from '../player';
import { useLive } from '../live';
import { Empty } from './common';

/**
 * Livestream. Kennt der Server die direkte Adresse (HLS, bei Owncast /hls/stream.m3u8) und kann der Browser sie
 * abspielen, läuft der Ton im Player der App: unter „Jetzt läuft“, auf dem Sperrbildschirm und bei gesperrtem
 * Bildschirm weiter. Das Bild kommt aus der eingebetteten Seite (z. B. Owncast unter /embed/video/); die CSP des
 * Servers lässt genau diese Adressen zu. Eine eingebettete Seite hält das Handy beim Sperren an.
 */
export function Live() {
  const { livestream } = useAuth();
  const live = useLive();
  const inPlayer = usePlayerSelect((s) => s.live !== undefined);
  const playing = usePlayerSelect((s) => s.live !== undefined && s.playing);
  const error = usePlayerSelect((s) => (s.live ? s.error : undefined));
  const audio = livestream?.audio && canPlayLive() ? livestream.audio : undefined;
  // Mit Bild: die eingebettete Seite. Ohne Player-Adresse gibt es nur die.
  const [video, setVideo] = useState(!audio);
  const showVideo = (video || !audio) && !inPlayer;

  // Zwei Tonquellen gleichzeitig will niemand: läuft das Bild, hält der Player an
  useEffect(() => {
    if (livestream && showVideo && player.getState().playing) player.toggle();
  }, [Boolean(livestream), showVideo]);

  if (!livestream) {
    return (
      <div class="page">
        <Empty title="Kein Livestream">
          Der Livestream ist gerade nicht eingerichtet. <a href="/">Zur Startseite</a>
        </Empty>
      </div>
    );
  }

  const listen = () => {
    setVideo(false);
    if (inPlayer) player.toggle();
    else if (audio) player.playLive({ title: livestream.title, audio, href: '/live' });
  };
  const watch = () => {
    player.stopLive();
    setVideo(true);
  };

  return (
    <div class="page">
      <h1 class="page-title">
        {livestream.title}
        {live && <LiveBadge />}
      </h1>
      {/* Ohne Übertragung statt eines schwarzen Felds ein Hinweis; beginnt der Stream, erscheint er von selbst */}
      {live === false && !inPlayer ? (
        <div class="live-off">
          <Icon name="live" size={32} />
          <p>
            <strong>Gerade keine Übertragung.</strong>
            <br />
            Sobald der Stream beginnt, erscheint er hier von selbst.
          </p>
        </div>
      ) : (
        <>
          {audio && (
            <div class={`live-listen${inPlayer ? ' is-on' : ''}`}>
              <button type="button" class="play-button live-listen-play" aria-label={playing ? 'Pause' : 'Anhören'} onClick={listen}>
                <Icon name={playing ? 'pause' : 'play'} size={28} />
              </button>
              <p>
                <strong>{inPlayer ? (error ?? (playing ? 'Läuft im Player' : 'Angehalten')) : 'Anhören'}</strong>
                <br />
                Läuft auch bei gesperrtem Bildschirm weiter.
              </p>
              {!showVideo && (
                <button type="button" class="button-secondary live-watch" onClick={watch}>
                  Mit Bild ansehen
                </button>
              )}
            </div>
          )}
          {showVideo && (
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
        </>
      )}
      <p class="live-hint">
        {live === null && showVideo ? 'Läuft gerade keine Übertragung, zeigt der Player das an. ' : ''}
        {showVideo && audio ? 'Mit Bild hält das Handy den Stream beim Sperren an. ' : ''}
        Klappt es hier nicht,{' '}
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
