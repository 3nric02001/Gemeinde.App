import { categoryUrl } from '../api';
import { useCategories } from '../hooks';
import { hasRole, logout, ROLE_LABELS, useAuth } from '../auth';
import { AdminNav } from '../admin/Access';
import { appReturnPath, sectionPath } from '../router';
import { Icon, type IconName } from './Icon';

type NavItem = { href: string; label: string; icon: IconName; match: (path: string) => boolean };

const start: NavItem = { href: '/', label: 'Start', icon: 'home', match: (p) => p === '/' };
const search: NavItem = { href: '/suche', label: 'Suche', icon: 'search', match: (p) => p.startsWith('/suche') };
const albums: NavItem = { href: '/alben', label: 'Alben', icon: 'albums', match: (p) => p.startsWith('/alben') || p.startsWith('/album/') };

/** Menüpunkt aktiv? Album-Seiten zählen zu dem Bereich, aus dem man sie geöffnet hat (etwa Datum). */
const active = (item: NavItem, path: string) => item.match(sectionPath(path));
const dates: NavItem = { href: '/datum', label: 'Datum', icon: 'calendar', match: (p) => p.startsWith('/datum') };

/** Seitenleiste am Rechner; alle Titel gibt es über Suche und Alben, die Seite /titel bleibt unter „Mehr“ */
const items: NavItem[] = [
  start,
  search,
  albums,
  dates,
  { href: '/favoriten', label: 'Favoriten', icon: 'heart', match: (p) => p.startsWith('/favoriten') },
];

/** Tab-Leiste auf dem Handy: die vier wichtigsten Ziele, der Rest unter "Mehr" */
const MORE_PATHS = ['/mehr', '/titel', '/favoriten', '/kategorie', '/warteschlange', '/admin'];
const tabs: NavItem[] = [
  start,
  search,
  dates,
  albums,
  { href: '/mehr', label: 'Mehr', icon: 'menu', match: (p) => MORE_PATHS.some((prefix) => p.startsWith(prefix)) },
];

export function Sidebar({ path }: { path: string }) {
  // Eigene Kategorien aus der Verwaltung stehen nach den festen Einträgen.
  const categories = useCategories(path).filter((c) => c.inNav);
  const { user, branding } = useAuth();
  // In der Verwaltung ersetzt am Rechner deren Navigation die der App (Umschalten per CSS, damit Tablets die App-Leiste behalten)
  const manage = path.startsWith('/admin') && hasRole(user, 'manager');
  return (
    <nav class={`sidebar${manage ? ' is-manage' : ''}`} aria-label="Hauptnavigation">
      {manage && (
        <div class="sidebar-manage">
          <a class="brand sidebar-return" href={appReturnPath()}>
            <span class="brand-mark">
              <Icon name="back" size={18} />
            </span>
            <span>Zurück zur App</span>
          </a>
          <AdminNav path={path} admin={hasRole(user, 'admin')} />
        </div>
      )}
      <div class="sidebar-app">
        <a class="brand" href="/">
          <span class="brand-mark">
            <Icon name="cross" size={18} />
          </span>
          <span>{branding.name}</span>
        </a>
        <ul>
          {items.map((item) => (
            <li key={item.href}>
              <a href={item.href} class={active(item, path) ? 'is-active' : ''} aria-current={active(item, path) ? 'page' : undefined}>
                <Icon name={item.icon} size={22} />
                <span>{item.label}</span>
              </a>
            </li>
          ))}
          {categories.map((category) => {
            const href = categoryUrl(category.slug);
            const section = sectionPath(path);
            const active = section === href || section.startsWith(`${href}/`);
            return (
              <li key={category.id}>
                <a href={href} class={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined}>
                  <Icon name="tag" size={22} />
                  <span>{category.name}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
      <div class="sidebar-foot">
        {hasRole(user, 'manager') && (
          <a class={`sidebar-admin${path.startsWith('/admin') ? ' is-active' : ''}`} href="/admin">
            <Icon name="settings" size={20} />
            <span>Verwaltung</span>
          </a>
        )}
        {user && (
          <a
            class={`sidebar-admin${path === '/mehr' ? ' is-active' : ''}`}
            href="/mehr"
            title={`${user.name} (${ROLE_LABELS[user.role]}): Schriftgröße, App installieren`}
          >
            <Icon name="user" size={20} />
            <span>{user.name}</span>
          </a>
        )}
        {user && (
          <button type="button" class="sidebar-admin" onClick={() => void logout()} title={`${user.name} (${ROLE_LABELS[user.role]})`}>
            <Icon name="logout" size={20} />
            <span>Abmelden</span>
          </button>
        )}
      </div>
    </nav>
  );
}

/** Tab-Leiste am unteren Rand auf dem Handy */
export function TabBar({ path }: { path: string }) {
  return (
    <nav class="tabbar" aria-label="Hauptnavigation">
      {tabs.map((item) => (
        <a
          key={item.href}
          href={item.href}
          class={active(item, path) ? 'is-active' : ''}
          aria-current={active(item, path) ? 'page' : undefined}
          onClick={(event) => {
            if (path === item.href) onActiveTab(event, item.href);
          }}
        >
          <Icon name={item.icon} size={22} />
          <span>{item.label}</span>
        </a>
      ))}
    </nav>
  );
}

/**
 * Tipp auf den Tab, in dem man schon ist: nach oben scrollen, oben angekommen bei der Suche ins Suchfeld.
 * Ersetzt das Tippen auf die Statusleiste, das beim eigenen Scrollbereich auf dem iPhone nicht mehr greift.
 */
function onActiveTab(event: MouseEvent, href: string): void {
  const main = document.querySelector<HTMLElement>('.main');
  if (main && main.scrollTop > 0) {
    event.preventDefault();
    main.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const input = href === '/suche' ? document.querySelector<HTMLInputElement>('.main input[type="search"]') : null;
  if (input) {
    event.preventDefault();
    input.focus();
  }
}
