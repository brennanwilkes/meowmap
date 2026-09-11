/* A thin promise wrapper over IndexedDB. No library — the surface we need is small and
 * a CDN dependency for it would be more code than this file.
 *
 * Schema, version 1:
 *   outbox    keyPath clientId   — queued uploads, the DURABLE part (see outbox.js)
 *   sightings keyPath id         — local cache of server rows, for offline map render
 *   cats      keyPath id
 *   meta      keyPath key        — cursors, flags, the persist() result
 */

export const DB_NAME = 'meowmap';
export const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      // Surfaced, not swallowed: with no IndexedDB there is no outbox, and with no
      // outbox a camera photo has nowhere to live if the upload fails.
      reject(new Error('IndexedDB is unavailable — offline saving cannot work here'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) {
        const s = db.createObjectStore('outbox', { keyPath: 'clientId' });
        s.createIndex('by_state', 'state');
        // Compound, so the flush loop can ask "what is due?" in one range query
        // instead of scanning every row on every trigger.
        s.createIndex('by_due', ['state', 'nextAttemptAt']);
        s.createIndex('by_createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('sightings')) {
        const s = db.createObjectStore('sightings', { keyPath: 'id' });
        // The dedupe join key between server rows and pending rows.
        s.createIndex('by_clientId', 'clientId', { unique: true });
        s.createIndex('by_catId', 'catId');
      }
      if (!db.objectStoreNames.contains('cats')) db.createObjectStore('cats', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      void e;
    };

    req.onsuccess = () => {
      const db = req.result;
      // iOS can close the connection under memory pressure; drop the cached promise so
      // the next call reopens rather than using a dead handle.
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB'));
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let out;
    try {
      out = fn(os);
    } catch (err) {
      tx.abort();
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  }));
}

export const get = (store, key) => run(store, 'readonly', (os) => os.get(key));
export const put = (store, value) => run(store, 'readwrite', (os) => os.put(value));
export const del = (store, key) => run(store, 'readwrite', (os) => os.delete(key));
export const getAll = (store) => run(store, 'readonly', (os) => os.getAll());
export const clear = (store) => run(store, 'readwrite', (os) => os.clear());

export function getAllByIndex(store, index, query) {
  return run(store, 'readonly', (os) => os.index(index).getAll(query));
}

/**
 * Two stores, one transaction. This is what makes "the upload succeeded" atomic: the
 * server row is written and the outbox row deleted together, so a crash between them
 * can never lose both. Doing it as two separate calls is the bug this exists to avoid.
 */
export function tx2(storeA, storeB, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction([storeA, storeB], 'readwrite');
    try {
      fn(tx.objectStore(storeA), tx.objectStore(storeB));
    } catch (err) {
      tx.abort();
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  }));
}

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row === undefined ? fallback : row.value;
}

export function setMeta(key, value) {
  return put('meta', { key, value });
}
