import { categoryUrl } from '../api';
import { hasRole, logout, ROLE_LABELS, useAuth } from '../auth';
import { Icon, type IconName } from '../components/Icon';
import { InstallSteps } from '../components/InstallHint';
import { setTextSize, TEXT_SIZES, useTextSize } from '../display';
import { useCategories } from '../hooks';
import { isInstalled } from '../install';
import { useOffline } from '../offline';

function Row({ href, icon, label }: { href: string; icon: IconName; label: string }) {
  return (
    <li>
      <a href={href} class="more-row">
        <Icon name={icon} size={22} />
        <span>{label}</span>
        <Icon name="back" size={18} class="more-chevron" />
      </a>
    </li>
  );
}

/** "Mehr": alles, was nicht in die Tab-Leiste passt, dazu Profil und Einstellungen */
export function More() {
  const { user } = useAuth();
  const categories = useCategories().filter((c) => c.inNav);
  const textSize = useTextSize();
  const offline = useOffline();
  return (
    <div class="page page-narrow">
      <h1 class="page-title">Mehr</h1>

      {user && (
        <section class="profile">
          <span class="profile-avatar" aria-hidden="true">
            {[...user.name.trim()][0]?.toUpperCase() ?? '?'}
          </span>
          <span class="profile-text">
            <strong>{user.name}</strong>
            <span>{ROLE_LABELS[user.role]}</span>
          </span>
        </section>
      )}

      <ul class="more-list">
        <Row href="/favoriten" icon="heart" label="Favoriten" />
        {(offline.enabled || offline.items.length > 0) && <Row href="/heruntergeladen" icon="download" label="Heruntergeladen" />}
        <Row href="/titel" icon="tracks" label="Alle Titel" />
        {categories.map((category) => (
          <Row key={category.id} href={categoryUrl(category.slug)} icon="tag" label={category.name} />
        ))}
        <Row href="/warteschlange" icon="queue" label="Warteschlange" />
      </ul>

      <section class="shelf">
        <div class="section-head">
          <h2>Schriftgröße</h2>
        </div>
        <div class="segmented" role="radiogroup" aria-label="Schriftgröße">
          {TEXT_SIZES.map(([size, label]) => (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={textSize === size}
              class={textSize === size ? 'is-on' : ''}
              onClick={() => setTextSize(size)}
            >
              <span class={`segmented-sample segmented-${size}`}>A</span>
              {label}
            </button>
          ))}
        </div>
      </section>

      {!isInstalled() && (
        <section class="shelf">
          <div class="section-head">
            <h2>Als App nutzen</h2>
          </div>
          <InstallSteps />
        </section>
      )}

      <ul class="more-list">
        {hasRole(user, 'manager') && <Row href="/admin" icon="settings" label="Verwaltung" />}
        <li>
          <button type="button" class="more-row" onClick={() => void logout()}>
            <Icon name="logout" size={22} />
            <span>Abmelden</span>
          </button>
        </li>
      </ul>
    </div>
  );
}
