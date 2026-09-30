import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructurePanel, type Structure } from '../src/admin/Structure';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const structure: Structure = {
  kinds: [
    {
      name: 'Bibelstunde', plural: 'Bibelstunden', match: { field: 'folder', op: 'equals', value: 'Bibelstunden' }, datedOnly: true,
      folderPattern: '{datum}_{bibelstelle}', filePattern: '{datum}_{nr}', albumTitle: '{bibelstelle}', trackTitle: 'Teil {nr}',
      preferTags: true,
    },
    {
      name: 'Gottesdienst', plural: 'Gottesdienste', match: null, datedOnly: true, folderPattern: '{datum}_{anlass}',
      filePattern: '{inhalt} - {titel}', albumTitle: '{anlass}', trackTitle: '{inhalt}: {titel}', preferTags: true,
    },
  ],
  contents: ['Lied', 'Predigt', 'Begrüßung'],
  untitled: ['Begrüßung'],
  policies: [
    {
      name: 'Predigt im Gottesdienst', enabled: true, sermon: true, player: 'sermon',
      when: { match: 'all', conditions: [{ field: 'kind', op: 'equals', value: 'Gottesdienst' }, { field: 'content', op: 'equals', value: 'Predigt' }] },
    },
  ],
};

const preview = {
  kinds: [
    {
      name: 'Gottesdienst', albums: 1, unmatchedFiles: 1,
      examples: [{
        folder: 'Audio Aufnahmen/2026/2026_08_30_Einschulung', date: '2026-08-30', title: 'Einschulung', speaker: null, passage: null,
        tracks: [
          { file: 'Predigt - Der gute Hirte.mp3', title: 'Predigt: Der gute Hirte', content: 'Predigt', matched: true, sermon: true, player: 'sermon' },
          { file: '001.mp3', title: '001', content: null, matched: false, sermon: false, player: 'music' },
        ],
      }],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Zuordnung in der Verwaltung', () => {
  it('zeigt das Regelwerk, eine Vorschau und speichert Änderungen', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/admin/structure' && (init?.method ?? 'GET') === 'GET') return json({ structure, defaults: structure });
      if (url === '/api/admin/structure' && init?.method === 'PUT') return json({ structure: JSON.parse(String(init.body)) });
      if (url === '/api/admin/structure/preview') return json(preview);
      return json({ error: 'unerwartet' }, 500);
    });
    render(<StructurePanel />);
    const values = (await screen.findAllByLabelText('Suchbegriff')) as HTMLInputElement[];
    expect(values.map((input) => input.value)).toEqual(['Bibelstunden', 'Gottesdienst', 'Predigt']);
    expect(screen.getByRole('button', { name: 'Bedingung festlegen' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Vorschau' }));
    expect(await screen.findByText('Predigt: Der gute Hirte')).toBeTruthy();
    expect(screen.getByText('1 Datei passt', { exact: false })).toBeTruthy();
    expect(screen.getByText('Predigt-Player', { selector: '.badge' })).toBeTruthy();

    const title = screen.getAllByLabelText(/Titel einer Aufnahme/)[1] as HTMLInputElement;
    fireEvent.input(title, { target: { value: '{titel}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und anwenden' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Gespeichert'));
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]!.body)).kinds[1].trackTitle).toBe('{titel}');
  });

  it('legt Policies an: z. B. Konzerte immer im Musik-Player', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') return json({ structure: JSON.parse(String(init.body)) });
      if (String(input).endsWith('/preview')) return json({ kinds: [] });
      return json({ structure, defaults: structure });
    });
    render(<StructurePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Policy hinzufügen' }));
    fireEvent.input(screen.getByPlaceholderText('Policy 2'), { target: { value: 'Konzerte' } });
    const fields = screen.getAllByLabelText('Feld') as HTMLSelectElement[];
    fireEvent.change(fields[fields.length - 1]!, { target: { value: 'genre' } });
    const values = screen.getAllByLabelText('Suchbegriff') as HTMLInputElement[];
    fireEvent.input(values[values.length - 1]!, { target: { value: 'Konzert' } });
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const sermon = selects.filter((s) => s.closest('label')?.textContent?.startsWith('Gilt als Predigt')).pop()!;
    const player = selects.filter((s) => s.closest('label')?.textContent?.startsWith('Player')).pop()!;
    fireEvent.change(sermon, { target: { value: '' } });
    fireEvent.change(player, { target: { value: 'music' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und anwenden' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]!.body)).policies[1]).toEqual({
      name: 'Konzerte',
      enabled: true,
      when: { match: 'all', conditions: [{ field: 'genre', op: 'equals', value: 'Konzert' }] },
      player: 'music',
    });
  });

  it('zeigt Fehler des Servers verständlich an', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      init?.method === 'PUT'
        ? json({ error: 'Gottesdienst, Dateien: Unbekannter Platzhalter {teil}' }, 400)
        : json({ structure, defaults: structure }),
    );
    render(<StructurePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Speichern und anwenden' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unbekannter Platzhalter {teil}');
  });
});
