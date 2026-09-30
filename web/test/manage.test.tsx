import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roleOrigin, type AdminGroup, type AdminUser } from '../src/admin/Access';
import { Admin } from '../src/admin/Admin';
import { loadAuth } from '../src/auth';

/** Verwaltung aus Sicht von Managern und Admins: Album-Editor, Albumliste, Benutzer, Gruppen, Anmeldung */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const at = (path: string, search = '') => ({ path, params: new URLSearchParams(search) });

async function signedInAs(role: 'manager' | 'admin') {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ user: { id: 1, name: 'Anna', role, kind: 'oidc' }, oidc: null }));
  await loadAuth();
  vi.restoreAllMocks();
}

const noOverrides = { title: null, year: null, speaker: null, passage: null, description: null };
const track = { id: 11, title: 'Predigt_final2', album: '2026-09-27 Erntedank', albumId: 7, duration: 1800, hasCover: false, speaker: null };
const service = {
  id: 7,
  kind: 'auto',
  title: '2026-09-27 Erntedank',
  year: 2026,
  date: '2026-09-27',
  speaker: null,
  passage: null,
  description: null,
  trackCount: 1,
  duration: 1800,
  hasCover: false,
  hidden: false,
  folder: 'Gottesdienste/2026/2026-09-27 Erntedank',
  overrides: noOverrides,
  tracks: [track],
  trackEdits: [{ id: 11, fileTitle: 'Predigt_final2', title: null, speaker: null, fileSpeaker: null }],
  customCover: false,
  lastChange: { id: 1, at: Date.UTC(2026, 8, 29, 20, 13), userId: 2, userName: 'Anna Beispiel', action: 'Album bearbeitet (Sprecher)', target: null, albumId: 7 },
  excluded: [],
  missing: [],
  rules: [],
  ruleTrackIds: [],
  movedByRule: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Album-Editor', () => {
  it('zeigt einen Gottesdienst wie Hörer ihn sehen und bearbeitet den Anlass statt des Ordnernamens', async () => {
    await signedInAs('manager');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'PATCH') return json({ ...service, title: 'Erntedank-Gottesdienst', overrides: { ...noOverrides, title: 'Erntedank-Gottesdienst' } });
      return json(service);
    });
    render(<Admin location={at('/admin/album/7')} />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Erntedank'));
    expect(screen.getByText('Zuletzt geändert von Anna Beispiel', { exact: false })).toBeTruthy();
    // Datum nur zum Lesen, mit Herkunft; kein Jahr-Feld bei Gottesdiensten
    expect(screen.getByText('Aus dem Ordner „2026-09-27 Erntedank“', { exact: false })).toBeTruthy();
    expect(screen.queryByLabelText('Jahr')).toBeNull();
    // Sprecher nur je Titel, am Album alle Bibelstellen
    expect(screen.queryByLabelText('Sprecher')).toBeNull();
    expect(screen.getByLabelText('Bibelstellen')).toBeTruthy();
    const occasion = screen.getByLabelText('Anlass') as HTMLInputElement;
    expect(occasion.value).toBe('Erntedank');
    expect(screen.getByText('Aus dem Ordnernamen')).toBeTruthy();

    fireEvent.input(occasion, { target: { value: 'Erntedank-Gottesdienst' } });
    fireEvent.submit(occasion.closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(patch[1]!.body as string)).toEqual({ title: 'Erntedank-Gottesdienst' });
    await waitFor(() => expect(screen.getByText('Von Hand geändert', { exact: false })).toBeTruthy());
  });

  it('blendet Predigt-Felder bei Musik aus', async () => {
    await signedInAs('manager');
    const music = { ...service, id: 8, title: 'Let There Be Light', date: null, folder: 'Hillsong/Let There Be Light' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(music));
    render(<Admin location={at('/admin/album/8')} />);
    await waitFor(() => expect(screen.getByLabelText('Titel')).toBeTruthy());
    expect(screen.queryByLabelText('Sprecher')).toBeNull();
    expect(screen.queryByLabelText('Bibelstellen')).toBeNull();
    expect((screen.getByLabelText('Beschreibung für Hörer') as HTMLTextAreaElement).placeholder).toBe('Ein, zwei Sätze zum Album');
  });

  it('schaltet die Sichtbarkeit oben im Kopf', async () => {
    await signedInAs('manager');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      json(init?.method === 'PATCH' ? { ...service, hidden: true } : service),
    );
    render(<Admin location={at('/admin/album/7')} />);
    const visible = await screen.findByRole('switch', { name: 'Für Hörer sichtbar' });
    expect((visible as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Ansehen').getAttribute('href')).toBe('/album/7');
    fireEvent.click(visible);
    await waitFor(() => expect(screen.getByText('Hörer finden dieses Album nicht', { exact: false })).toBeTruthy());
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(patch[1]!.body as string)).toEqual({ hidden: true });
  });

  it('korrigiert Name und Sprecher eines Titels', async () => {
    await signedInAs('manager');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      json(
        init?.method === 'PATCH'
          ? {
              ...service,
              tracks: [{ ...track, title: 'Predigt: Dankbar leben', speaker: 'Pastorin Schulz' }],
              trackEdits: [{ id: 11, fileTitle: 'Predigt_final2', title: 'Predigt: Dankbar leben', speaker: 'Pastorin Schulz', fileSpeaker: null }],
            }
          : service,
      ),
    );
    render(<Admin location={at('/admin/album/7')} />);
    fireEvent.click(await screen.findByLabelText('Predigt_final2 bearbeiten'));
    const form = screen.getByText('Die Korrektur bleibt auch nach neuen Scans erhalten', { exact: false }).closest('form')!;
    fireEvent.input(within(form).getByLabelText('Name'), { target: { value: 'Predigt: Dankbar leben' } });
    fireEvent.input(within(form).getByLabelText('Sprecher'), { target: { value: 'Pastorin Schulz' } });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText('korrigiert')).toBeTruthy());
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'PATCH')!;
    expect(url).toBe('/api/admin/albums/7/tracks/11');
    expect(JSON.parse(init!.body as string)).toEqual({ title: 'Predigt: Dankbar leben', speaker: 'Pastorin Schulz' });
    expect(screen.getByText('Pastorin Schulz')).toBeTruthy();
  });

  it('zeigt je Titel die greifende Policy und korrigiert Predigt und Player', async () => {
    await signedInAs('manager');
    const recording = {
      ...service,
      recording: 'Gottesdienst',
      tracks: [{ ...track, player: 'sermon' }],
      trackEdits: [
        {
          id: 11, fileTitle: 'Predigt_final2', title: null, speaker: null, fileSpeaker: null, sermon: null, player: null,
          auto: { sermon: true, sermonBy: 'Predigt im Gottesdienst', player: 'sermon', playerBy: 'Predigt im Gottesdienst' },
        },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input) === '/api/admin/structure'
        ? json({ structure: { kinds: [{ name: 'Bibelstunde' }, { name: 'Gottesdienst' }] } })
        : json(recording),
    );
    render(<Admin location={at('/admin/album/7')} />);
    expect((await screen.findByText('Predigt-Player', { selector: '.badge' })).getAttribute('title')).toBe('Policy „Predigt im Gottesdienst“');
    fireEvent.click(screen.getByLabelText('Predigt_final2 bearbeiten'));
    const form = screen.getByText('Die Korrektur bleibt auch nach neuen Scans erhalten', { exact: false }).closest('form')!;
    const player = within(form).getByLabelText('Player') as HTMLSelectElement;
    expect(player.options[0]!.textContent).toBe('Automatisch (Predigt-Player, Policy „Predigt im Gottesdienst“)');
    fireEvent.change(player, { target: { value: 'music' } });
    fireEvent.change(within(form).getByLabelText('Gilt als Predigt'), { target: { value: 'no' } });
    fireEvent.submit(form);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true));
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'PATCH')!;
    expect(url).toBe('/api/admin/albums/7/tracks/11');
    expect(JSON.parse(init!.body as string)).toEqual({ sermon: false, player: 'music' });

    // Die Art des Albums lässt sich von Hand setzen
    const kind = (await screen.findByLabelText('Art')) as HTMLSelectElement;
    await waitFor(() => expect(kind.disabled).toBe(false));
    expect([...kind.options].map((o) => o.textContent)).toEqual(['Automatisch (Gottesdienst)', 'Bibelstunde', 'Gottesdienst', 'Musik', 'Sonstiges']);
    fireEvent.change(kind, { target: { value: 'Bibelstunde' } });
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'PATCH').map(([, i]) => JSON.parse(i!.body as string))).toContainEqual({
        recording: 'Bibelstunde',
      }),
    );
  });

  it('lädt ein eigenes Titelbild hoch', async () => {
    await signedInAs('manager');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      json(init?.method === 'PUT' ? { ...service, hasCover: true, customCover: true } : service),
    );
    render(<Admin location={at('/admin/album/7')} />);
    const input = (await screen.findByText('Bild hochladen')).querySelector('input')!;
    const file = new File(['x'], 'bild.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText('Eigenes Bild entfernen')).toBeTruthy());
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'PUT')!;
    expect(url).toBe('/api/admin/albums/7/cover');
    expect((init!.headers as Record<string, string>)['content-type']).toBe('image/png');
  });
});

