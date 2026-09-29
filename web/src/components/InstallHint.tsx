import { useState } from 'preact/hooks';
import { dismissHint, hintDismissed, isInstalled, platform, useInstall } from '../install';
import { Icon } from './Icon';

/** Anleitung je nach Gerät, wie die App aufs Home-Bildschirm kommt */
export function InstallSteps() {
  const install = useInstall();
  const device = platform();
  if (install.canPrompt) {
    return (
      <button type="button" class="button-primary" onClick={() => void install.prompt()}>
        <Icon name="download" size={18} /> Als App installieren
      </button>
    );
  }
  if (device === 'ios') {
    return (
      <p class="install-steps">
        In Safari unten auf <ShareIcon /> <strong>Teilen</strong> tippen, dann <strong>„Zum Home-Bildschirm“</strong> wählen.
      </p>
    );
  }
  if (device === 'android') {
    return (
      <p class="install-steps">
        Im Browser oben rechts auf <strong>⋮</strong> tippen, dann <strong>„Zum Startbildschirm hinzufügen“</strong> oder{' '}
        <strong>„App installieren“</strong> wählen.
      </p>
    );
  }
  return (
    <p class="install-steps">
      In Chrome oder Edge erscheint rechts in der Adressleiste ein Symbol zum Installieren. Auf dem Handy geht es über das
      Browsermenü („Zum Startbildschirm hinzufügen“).
    </p>
  );
}

/** Einmaliger Hinweis auf dem Handy, bis man ihn schließt oder die App installiert ist. */
export function InstallHint() {
  const [hidden, setHidden] = useState(() => hintDismissed() || isInstalled() || platform() === 'other');
  if (hidden) return null;
  return (
    <section class="install-hint" aria-label="Als App nutzen">
      <div>
        <strong>Tipp: Die App auf den Home-Bildschirm legen</strong>
        <InstallSteps />
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label="Hinweis schließen"
        onClick={() => {
          dismissHint();
          setHidden(true);
        }}
      >
        <Icon name="close" size={18} />
      </button>
    </section>
  );
}

/** Das Teilen-Symbol von Safari (Kasten mit Pfeil nach oben) */
function ShareIcon() {
  return (
    <svg class="inline-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="Teilen-Symbol">
      <path d="M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
