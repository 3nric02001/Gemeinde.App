import type { FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ROLE_LABELS, useAuth, type Role } from '../auth';
import { Empty, ErrorNote, Loading } from '../pages/common';
import { adminRequest } from './api';

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

export interface OidcView {
  enabled: boolean;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  scopes: string;
  groupsClaim: string;
  label: string;
  redirectUri: string;
}

const ROLES: Role[] = ['listener', 'manager', 'admin'];
const ROLE_HINTS: Record<Role, string> = {
  listener: 'nur hören',
  manager: 'Alben und Titel bearbeiten',
  admin: 'alles, auch Benutzer und Anmeldung',
};

export const ACCESS_SECTIONS: Array<{ path: string; label: string; Component: FunctionComponent }> = [
  { path: '/admin/benutzer', label: 'Benutzer', Component: UsersAdmin },
  { path: '/admin/gruppen', label: 'Gruppen', Component: GroupsAdmin },
  { path: '/admin/anmeldung', label: 'Anmeldung', Component: LoginAdmin },
];

/** Reiter der Verwaltung; Benutzer, Gruppen und Anmeldung nur für Admins. */
export function AdminTabs({ path, admin }: { path: string; admin: boolean }) {
  const tabs = [{ path: '/admin', label: 'Alben' }, { path: '/admin/kategorien', label: 'Kategorien' }, ...(admin ? ACCESS_SECTIONS : [])];
  const active = tabs.find((t) => t.path === path)?.path ?? '/admin';
  return (
    <nav class="chips-row admin-tabs" aria-label="Bereiche der Verwaltung">
      {tabs.map((tab) => (
        <a
          key={tab.path}
          href={tab.path}
          class={`chip${tab.path === active ? ' is-on' : ''}`}
          aria-current={tab.path === active ? 'page' : undefined}
        >
          {tab.label}
        </a>
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

function UsersAdmin() {
  const [data, error, setData] = useLoad<{ items: AdminUser[] }>('/api/admin/users');
  const [actionError, setActionError] = useState<string | undefined>();

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
      setData(await adminRequest<{ items: AdminUser[] }>('GET', '/api/admin/users'));
      setActionError(undefined);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

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
        <ul class="admin-list">
          {data.items.map((user) => (
            <li key={user.id} class="admin-row admin-user">
              <span class="track-main">
                <span class="track-title">{user.name}</span>
                <span class="track-sub">
                  {user.kind === 'local'
                    ? `Lokaler Admin · Benutzername ${user.username}`
                    : [user.email, user.groups.length ? `Gruppen: ${user.groups.join(', ')}` : 'keine Gruppen']
                        .filter(Boolean)
                        .join(' · ')}
                  {' · '}Zuletzt angemeldet: {dateOf(user.lastLoginAt)}
                </span>
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
                    class="button-secondary button-small"
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
          ))}
        </ul>
      )}
    </>
  );
}

// ---------- Gruppen ----------

function GroupsAdmin() {
  const [data, error, setData] = useLoad<{ items: AdminGroup[] }>('/api/admin/groups');
  const [actionError, setActionError] = useState<string | undefined>();
  const [name, setName] = useState('');

  const save = async (group: string, body: { enabled?: boolean; role?: Role }) => {
    try {
      setData(await adminRequest<{ items: AdminGroup[] }>('PUT', `/api/admin/groups/${encodeURIComponent(group)}`, body));
      setActionError(undefined);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  const remove = async (group: string) => {
    try {
      setData(await adminRequest<{ items: AdminGroup[] }>('DELETE', `/api/admin/groups/${encodeURIComponent(group)}`));
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
        Rolle.
      </p>
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
      {error ? (
        <ErrorNote message={error} />
      ) : !data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty title="Noch keine Gruppen">Sie erscheinen nach der ersten Anmeldung über das Gemeinde-Konto.</Empty>
      ) : (
        <ul class="admin-list">
          {data.items.map((group) => (
            <li key={group.name} class="admin-row admin-group">
              <label class="admin-check">
                <input
                  type="checkbox"
                  checked={group.enabled}
                  onChange={(e) => void save(group.name, { enabled: (e.target as HTMLInputElement).checked })}
                />
                <span class="track-main">
                  <span class="track-title">{group.name}</span>
                  <span class="track-sub">
                    {group.userCount === 1 ? '1 Benutzer' : `${group.userCount} Benutzer`} · zuletzt gesehen:{' '}
                    {dateOf(group.lastSeenAt)}
                  </span>
                </span>
              </label>
              <label class="field admin-role">
                <span class="visually-hidden">Rolle für {group.name}</span>
                <select
                  value={group.role}
                  disabled={!group.enabled}
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
                onClick={() => void remove(group.name)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------- Anmeldung (OIDC und lokaler Admin) ----------

function LoginAdmin() {
  const { user } = useAuth();
  return (
    <>
      <h1 class="page-title">Anmeldung</h1>
      <OidcSettings />
      {user?.kind === 'local' && <PasswordForm />}
    </>
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
      const { redirectUri: _r, hasSecret: _h, ...rest } = form;
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
      <label class="admin-check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: (e.target as HTMLInputElement).checked })}
        />
        <span>Anmeldung über das Gemeinde-Konto einschalten</span>
      </label>
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