describe('Albumliste', () => {
  it('filtert nach Aufgaben, ohne Sprecher am Album', async () => {
    await signedInAs('manager');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/scan') {
        return json({ state: 'idle', filesSeen: 35, toRead: 0, read: 0, added: 0, updated: 0, removed: 0, failed: 0, lastError: null, lastSuccessAt: null, folders: [] });
      }
      return json({ items: [{ ...service, tracks: undefined }], total: 1, limit: 100, offset: 0 });
    });
    render(<Admin location={at('/admin', 'filter=gottesdienste')} />);
    await waitFor(() => expect(screen.getByText('Erntedank')).toBeTruthy());
    // Sprecher gibt es nur je Titel: kein Filter und kein Hinweis "Sprecher fehlt"
    expect(screen.queryByText('Sprecher fehlt')).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('/api/admin/albums?dated=true&sort=date&limit=100&offset=0');
    expect(screen.getByText('Gottesdienste', { selector: '.chip' }).getAttribute('aria-current')).toBe('true');
    // Der Scan braucht ohne Probleme nur eine Zeile
    expect(screen.queryByText('Abgleich mit der Nextcloud')).toBeNull();
    expect(screen.getByText('Jetzt scannen')).toBeTruthy();
  });
});

describe('Benutzer und Gruppen', () => {
  const groups: AdminGroup[] = [
    { name: 'Musikteam', enabled: true, role: 'manager', userCount: 1, lastSeenAt: 1 },
    { name: 'Jugend', enabled: false, role: 'listener', userCount: 1, lastSeenAt: 1 },
    { name: 'Gemeinde', enabled: true, role: 'listener', userCount: 1, lastSeenAt: 1 },
  ];
  const user = (id: number, name: string, role: AdminUser['role'], userGroups: string[], disabled = false): AdminUser => ({
    id,
    kind: 'oidc',
    username: null,
    name,
    email: `${name.split(' ')[0]!.toLowerCase()}@example.org`,
    role,
    groups: userGroups,
    disabled,
    lastLoginAt: 1,
  });
  const users = [
    user(2, 'Anna Beispiel', 'manager', ['Musikteam', 'Jugend']),
    user(3, 'Bernd Hörer', 'listener', ['Gemeinde']),
    user(4, 'Clara Gesperrt', 'listener', ['Gemeinde'], true),
  ];

  it('nennt, woher eine Rolle kommt', () => {
    expect(roleOrigin(users[0]!, groups)).toBe('Manager über Musikteam');
    expect(roleOrigin(users[1]!, groups)).toBe('Hörer über Gemeinde');
    expect(roleOrigin({ ...users[0]!, kind: 'local' }, groups)).toBeUndefined();
  });

  function mockAccess() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/admin/users') return json({ items: users });
      if (url.startsWith('/api/admin/groups')) {
        if (init?.method === 'PUT') return json({ items: groups.map((g) => (g.name === 'Jugend' ? { ...g, enabled: true } : g)), lastDenied: null });
        return json({ items: groups, lastDenied: null });
      }
      return json({ error: 'unerwartet' }, 500);
    });
  }

  it('sucht, zählt je Rolle und filtert nach Gruppe', async () => {
    await signedInAs('admin');
    mockAccess();
    render(<Admin location={at('/admin/benutzer')} />);
    await waitFor(() => expect(screen.getByText('Manager über Musikteam · Gruppen: Musikteam, Jugend')).toBeTruthy());
    const chips = screen.getByRole('navigation', { name: 'Benutzer filtern' });
    expect(chips.textContent).toBe('Alle 3Hörer 1Manager 1Gesperrt 1');
    fireEvent.input(screen.getByLabelText('Benutzer suchen'), { target: { value: 'bernd' } });
    expect(screen.queryByText('Anna Beispiel')).toBeNull();
    expect(screen.getByText('Bernd Hörer')).toBeTruthy();
    cleanup();

    render(<Admin location={at('/admin/benutzer', 'gruppe=Jugend')} />);
    await waitFor(() => expect(screen.getByText('Anna Beispiel')).toBeTruthy());
    expect(screen.queryByText('Bernd Hörer')).toBeNull();
    expect(screen.getByText('Gruppe: Jugend')).toBeTruthy();
  });

  it('schaltet Gruppen mit einem Schalter frei und verlinkt ihre Benutzer', async () => {
    await signedInAs('admin');
    const fetchMock = mockAccess();
    render(<Admin location={at('/admin/gruppen')} />);
    await waitFor(() => expect(screen.getByText('Jugend')).toBeTruthy());
    expect(screen.getByText('verwalten zusätzlich Benutzer, Gruppen', { exact: false })).toBeTruthy();
    const row = screen.getByText('Jugend').closest('li')!;
    expect(within(row).getByText('1 Benutzer').getAttribute('href')).toBe('/admin/benutzer?gruppe=Jugend');
    expect(within(row).getByText('Mitglieder kommen nur über eine andere', { exact: false })).toBeTruthy();
    expect((within(row).getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(within(row).getByRole('switch', { name: 'Darf sich anmelden' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([, i]) => i?.method === 'PUT')!;
    expect(put[0]).toBe('/api/admin/groups/Jugend');
    expect(JSON.parse(put[1]!.body as string)).toEqual({ enabled: true });
  });
});

describe('Anmeldung', () => {
  const oidc = {
    issuer: 'https://login.example.org',
    clientId: 'app',
    hasSecret: true,
    scopes: 'openid profile email',
    groupsClaim: 'groups',
    label: 'Mit Gemeinde-Konto anmelden',
    redirectUri: 'http://localhost/api/auth/oidc/callback',
    publicUrlMissing: true,
  };
  const mockLogin = (enabled: boolean) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/admin/branding') return json({ name: 'Gemeinde.App', welcome: '' });
      if (url === '/api/admin/oidc') return json({ ...oidc, enabled });
      return json({ error: 'unerwartet' }, 500);
    });

  it('warnt nicht rot, wenn die Anmeldung ohne PUBLIC_URL schon läuft', async () => {
    await signedInAs('admin');
    mockLogin(true);
    render(<Admin location={at('/admin/anmeldung')} />);
    const note = await screen.findByText('Die Anmeldung läuft', { exact: false });
    expect(note.className).toBe('admin-note');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('switch', { name: 'Anmeldung über das Gemeinde-Konto' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('erklärt, was zum Einschalten fehlt', async () => {
    await signedInAs('admin');
    mockLogin(false);
    render(<Admin location={at('/admin/anmeldung')} />);
    await screen.findByText('Zum Einschalten zuerst PUBLIC_URL', { exact: false });
    expect((screen.getByRole('switch', { name: 'Anmeldung über das Gemeinde-Konto' }) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Änderungen', () => {
  it('listet, wer was geändert hat, mit Link zum Album', async () => {
    await signedInAs('admin');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        items: [
          { id: 2, at: Date.UTC(2026, 8, 29, 20, 13), userId: 2, userName: 'Anna Beispiel', action: 'Album ausgeblendet', target: 'Erntedank', albumId: 7 },
          { id: 1, at: Date.UTC(2026, 8, 29, 20, 0), userId: 1, userName: 'Administrator', action: 'Gruppe freigeschaltet', target: 'Jugend', albumId: null },
        ],
        total: 2,
      }),
    );
    render(<Admin location={at('/admin/aenderungen')} />);
    await waitFor(() => expect(screen.getByText('Erntedank')).toBeTruthy());
    expect(screen.getByText('Erntedank').getAttribute('href')).toBe('/admin/album/7');
    expect(screen.getByText('Gruppe freigeschaltet', { exact: false }).textContent).toBe('Gruppe freigeschaltet: Jugend');
  });
});
