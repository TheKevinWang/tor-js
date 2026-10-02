import type { TorStorageSimple } from './locking.js';

export class IndexedDBStorage implements TorStorageSimple {
  private dbName: string;
  private storeName = 'keyvalue';
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(name: string = 'tor-js') {
    this.dbName = name;
  }

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName);
          }
        };
      });
    }
    return this.dbPromise;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(request.result === undefined ? null : request.result);
      };
    });
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.put(value, key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.delete(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * The key range holding exactly the keys that start with `prefix`. Without it
   * every call reads the whole store: the directory cache is ~10 000 entries,
   * and the Tor client asks for the `state:` prefix (two keys) and the `dir:`
   * prefix at every start, so each start read everything twice.
   */
  private rangeFor(prefix: string): IDBKeyRange | undefined {
    return prefix === '' ? undefined : IDBKeyRange.bound(prefix, prefix + '￿');
  }

  async keys(prefix: string): Promise<string[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.getAllKeys(this.rangeFor(prefix));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const allKeys = request.result as string[];
        resolve(allKeys.filter(k => k.startsWith(prefix)).sort());
      };
    });
  }

  async getAll(prefix: string): Promise<[string, string][]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const range = this.rangeFor(prefix);
      const keysReq = store.getAllKeys(range);
      const valsReq = store.getAll(range);
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        const keys = keysReq.result as string[];
        const vals = valsReq.result as string[];
        const result: [string, string][] = [];
        for (let i = 0; i < keys.length; i++) {
          if (keys[i].startsWith(prefix)) {
            result.push([keys[i], vals[i]]);
          }
        }
        resolve(result);
      };
    });
  }
}
