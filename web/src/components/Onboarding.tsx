import { useEffect, useRef, useState } from 'preact/hooks';
import { finishOnboarding, useAuth } from '../auth';
import { Icon, type IconName } from './Icon';

interface Step {
  icon: IconName;
  title: string;
  text: string;
}

/** Die Grundfunktionen in vier kurzen Schritten; Wörter wie in der Navigation, damit man sie wiederfindet. */
const steps = (name: string): Step[] => [
  {
    icon: 'home',
    title: `Willkommen bei ${name}`,
    text: 'Auf der Startseite steht oben der neueste Gottesdienst. Darunter findest du, was du angefangen oder zuletzt gehört hast.',
  },
  {
    icon: 'search',
    title: 'Suchen und stöbern',
    text: 'Unter „Suche“ findest du Predigten, Lieder, Sprecher und Bibelstellen schon beim Tippen. Unter „Datum“ stehen alle Gottesdienste nach Tagen geordnet.',
  },
  {
    icon: 'play',
    title: 'Anhören',
    text: 'Tippe auf einen Titel, dann spielt er unten im Player weiter, auch wenn du woanders hinschaust. Bei Predigten merkt sich die App die Stelle, auch auf deinen anderen Geräten.',
  },
  {
    icon: 'heart',
    title: 'Favoriten und Einstellungen',
    text: 'Mit dem Herz merkst du dir Titel und Alben unter „Favoriten“. Unter „Mehr“ (am Rechner dein Name links unten) stellst du die Schriftgröße ein und kannst diese Einführung wieder ansehen.',
  },
];

/** Kurze Einführung beim ersten Öffnen; Überspringen, Escape und der letzte Schritt beenden sie für immer. */
export function Onboarding() {
  const { branding } = useAuth();
  const [index, setIndex] = useState(0);
  const primary = useRef<HTMLButtonElement>(null);
  const all = steps(branding.name);
  const step = all[index]!;
  const last = index === all.length - 1;

  useEffect(() => primary.current?.focus(), [index]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishOnboarding();
      else if (event.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, all.length - 1));
      else if (event.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
      else return;
      event.stopPropagation();
    };
    // Vor der Tastatursteuerung der App (Leertaste, "/"), solange die Einführung offen ist
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [all.length]);

  return (
    <div class="onboarding-backdrop">
      <div class="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-text">
        <button type="button" class="onboarding-skip" onClick={finishOnboarding}>
          Überspringen
        </button>
        <span class="onboarding-icon" aria-hidden="true">
          <Icon name={step.icon} size={34} />
        </span>
        <p class="onboarding-count">
          Schritt {index + 1} von {all.length}
        </p>
        <h2 id="onboarding-title">{step.title}</h2>
        <p id="onboarding-text" class="onboarding-text">
          {step.text}
        </p>
        <div class="onboarding-dots" aria-hidden="true">
          {all.map((_, i) => (
            <span key={i} class={i === index ? 'is-on' : ''} />
          ))}
        </div>
        <div class="onboarding-actions">
          {index > 0 ? (
            <button type="button" class="button-secondary" onClick={() => setIndex(index - 1)}>
              Zurück
            </button>
          ) : (
            <span />
          )}
          <button
            ref={primary}
            type="button"
            class="button-primary"
            onClick={() => (last ? finishOnboarding() : setIndex(index + 1))}
          >
            {last ? 'Los geht’s' : 'Weiter'}
          </button>
        </div>
      </div>
    </div>
  );
}
