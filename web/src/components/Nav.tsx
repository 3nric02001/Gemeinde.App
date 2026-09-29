import { categoryUrl } from '../api';
import { useCategories } from '../hooks';
import { Icon, type IconName } from './Icon';

const items: Array<{ href: string; label: string; icon: IconName; match: (path: string) => boolean }> = [
  { href: '/', label: 'Start', icon: 'home', match: (p) => p === '/' },
  { href: '/suche', label: 'Suche', icon: 'search', match: (p) => p.startsWith('/suche') },
  { href: '/alben', label: 'Alben', icon: 'albums', match: (p) => p.startsWith('/alben') || p.startsWith('/album/') },
  { href: '/datum', label: 'Datum', icon: 'calendar', match: (p) => p.startsWith('/datum') },
  { href: '/titel', label: 'Titel', icon: 'tracks', match: (p) => p.startsWith('/titel') },
];

export function Sidebar({ path }: { path: string }) {
  // Eigene Kategorien aus der Verwaltung stehen nach den festen Einträgen.
  const categories = useCategories(path).filter((c) => c.inNav);
  return (
    <nav class="sidebar" aria-label="Hauptnavigation">
      <a class="brand" href="/">
        <span class="brand-mark">
          <Icon name="cross" size={18} />
        </span>
        <span>Gemeinde.App</span>
      </a>
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <a href={item.href} class={item.match(path) ? 'is-active' : ''} aria-current={item.match(path) ? 'page' : undefined}>
              <Icon name={item.icon} size={22} />
              <span>{item.label}</span>
            </a>
          </li>
        ))}
        {categories.map((category) => {
          const href = categoryUrl(category.slug);
          const active = path === href || path.startsWith(`${href}/`);
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
      <a class={`sidebar-admin${path.startsWith('/admin') ? ' is-active' : ''}`} href="/admin">
        <Icon name="settings" size={20} />
        <span>Verwaltung</span>
      </a>
    </nav>
  );
}

/** Tab-Leiste am unteren Rand auf dem Handy */
export function TabBar({ path }: { path: string }) {
  return (
    <nav class="tabbar" aria-label="Hauptnavigation">
      {items.map((item) => (
        <a key={item.href} href={item.href} class={item.match(path) ? 'is-active' : ''} aria-current={item.match(path) ? 'page' : undefined}>
          <Icon name={item.icon} size={22} />
          <span>{item.label}</span>
        </a>
      ))}
    </nav>
  );
}
