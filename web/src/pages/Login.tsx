import { useState } from 'preact/hooks';
import { loginLocal, loginOidc, useAuth } from '../auth';
import { Icon } from '../components/Icon';

/** Rückmeldungen, mit denen der Server nach der OIDC-Anmeldung hierher zurückleitet (?anmeldung=…). */
const RESULTS: Record<string, string> = {
  'keine-gruppe': 'Dein Konto ist für die Gemeinde.App nicht freigeschaltet. Bitte wende dich an die Verwaltung.',
  gesperrt: 'Dein Zugang ist gesperrt. Bitte wende dich an die Verwaltung.',
  abgebrochen: 'Die Anmeldung wurde abgebrochen.',
  fehler: 'Die Anmeldung hat nicht geklappt. Bitte versuche es noch einmal.',
};

export function Login() {
  const auth = useAuth();
  const result = new URLSearchParams(window.location.search).get('anmeldung');
  const [local, setLocal] = useState(!auth.oidc);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const notice = error ?? (result && RESULTS[result]) ?? auth.notice;

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await loginLocal(username.trim(), password);
      if (result) window.history.replaceState(null, '', window.location.pathname);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="login">
      <div class="login-card">
        <p class="login-brand">
          <span class="brand-mark">
            <Icon name="cross" size={18} />
          </span>
          <span>Gemeinde.App</span>
        </p>
        <h1 class="page-title">Anmelden</h1>
        {notice && (
          <p class="admin-error" role="alert">
            {notice}
          </p>
        )}
        {auth.oidc && (
          <button type="button" class="button-primary login-oidc" onClick={loginOidc}>
            {auth.oidc.label}
          </button>
        )}
        {!auth.oidc && <p class="admin-hint">Die Anmeldung über das Gemeinde-Konto ist noch nicht eingerichtet.</p>}
        {local ? (
          <form class="admin-login" onSubmit={submit}>
            <label class="field">
              <span>Benutzername</span>
              <input
                value={username}
                autocomplete="username"
                onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
              />
            </label>
            <label class="field">
              <span>Passwort</span>
              <input
                type="password"
                value={password}
                autocomplete="current-password"
                autoFocus
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
            </label>
            <button type="submit" class={auth.oidc ? 'button-secondary' : 'button-primary'} disabled={busy || !password}>
              Als Admin anmelden
            </button>
          </form>
        ) : (
          <button type="button" class="link-button" onClick={() => setLocal(true)}>
            Als lokaler Admin anmelden
          </button>
        )}
      </div>
    </main>
  );
}
