import type { FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { query } from '../api';
import { ROLE_LABELS, setBranding, useAuth, type Branding, type Role } from '../auth';
import { Icon } from '../components/Icon';
import { plural } from '../format';
import { Empty, ErrorNote, Loading } from '../pages/common';
import { adminRequest, type Change } from './api';
import { Switch } from './Switch';

export interface AdminUser {
  id: number;
  kind: 'local' | 'oidc';
  username: string | null;
  name: string;
  email: string | null;
  role: Role | null;
  groups: string[];
  disabled: boolean;
  lastLoginAt: number | null;
}

export interface AdminGroup {
  name: string;
  enabled: boolean;
  role: Role;
  userCount: number;
  lastSeenAt: number | null;
}

export interface DeniedLogin {
  at: number;
  name: string;
  email: string | null;
  reason: 'no-group' | 'disabled';
  groups: string[];
  groupsClaim: string;
  claimNames: string[];
}

interface GroupsData {
  items: AdminGroup[];
  lastDenied: DeniedLogin | null;
}

export interface OidcView {
  enabled: boolean;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  scopes: string;
  groupsClaim: string;
  label: string;
  redirectUri: string;
  /** PUBLIC_URL fehlt in der .env; ohne sie lässt sich OIDC nicht einschalten */
  publicUrlMissing?: boolean;
}

const ROLES: Role[] = ['listener', 'manager', 'admin'];
const ROLE_HINTS: Record<Role, string> = {
  listener: 'nur hören',
  manager: 'Alben und Titel bearbeiten',
  admin: 'alles, auch Benutzer und Anmeldung',
};
/** Ausführlicher für die Erklärung unter Gruppen */
const ROLE_DETAILS: Record<Role, string> = {
  listener: 'hören Gottesdienste und Musik, merken sich Favoriten.',
  manager: 'pflegen zusätzlich Alben, Titel und Kategorien.',
  admin: 'verwalten zusätzlich Benutzer, Gruppen und die Anmeldung und sehen das Änderungsprotokoll.',
};

export interface SectionProps {
  params: URLSearchParams;
}

export const ACCESS_SECTIONS: Array<{ path: string; label: string; Component: FunctionComponent<SectionProps> }> = [
  { path: '/admin/benutzer', label: 'Benutzer', Component: UsersAdmin },
  { path: '/admin/gruppen', label: 'Gruppen', Component: GroupsAdmin },
  { path: '/admin/anmeldung', label: 'Anmeldung', Component: LoginAdmin },
  { path: '/admin/aenderungen', label: 'Änderungen', Component: ChangesAdmin },
];

/**
 * Bereiche der Verwaltung, nach Aufgabe gruppiert: was man pflegt (Inhalte), was die App automatisch
 * macht und wie es eingestellt ist (Automatik), wer hineindarf (Zugang, nur Admins) und was geändert wurde.
 */
export const ADMIN_GROUPS: Array<{ label: string; adminOnly?: boolean; items: Array<{ path: string; label: string }> }> = [
  {
    label: 'Inhalte',
    items: [
      { path: '/admin', label: 'Alben' },
      { path: '/admin/kategorien', label: 'Kategorien' },
    ],
  },
  {
    label: 'Automatik',
    items: [
      { path: '/admin/zuordnung', label: 'Zuordnung' },
      { path: '/admin/schreibweisen', label: 'Schreibweisen' },
      { path: '/admin/pruefen', label: 'Prüfen' },
    ],
  },
  { label: 'Zugang', adminOnly: true, items: ACCESS_SECTIONS.filter((s) => s.path !== '/admin/aenderungen') },
  { label: 'Verlauf', adminOnly: true, items: ACCESS_SECTIONS.filter((s) => s.path === '/admin/aenderungen') },
];

/** Welcher Bereich zu einer Seite gehört; Album- und Kategorie-Editor zählen zu ihrer Liste. */
function activeSection(path: string): string {
  if (path.startsWith('/admin/album/')) return '/admin';
  if (path.startsWith('/admin/kategorie/')) return '/admin/kategorien';
  return path;
}

/**
 * Navigation der Verwaltung: auf breiten Bildschirmen eine Spalte mit Gruppen, auf schmalen eine Zeile
 * zum Wischen. Benutzer, Gruppen, Anmeldung und Änderungen nur für Admins.
 */
export function AdminNav({ path, admin }: { path: string; admin: boolean }) {
  const active = activeSection(path);
  const groups = ADMIN_GROUPS.filter((group) => admin || !group.adminOnly);
  return (
    <nav class="admin-nav" aria-label="Bereiche der Verwaltung">
      {groups.map((group) => (
        <div key={group.label} class="admin-nav-group" role="group" aria-label={group.label}>
          <span class="admin-nav-label">{group.label}</span>
          {group.items.map((item) => (
            <a
              key={item.path}
              href={item.path}
              class={`admin-nav-item${item.path === active ? ' is-on' : ''}`}
              aria-current={item.path === active ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

const dateOf = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString('de-DE') : 'noch nie');

function useLoad<T>(url: string): [T | undefined, string | undefined, (value: T) => void] {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    adminRequest<T>('GET', url)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [url]);
  return [data, error, setData];
}

// ---------- Benutzer ----------

type UserFilter = '' | Role | 'gesperrt' | 'ohne';
const USER_FILTERS: Array<{ value: UserFilter; label: string; test: (user: AdminUser) => boolean }> = [
  { value: '', label: 'Alle', test: () => true },
  { value: 'listener', label: 'Hörer', test: (u) => !u.disabled && u.role === 'listener' },
  { value: 'manager', label: 'Manager', test: (u) => !u.disabled && u.role === 'manager' },
  { value: 'admin', label: 'Admins', test: (u) => !u.disabled && u.role === 'admin' },
  { value: 'gesperrt', label: 'Gesperrt', test: (u) => u.disabled },
  { value: 'ohne', label: 'Kein Zugang', test: (u) => !u.disabled && !u.role },
];

/** Woher die Rolle kommt: die freigeschalteten Gruppen mit genau dieser Rolle, z. B. „Manager über Musikteam“ */
export function roleOrigin(user: AdminUser, groups: AdminGroup[]): string | undefined {
  if (user.kind === 'local' || !user.role) return undefined;
  const via = groups.filter((g) => g.enabled && g.role === user.role && user.groups.includes(g.name)).map((g) => g.name);
  return via.length ? `${ROLE_LABELS[user.role]} über ${via.join(', ')}` : undefined;
}

function UsersAdmin({ params }: SectionProps) {
  const [data, error, setData] = useLoad<{ items: AdminUser[] }>('/api/admin/users');
  const [groups] = useLoad<GroupsData>('/api/admin/groups');
  const [actionError, setActionError] = useState<string | undefined>();
  const [text, setText] = useState('');
  const filter = USER_FILTERS.find((f) => f.value === (params.get('rolle') ?? '')) ?? USER_FILTERS[0]!;
  const group = params.get('gruppe') ?? undefined;
  const href = (rolle: string, gruppe = group) => `/admin/benutzer${query({ rolle: rolle || undefined, gruppe })}`;

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
      setData(await adminRequest<{ items: AdminUser[] }>('GET', '/api/admin/users'));
      setActionError(undefined);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  // Suche und Gruppe grenzen ein, die Zahlen an den Filtern beziehen sich auf das Ergebnis.
  const needle = text.trim().toLocaleLowerCase('de');
  const found = (data?.items ?? []).filter(
    (user) =>
      (!group || user.groups.includes(group)) &&
      (!needle || [user.name, user.email, user.username].some((value) => value?.toLocaleLowerCase('de').includes(needle))),
  );
  const visible = found.filter(filter.test);

  return (
    <>
      <h1 class="page-title">Benutzer</h1>
      <p class="admin-hint">
        Außer dem lokalen Admin entstehen Benutzer bei ihrer ersten Anmeldung über das Gemeinde-Konto, sofern sie in einer
        freigeschalteten Gruppe sind. Ihre Rolle ergibt sich aus den Gruppen und wird bei Änderungen sofort angepasst.
      </p>
      {actionError && (
        <p class="admin-error" role="alert">
          {actionError}
        </p>
      )}
      {error ? (
        <ErrorNote message={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <form class="search-box" role="search" onSubmit={(e) => e.preventDefault()}>
            <Icon name="search" size={20} />
            <input
              type="search"
              value={text}
              placeholder="Name oder E-Mail suchen"
              aria-label="Benutzer suchen"
              autocomplete="off"
              onInput={(e) => setText((e.target as HTMLInputElement).value)}
            />
          </form>
          <nav class="chips-row" aria-label="Benutzer filtern">
            {USER_FILTERS.map((f) => {
              const count = found.filter(f.test).length;
              if (f.value && !count && f.value !== filter.value) return null;
              return (
                <a
                  key={f.value}
                  class={`chip${f.value === filter.value ? ' is-on' : ''}`}
                  href={href(f.value)}
                  aria-current={f.value === filter.value ? 'true' : undefined}
                >
                  {f.label} <span class="chip-count">{count}</span>
                </a>
              );
            })}
            {group && (
              <a class="chip is-on" href={href(filter.value, undefined)} aria-label={`Filter Gruppe ${group} entfernen`}>
                Gruppe: {group} <Icon name="close" size={14} />
              </a>
            )}
          </nav>
          {visible.length === 0 ? (
            <Empty title="Keine Benutzer gefunden" />
          ) : (
            <ul class="admin-list">
              {visible.map((user) => {
                const origin = roleOrigin(user, groups?.items ?? []);
                return (
                  <li key={user.id} class="admin-row admin-user">
                    <span class="track-main">
                      <span class="track-title">{user.name}</span>
                      <span class="track-sub">
                        {user.kind === 'local'
                          ? `Lokaler Admin · Benutzername ${user.username}`
                          : [user.email, `Zuletzt angemeldet: ${dateOf(user.lastLoginAt)}`].filter(Boolean).join(' · ')}
                      </span>
                      {user.kind === 'oidc' && (
                        <span class="track-sub">
                          {[origin, user.groups.length ? `Gruppen: ${user.groups.join(', ')}` : 'keine Gruppen'].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                    <span class="admin-badges">
                      {user.disabled ? (
                        <span class="badge badge-muted">Gesperrt</span>
                      ) : user.role ? (
                        <span class="badge">{ROLE_LABELS[user.role]}</span>
                      ) : (
                        <span class="badge badge-muted">Kein Zugang</span>
                      )}
                    </span>
                    {user.kind === 'oidc' && (
                      <span class="admin-user-actions">
                        <button
                          type="button"
                          class="button-secondary button-small"
                          onClick={() =>
                            void run(() => adminRequest('PATCH', `/api/admin/users/${user.id}`, { disabled: !user.disabled }))
                          }
                        >
                          {user.disabled ? 'Entsperren' : 'Sperren'}
                        </button>
                        <button
                          type="button"
                          class="button-secondary button-small button-danger"
                          onClick={() => {
                            if (
                              window.confirm(
                                `${user.name} entfernen? Bei der nächsten Anmeldung wird der Benutzer neu angelegt, sofern seine Gruppe freigeschaltet ist.`,
                              )
                            ) {
                              void run(() => adminRequest('DELETE', `/api/admin/users/${user.id}`));
                            }
                          }}
                        >
                          Entfernen
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </>
  );
}

// ---------- Gruppen ----------

function GroupsAdmin(_props: SectionProps) {
  const [data, error, setData] = useLoad<GroupsData>('/api/admin/groups');
  const [actionError, setActionError] = useState<string | undefined>();
  const [name, setName] = useState('');

  const save = async (group: string, body: { enabled?: boolean; role?: Role }) => {
    try {
      setData(await adminRequest<GroupsData>('PUT', `/api/admin/groups/${encodeURIComponent(group)}`, body));
      setActionError(undefined);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  const remove = async (group: string) => {
    try {
      setData(await adminRequest<GroupsData>('DELETE', `/api/admin/groups/${encodeURIComponent(group)}`));
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  return (
    <>
      <h1 class="page-title">Gruppen</h1>
      <p class="admin-hint">
        Nur wer in einer freigeschalteten Gruppe ist, kann sich über das Gemeinde-Konto anmelden. Gruppen erscheinen hier, sobald
        sich jemand aus ihnen anmeldet; du kannst sie auch vorab eintragen. Wer in mehreren Gruppen ist, bekommt die höchste
        Rolle seiner freigeschalteten Gruppen.
      </p>
      <dl class="admin-roles" aria-label="Was die Rollen dürfen">
        {ROLES.map((role) => (
          <div key={role}>
            <dt>{ROLE_LABELS[role]}</dt>
            <dd>{ROLE_DETAILS[role]}</dd>
          </div>
        ))}
      </dl>
      <form
        class="admin-panel admin-inline"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          void save(name.trim(), { enabled: true }).then(() => setName(''));
        }}
      >
        <label class="field">
          <span>Gruppe eintragen (Name wie im Identity Provider)</span>
          <input value={name} maxLength={200} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <button type="submit" class="button-primary" disabled={!name.trim()}>
          Freischalten
        </button>
      </form>
      {actionError && (
        <p class="admin-error" role="alert">
          {actionError}
        </p>
      )}
      {data?.lastDenied && (
        <DeniedLoginNote
          login={data.lastDenied}
          groups={data.items}
          onEnable={(group) => void save(group, { enabled: true })}
        />
      )}
      {error ? (
        <ErrorNote message={error} />
      ) : !data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty title="Noch keine Gruppen">Sie erscheinen nach der ersten Anmeldung über das Gemeinde-Konto.</Empty>
      ) : (
        <ul class="admin-list">
          {data.items.map((group) => (
            <li key={group.name} class={`admin-row admin-group${group.enabled ? '' : ' is-off'}`}>
              <span class="track-main">
                <span class="track-title">{group.name}</span>
                <span class="track-sub">
                  {group.userCount > 0 ? (
                    <a href={`/admin/benutzer${query({ gruppe: group.name })}`}>{plural(group.userCount, 'Benutzer', 'Benutzer')}</a>
                  ) : (
                    'keine Benutzer'
                  )}
                  {' · '}zuletzt gesehen: {dateOf(group.lastSeenAt)}
                </span>
                {!group.enabled && group.userCount > 0 && (
                  <span class="track-sub">Mitglieder kommen nur über eine andere, freigeschaltete Gruppe herein.</span>
                )}
              </span>
              <Switch
                checked={group.enabled}
                label="Darf sich anmelden"
                onChange={(enabled) => void save(group.name, { enabled })}
              />
              <label class="field admin-role">
                <span class="visually-hidden">Rolle für {group.name}</span>
                <select
                  value={group.role}
                  disabled={!group.enabled}
                  title={group.enabled ? undefined : 'Erst freischalten, dann wirkt die Rolle'}
                  onChange={(e) => void save(group.name, { role: (e.target as HTMLSelectElement).value as Role })}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]} ({ROLE_HINTS[role]})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                class="icon-button"
                aria-label={`${group.name} entfernen`}
                title="Gruppe entfernen"
                onClick={() => void remove(group.name)}
              >
                <Icon name="close" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Zeigt, was der Identity Provider bei der letzten abgewiesenen Anmeldung geliefert hat. */
function DeniedLoginNote({
  login,
  groups,
  onEnable,
}: {
  login: DeniedLogin;
  groups: AdminGroup[];
  onEnable: (group: string) => void;
}) {
  const enabled = new Set(groups.filter((g) => g.enabled).map((g) => g.name));
  const who = login.email ? `${login.name} (${login.email})` : login.name;
  return (
    <section class="admin-panel admin-denied" aria-label="Letzte abgewiesene Anmeldung">
      <h2>Letzte abgewiesene Anmeldung</h2>
      <p class="admin-hint">
        {who} am {new Date(login.at).toLocaleString('de-DE')}
        {login.reason === 'disabled' ? ': das Konto ist unter Benutzer gesperrt.' : ': in keiner freigeschalteten Gruppe.'}
      </p>
      {login.reason === 'no-group' &&
        (login.groups.length > 0 ? (
          <ul class="chips-row" aria-label="Gelieferte Gruppen">
            {login.groups.map((group) =>
              enabled.has(group) ? (
                <li key={group} class="chip is-on">
                  {group} · freigeschaltet
                </li>
              ) : (
                <li key={group}>
                  <button type="button" class="chip" onClick={() => onEnable(group)}>
                    {group} freischalten
                  </button>
                </li>
              ),
            )}
          </ul>
        ) : (
          <p class="admin-hint">
            Der Identity Provider hat im Claim „{login.groupsClaim}“ keine Gruppen geliefert. Erhalten hat die App:{' '}
            {login.claimNames.join(', ') || 'keine Claims'}. Prüfe, ob der Identity Provider die Gruppen mitschickt (bei
            Authentik über den Scope „profile“), oder trage unter Anmeldung den passenden Claim ein.
          </p>
        ))}
    </section>
  );
}

// ---------- Anmeldung (OIDC und lokaler Admin) ----------

function LoginAdmin(_props: SectionProps) {
  const { user } = useAuth();
  return (
    <>
      <h1 class="page-title">Anmeldung</h1>
      <BrandingSettings />
      <OfflineSettings />
      <OidcSettings />
      {user?.kind === 'local' && <PasswordForm />}
    </>
  );
}

/** Name der Gemeinde und Begrüßung auf der Anmeldeseite */
function BrandingSettings() {
  const [data, error, setData] = useLoad<Branding>('/api/admin/branding');
  const [form, setForm] = useState<Branding | undefined>();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(data), [data]);

  if (error) return <ErrorNote message={error} />;
  if (!form) return <Loading />;

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const saved = await adminRequest<Branding>('PUT', '/api/admin/branding', form);
      setData(saved);
      setBranding(saved);
      setMessage({ text: 'Gespeichert.', ok: true });
    } catch (e) {
      setMessage({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="admin-panel admin-form" onSubmit={submit}>
      <h2>Name und Begrüßung</h2>
      <p class="admin-hint">Erscheinen auf der Anmeldeseite, in der Seitenleiste und im Browser-Tab.</p>
      <label class="field">
        <span>Name</span>
        <input
          maxLength={60}
          placeholder="Gemeinde.App"
          value={form.name}
          onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label class="field">
        <span>
          Begrüßung <em>(ein Satz unter „Anmelden“)</em>
        </span>
        <input
          maxLength={300}
          placeholder="Predigten und Musik unserer Gemeinde"
          value={form.welcome}
          onInput={(e) => setForm({ ...form, welcome: (e.target as HTMLInputElement).value })}
        />
      </label>
      {message && (
        <p class={message.ok ? 'admin-ok' : 'admin-error'} role="status">
          {message.text}
        </p>
      )}
      <div class="actions">
        <button type="submit" class="button-primary" disabled={busy}>
          Speichern
        </button>
      </div>
    </form>
  );
}

interface OfflineView {
  enabled: boolean;
  days: number;
}

/** Offline hören: an/aus und wie lange Kopien ohne Serverkontakt gelten */
function OfflineSettings() {
  const [data, error, setData] = useLoad<OfflineView>('/api/admin/offline');
  const [form, setForm] = useState<OfflineView | undefined>();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(data), [data]);

  if (error) return <ErrorNote message={error} />;
  if (!form) return <Loading />;

  const submit = async (event: Event) => {
    event.preventDefault();
    if (data?.enabled && !form.enabled && !window.confirm('Alle offline gespeicherten Titel auf allen Geräten werden unbrauchbar. Fortfahren?')) {
      return;
    }
    setBusy(true);
    try {
      const saved = await adminRequest<OfflineView>('PUT', '/api/admin/offline', form);
      setData(saved);
      setMessage({ text: 'Gespeichert.', ok: true });
    } catch (e) {
      setMessage({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="admin-panel admin-form" onSubmit={submit}>
      <h2>Offline hören</h2>
      <p class="admin-hint">
        Hörer können Alben und Titel in der App speichern und ohne Internet hören. Die Dateien liegen verschlüsselt im
        Browser, lassen sich nicht als Datei herunterladen und werden beim Abmelden oder bei Sperrung gelöscht. Ganz
        verhindern lässt sich ein Mitschnitt im Browser aber nie.
      </p>
      <label class="admin-check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: (e.target as HTMLInputElement).checked })}
        />
        <span>Herunterladen für offline erlauben</span>
      </label>
      <label class="field">
        <span>
          Gültig ohne Verbindung <em>(Tage, danach löscht die App die Kopien)</em>
        </span>
        <input
          type="number"
          min={1}
          max={365}
          required
          value={form.days}
          onInput={(e) => setForm({ ...form, days: Number((e.target as HTMLInputElement).value) })}
        />
      </label>
      {message && (
        <p class={message.ok ? 'admin-ok' : 'admin-error'} role="status">
          {message.text}
        </p>
      )}
      <div class="actions">
        <button type="submit" class="button-primary" disabled={busy}>
          Speichern
        </button>
      </div>
    </form>
  );
}

function OidcSettings() {
  const [data, error, setData] = useLoad<OidcView>('/api/admin/oidc');
  const [form, setForm] = useState<OidcView | undefined>();
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState<{ text: string; ok: boolean } | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(data), [data]);

  if (error) return <ErrorNote message={error} />;
  if (!form) return <Loading />;

  const field = (key: 'issuer' | 'clientId' | 'scopes' | 'groupsClaim' | 'label') => ({
    value: form[key],
    onInput: (e: Event) => setForm({ ...form, [key]: (e.target as HTMLInputElement).value }),
  });

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { redirectUri: _r, hasSecret: _h, publicUrlMissing: _p, ...rest } = form;
      const saved = await adminRequest<OidcView>('PUT', '/api/admin/oidc', {
        ...rest,
        ...(secret ? { clientSecret: secret } : {}),
      });
      setData(saved);
      setSecret('');
      setMessage({ text: 'Gespeichert.', ok: true });
    } catch (e) {
      setMessage({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const result = await adminRequest<{ issuer: string }>('POST', '/api/admin/oidc/test');
      setMessage({ text: `Verbindung klappt: ${result.issuer}`, ok: true });
    } catch (e) {
      setMessage({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="admin-panel admin-form" onSubmit={submit}>
      <h2>Gemeinde-Konto (OIDC)</h2>
      <p class="admin-hint">
        Lege im Identity Provider (z. B. Keycloak, Authentik, Nextcloud) einen Client an und trage dort diese Weiterleitungs-URL
        ein: <code class="admin-copy">{form.redirectUri}</code>
      </p>
      {/* Nur ein Hinweis: Ist die Anmeldung schon an, funktioniert sie auch ohne PUBLIC_URL. Rot wird es erst,
          wenn „Verbindung testen“ oder Speichern scheitert. */}
      {form.publicUrlMissing && (
        <p class="admin-note">
          {data?.enabled
            ? 'PUBLIC_URL fehlt in der .env. Die Anmeldung läuft, die Weiterleitungs-Adresse stammt dann aber aus der Anfrage. Für den Betrieb hinter einem Proxy trage dort die öffentliche Adresse ein (z. B. https://musik.gemeinde.de) und starte den Container neu.'
            : 'Zum Einschalten zuerst PUBLIC_URL in der .env setzen (die öffentliche Adresse der App, z. B. https://musik.gemeinde.de) und den Container neu starten.'}
        </p>
      )}
      <Switch
        checked={form.enabled}
        disabled={form.publicUrlMissing && !data?.enabled}
        label="Anmeldung über das Gemeinde-Konto"
        onChange={(enabled) => setForm({ ...form, enabled })}
      />
      <label class="field">
        <span>Issuer-URL</span>
        <input type="url" placeholder="https://login.gemeinde.de/realms/gemeinde" {...field('issuer')} />
      </label>
      <label class="field">
        <span>Client-ID</span>
        <input autocomplete="off" {...field('clientId')} />
      </label>
      <label class="field">
        <span>Client-Secret {form.hasSecret && <em>(gespeichert, leer lassen zum Behalten)</em>}</span>
        <input
          type="password"
          autocomplete="new-password"
          value={secret}
          onInput={(e) => setSecret((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span>Scopes</span>
        <input {...field('scopes')} />
      </label>
      <label class="field">
        <span>
          Claim mit den Gruppen <em>(z. B. groups oder realm_access.roles)</em>
        </span>
        <input {...field('groupsClaim')} />
      </label>
      <label class="field">
        <span>Beschriftung des Anmeldeknopfs</span>
        <input {...field('label')} />
      </label>
      <p class="admin-hint">
        Solange das Gemeinde-Konto eingeschaltet ist, zeigt die Anmeldeseite den lokalen Admin nicht mehr an. Er bleibt über{' '}
        <code class="admin-copy">/?admin</code> erreichbar.
      </p>
      {message && (
        <p class={message.ok ? 'admin-ok' : 'admin-error'} role="status">
          {message.text}
        </p>
      )}
      <div class="actions">
        <button type="submit" class="button-primary" disabled={busy}>
          Speichern
        </button>
        <button type="button" class="button-secondary" disabled={busy || !data?.issuer} onClick={() => void test()}>
          Verbindung testen
        </button>
      </div>
    </form>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState<{ text: string; ok: boolean } | undefined>();

  const submit = async (event: Event) => {
    event.preventDefault();
    try {
      await adminRequest('POST', '/api/auth/password', { current, next });
      setCurrent('');
      setNext('');
      setMessage({ text: 'Passwort geändert. Andere Geräte sind jetzt abgemeldet.', ok: true });
    } catch (e) {
      setMessage({ text: (e as Error).message, ok: false });
    }
  };

  return (
    <form class="admin-panel admin-form" onSubmit={submit}>
      <h2>Passwort des lokalen Admins</h2>
      <label class="field">
        <span>Bisheriges Passwort</span>
        <input
          type="password"
          autocomplete="current-password"
          value={current}
          onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span>
          Neues Passwort <em>(mindestens 10 Zeichen)</em>
        </span>
        <input
          type="password"
          autocomplete="new-password"
          minLength={10}
          value={next}
          onInput={(e) => setNext((e.target as HTMLInputElement).value)}
        />
      </label>
      {message && (
        <p class={message.ok ? 'admin-ok' : 'admin-error'} role="status">
          {message.text}
        </p>
      )}
      <div class="actions">
        <button type="submit" class="button-primary" disabled={!current || next.length < 10}>
          Passwort ändern
        </button>
      </div>
    </form>
  );
}

// ---------- Änderungen ----------

const CHANGES_PAGE = 50;

/** Wer hat in der Verwaltung was geändert, neueste zuerst (nur für Admins). */
function ChangesAdmin(_props: SectionProps) {
  const [items, setItems] = useState<Change[] | undefined>();
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | undefined>();

  const load = async (offset: number) => {
    try {
      const page = await adminRequest<{ items: Change[]; total: number }>(
        'GET',
        `/api/admin/changes${query({ limit: CHANGES_PAGE, offset })}`,
      );
      setItems((prev) => (offset ? [...(prev ?? []), ...page.items] : page.items));
      setTotal(page.total);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(0), []);

  return (
    <>
      <h1 class="page-title">Änderungen</h1>
      <p class="admin-hint">
        Was in der Verwaltung geändert wurde und von wem, neueste zuerst. Die letzten 5.000 Änderungen bleiben erhalten.
      </p>
      {error && !items ? (
        <ErrorNote message={error} />
      ) : !items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty title="Noch keine Änderungen" />
      ) : (
        <>
          <ul class="admin-list admin-changes">
            {items.map((change) => (
              <li key={change.id} class="admin-change">
                <span class="track-title">
                  {change.action}
                  {change.target && (
                    <>
                      {': '}
                      {change.albumId ? <a href={`/admin/album/${change.albumId}`}>{change.target}</a> : change.target}
                    </>
                  )}
                </span>
                <span class="track-sub">
                  {change.userName} · {new Date(change.at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              </li>
            ))}
          </ul>
          {items.length < total && (
            <button type="button" class="button-secondary admin-more" onClick={() => void load(items.length)}>
              Weitere laden
            </button>
          )}
        </>
      )}
    </>
  );
}
