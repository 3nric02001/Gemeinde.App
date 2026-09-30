import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeRule, type AdminAlbumDetail, type RuleCondition } from '../src/admin/api';
import { Rules } from '../src/admin/Rules';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const album = { rules: [] } as unknown as AdminAlbumDetail;

describe('Regeln', () => {
  it('beschreibt verschachtelte Regeln lesbar', () => {
    const condition: RuleCondition = {
      match: 'all',
      conditions: [
        { field: 'title', op: 'contains', value: 'Predigt' },
        { match: 'any', conditions: [{ field: 'speaker', op: 'equals', value: 'A' }, { field: 'path', op: 'not_contains', value: 'Jugend' }] },
      ],
    };
    expect(describeRule(condition)).toBe(
      'Titel enthält „Predigt“ und (Sprecher ist genau „A“ oder Ordner/Dateiname enthält nicht „Jugend“)',
    );
  });

  it('baut eine Regel mit Untergruppe zusammen', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"total":0,"items":[]}'));
    const onSave = vi.fn();
    render(<Rules album={album} busy={false} onSave={onSave} onDelete={() => {}} />);
    fireEvent.input(screen.getAllByLabelText('Suchbegriff')[0]!, { target: { value: 'Predigt' } });
    fireEvent.click(screen.getByText('+ Gruppe'));
    const inputs = screen.getAllByLabelText('Suchbegriff');
    fireEvent.change(screen.getAllByLabelText('Feld')[1]!, { target: { value: 'speaker' } });
    fireEvent.input(inputs[1]!, { target: { value: 'Meier' } });
    // Der Knopf der Untergruppe steht im DOM vor dem der obersten Ebene
    fireEvent.click(screen.getAllByText('+ Bedingung')[0]!);
    fireEvent.input(screen.getAllByLabelText('Suchbegriff')[2]!, { target: { value: 'Schulz' } });
    fireEvent.click(screen.getByText('Regel hinzufügen'));
    expect(onSave).toHaveBeenCalledWith(
      {
        condition: {
          match: 'all',
          conditions: [
            { field: 'title', op: 'contains', value: 'Predigt' },
            {
              match: 'any',
              conditions: [
                { field: 'speaker', op: 'contains', value: 'Meier' },
                { field: 'title', op: 'contains', value: 'Schulz' },
              ],
            },
          ],
        },
        move: false,
      },
      undefined,
    );
  });
});
