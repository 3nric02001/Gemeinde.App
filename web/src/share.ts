/**
 * Teilen: auf dem Handy das Teilen-Menü des Systems (WhatsApp, Nachricht …), sonst den Link kopieren.
 * Der Link führt nach der Anmeldung genau dorthin; wer kein Konto hat, sieht nur die Anmeldeseite.
 */
export async function shareLink(title: string, path: string): Promise<void> {
  const url = new URL(path, window.location.origin).toString();
  if (typeof navigator.share === 'function' && window.matchMedia?.('(hover: none)').matches) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (error) {
      // Abgebrochen: nichts weiter tun
      if ((error as DOMException).name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link kopiert');
  } catch {
    window.prompt('Link zum Kopieren:', url);
  }
}

/** Kurzer Hinweis unten am Rand, verschwindet von selbst */
export function showToast(text: string): void {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.textContent = text;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 2500);
}
