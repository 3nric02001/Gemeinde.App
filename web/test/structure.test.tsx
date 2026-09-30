import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructurePanel, type Structure } from '../src/admin/Structure';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const structure: Structure = {
  kinds: [
    {
      name: 'Bibelstunde', plural: 'Bibelstunden', folder: 'Bibelstunden', folderPattern: '{datum}_{bibelstelle}',
      filePattern: '{datum}_{nr}', albumTitle: '{bibelstelle}', trackTitle: 'Teil {nr}', sermon: '', preferTags: true,
    },
    {
      name: 'Gottesdienst', plural: 'Gottesdienste', folder: '', folderPattern: '{datum}_{anlass}',
      filePattern: '{inhalt} - {titel}', albumTitle: '{anlass}', trackTitle: '{inhalt}: {titel}', sermon: 'Predigt', preferTags: true,
    },
  ],
  contents: ['Lied', 'Predigt', 'Begrüßung'],
  untitled: ['Begrüßung'],
};

const preview = {
  kinds: [
    {
      name: 'Gottesdienst', albums: 1, unmatchedFiles: 1,
      examples: [{
        folder: 'Audio Aufnahmen/2026/2026_08_30_Einschulung', date: '2026-08-30', title: 'Einschulung', speaker: null, passage: null,
        tracks: [
          { file: 'Predigt - Der gute Hirte.mp3', title: 'Predigt: Der gute Hirte', content: 'Predigt', matched: true },
          { file: '001.mp3', title: '001', content: null, matched: false },
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
    const folder = (await screen.findAllByLabelText(/Erkennen am Ordner/))[0] as HTMLInputElement;
    expect(folder.value).toBe('Bibelstunden');

    fireEvent.click(screen.getByRole('button', { name: 'Vorschau' }));
    expect(await screen.findByText('Predigt: Der gute Hirte')).toBeTruthy();
    expect(screen.getByText('1 Datei passt', { exact: false })).toBeTruthy();

    const title = screen.getAllByLabelText(/Titel einer Aufnahme/)[1] as HTMLInputElement;
    fireEvent.input(title, { target: { value: '{titel}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern und anwenden' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Gespeichert'));
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]!.body)).kinds[1].trackTitle).toBe('{titel}');
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
