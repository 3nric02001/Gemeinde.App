import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finishOnboarding, getAuth, showOnboarding } from '../src/auth';
import { Onboarding } from '../src/components/Onboarding';

beforeEach(() => {
  (getAuth() as { user: unknown }).user = { id: 1, name: 'Anna', role: 'listener', kind: 'oidc', onboarded: false };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Einführung', () => {
  it('führt in vier Schritten durch und merkt sich das Ende am Server', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    render(<Onboarding />);
    expect(screen.getByText('Schritt 1 von 4')).toBeTruthy();
    fireEvent.click(screen.getByText('Weiter'));
    expect(screen.getByText('Suchen und stöbern')).toBeTruthy();
    fireEvent.click(screen.getByText('Zurück'));
    expect(screen.getByText('Schritt 1 von 4')).toBeTruthy();
    fireEvent.click(screen.getByText('Weiter'));
    fireEvent.click(screen.getByText('Weiter'));
    fireEvent.click(screen.getByText('Weiter'));
    expect(screen.getByText('Favoriten und Einstellungen')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Los geht’s'));
    expect(fetch).toHaveBeenCalledWith('/api/me/onboarding', { method: 'POST' });
  });

  it('lässt sich überspringen und wieder öffnen', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    render(<Onboarding />);
    fireEvent.click(screen.getByText('Überspringen'));
    expect(getAuth().user?.onboarded).toBe(true);
    showOnboarding();
    expect(getAuth().user?.onboarded).toBe(false);
    finishOnboarding();
    expect(getAuth().user?.onboarded).toBe(true);
  });
});
