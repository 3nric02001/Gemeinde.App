import { useEffect, useState } from 'preact/hooks';

export type Role = 'listener' | 'manager' | 'admin';

export interface CurrentUser {
  id: number;
  name: string;
  role: Role;
  kind: 'local' | 'oidc';
}

export interface AuthState {
  /** undefined: wird noch geladen */
  user: CurrentUser | null | undefined;
  /** Anmeldung über den Identity Provider, falls eingerichtet */
  oidc: { label: string } | null;
  /** Hinweis für die Anmeldeseite, z. B. nach abgelaufener Sitzung */
  notice?: string;
}

const ORDER: Role[] = ['listener', 'manager', 'admin'];
export const hasRole = (user: CurrentUser | null | undefined, role: Role) =>
  Boolean(user && ORDER.indexOf(user.role) >= ORDER.indexOf(role));

export const ROLE_LABELS: Record<Role, string> = { listener: 'Hörer', manager: 'Manager', admin: 'Admin' };

let state: AuthState = { user: undefined, oidc: null };
const listeners = new Set<() => void>();

function set(next: Partial<AuthState>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function getAuth(): AuthState {
  return state;
}

export async function loadAuth(): Promise<void> {
  try {
    const res = await fetch('/api/auth/status', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Fehler ${res.status}`);
    const data = (await res.json()) as { user: CurrentUser | null; oidc: { label: string } | null };
    set({ user: data.user, oidc: data.oidc });
  } catch {
    set({ user: null, notice: 'Der Server ist gerade nicht erreichbar.' });
  }
}

/** Jede Antwort mit 401 heißt: Sitzung abgelaufen oder Zugang entzogen, zurück zur Anmeldung. */
export function sessionExpired(): void {
  if (state.user) set({ user: null, notice: 'Bitte melde dich erneut an.' });
}

export async function loginLocal(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = (await res.json().catch(() => ({}))) as { user?: CurrentUser; error?: string };
  if (!res.ok || !data.user) throw new Error(data.error ?? `Fehler ${res.status}`);
  set({ user: data.user, notice: undefined });
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  set({ user: null, notice: undefined });
}

/** Weiter zum Identity Provider; danach geht es zur aktuellen Seite zurück. */
export function loginOidc(): void {
  const returnTo = window.location.pathname + window.location.search;
  window.location.assign(`/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`);
}

export function useAuth(): AuthState {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    const update = () => setCurrent(state);
    listeners.add(update);
    update();
    return () => listeners.delete(update);
  }, []);
  return current;
}
