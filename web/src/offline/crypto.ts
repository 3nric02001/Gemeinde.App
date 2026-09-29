/**
 * Verschlüsselung der Offline-Kopien: AES-GCM mit dem Schlüssel des Benutzers vom Server.
 * Der Schlüssel wird als nicht exportierbarer CryptoKey importiert; auch Skripte der App kommen
 * nicht mehr an seine Bytes, gespeicherte Daten sind außerhalb der App nur Datensalat.
 */

export interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function importKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64Url(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Bindet jedes Stück an Schlüssel, Titel und Position: Vertauschte oder fremde Stücke fallen auf. */
const context = (keyId: string, trackId: number, part: number) => new TextEncoder().encode(`${keyId}:${trackId}:${part}`);

export async function seal(key: CryptoKey, keyId: string, trackId: number, part: number, data: BufferSource): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(keyId, trackId, part) }, key, data);
  return { iv, data: sealed };
}

export function unseal(key: CryptoKey, keyId: string, trackId: number, part: number, sealed: Sealed): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.iv as Uint8Array<ArrayBuffer>, additionalData: context(keyId, trackId, part) },
    key,
    sealed.data,
  );
}
