/** Schmale Hülle um IndexedDB für die Offline-Kopien. */

const DB_NAME = 'gemeinde-offline';
export type StoreName = 'meta' | 'tracks' | 'parts';
const STORES: StoreName[] = ['meta', 'tracks', 'parts'];

let opening: Promise<IDBDatabase> | undefined;

export const idbSupported = () => typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && Boolean(crypto.subtle);

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('meta');
      db.createObjectStore('tracks', { keyPath: 'id' });
      // Schlüssel [trackId, Nummer]; Nummer -1 ist das Cover
      db.createObjectStore('parts');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  opening.catch(() => (opening = undefined));
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export async function idbGet<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return done((await store(name, 'readonly')).get(key)) as Promise<T | undefined>;
}

export async function idbGetAll<T>(name: StoreName, range?: IDBKeyRange): Promise<T[]> {
  return done((await store(name, 'readonly')).getAll(range)) as Promise<T[]>;
}

export async function idbPut(name: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  await done((await store(name, 'readwrite')).put(value, key));
}

export async function idbDelete(name: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
  await done((await store(name, 'readwrite')).delete(key));
}

/** Alle Stücke eines Titels, das Cover (-1) eingeschlossen */
export const partsOf = (trackId: number) => IDBKeyRange.bound([trackId, -1], [trackId, Infinity]);

/** Alles löschen, in einem Rutsch */
export async function idbClear(): Promise<void> {
  const tx = (await openDb()).transaction(STORES, 'readwrite');
  for (const name of STORES) tx.objectStore(name).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
