import { useEffect, useState } from 'preact/hooks';
import { connectOffline, offlineProfile, wipeOffline } from './offline';

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
  /** Name der Gemeinde und Begrüßung, in der Verwaltung einstellbar */
  branding: Branding;
  /** Server nicht erreichbar: nur offline gespeicherte Titel */
  offline?: boolean;
}

export interface Branding {
  name: string;
  welcome: string;
}

const ORDER: Role[] = ['listener', 'manager', 'admin'];
export const hasRole = (user: CurrentUser | null | undefined, role: Role) =>
  Boolean(user && ORDER.indexOf(user.role) >= ORDER.indexOf(role));

export const ROLE_LABELS: Record<Role, string> = { listener: 'Hörer', manager: 'Manager', admin: 'Admin' };

let state: AuthState = { user: undefined, oidc: null, branding: { name: 'Gemeinde.App', welcome: '' } };
const listeners = new Set<() => void>();

function set(next: Partial<AuthState>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function getAuth(): AuthState {
  return state;
}

export async function loadAuth(): Promise<void> {
  let data: { user: CurrentUser | null; oidc: { label: string } | null; branding?: Branding };
  try {
    const res = await fetch('/api/auth/status', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Fehler ${res.status}`);
    data = await res.json();
  } catch {
    // Unterwegs ohne Netz: mit gültigen Offline-Kopien geht es trotzdem weiter.
    const saved = await offlineProfile();
    if (saved) set({ user: saved.user, offline: true, notice: undefined, ...(saved.branding ? { branding: saved.branding } : {}) });
    else set({ user: null, offline: false, notice: 'Der Server ist gerade nicht erreichbar.' });
    document.title = state.branding.name;
    return;
  }
  set({ user: data.user, oidc: data.oidc, offline: false, ...(data.branding ? { branding: data.branding } : {}) });
  document.title = state.branding.name;
  // Der Server kennt die Sitzung nicht (mehr): Offline-Kopien gehören niemandem mehr.
  if (data.user) void connectOffline(data.user, state.branding);
  else void wipeOffline();
}

// Zurück im Netz: wieder richtig anmelden
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (state.offline) void loadAuth();
  });
}

/** Jede Antwort mit 401 heißt: Sitzung abgelaufen oder Zugang entzogen, zurück zur Anmeldung. */
export function sessionExpired(): void {
  if (!state.user) return;
  set({ user: null, notice: 'Bitte melde dich erneut an.' });
  void wipeOffline();
}

export async function loginLocal(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = (await res.json().catch(() => ({}))) as { user?: CurrentUser; error?: string };
  if (!res.ok || !data.user) throw new Error(data.error ?? `Fehler ${res.status}`);
  set({ user: data.user, notice: undefined, offline: false });
  void connectOffline(data.user, state.branding);
}

export async function logout(): Promise<void> {
  // Zuerst, solange die Sitzung noch gilt: Der Player sichert dabei den Hörstand.
  const { player } = await import('./player');
  player.reset();
  await wipeOffline();
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  set({ user: null, notice: undefined, offline: false });
}

/** Weiter zum Identity Provider; danach geht es zur aktuellen Seite zurück. */
export function loginOidc(): void {
  const returnTo = window.location.pathname + window.location.search;
  window.location.assign(`/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`);
}

/** Nach einer Änderung in der Verwaltung sofort überall den neuen Namen zeigen */
export function setBranding(branding: Branding): void {
  set({ branding });
  document.title = branding.name;
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
