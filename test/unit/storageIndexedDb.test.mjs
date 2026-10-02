// IndexedDBStorage reads only the key range it needs (src/storage/indexeddb.ts),
// against a minimal fake of the IndexedDB API that records the ranges asked for.
//
//   npm run test:unit

import { test, before, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

/** Just enough IndexedDB for one object store of string keys. */
function installFakeIndexedDb() {
  const data = new Map()
  const calls = []
  const inRange = (k, r) => !r || (k >= r.lower && k <= r.upper)
  const later = (fn) => queueMicrotask(fn)
  const request = (compute) => {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null }
    later(() => { req.result = compute(); req.onsuccess?.() })
    return req
  }
  const store = {
    get: (k) => request(() => data.get(k)),
    put: (v, k) => request(() => { data.set(k, v) }),
    delete: (k) => request(() => { data.delete(k) }),
    getAllKeys: (r) => { calls.push(['getAllKeys', r ?? null]); return request(() => [...data.keys()].filter((k) => inRange(k, r)).sort()) },
    getAll: (r) => { calls.push(['getAll', r ?? null]); return request(() => [...data.keys()].filter((k) => inRange(k, r)).sort().map((k) => data.get(k))) },
  }
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction() {
      const tx = { objectStore: () => store, oncomplete: null, onerror: null }
      // complete after the queued requests have run
      later(() => later(() => later(() => tx.oncomplete?.())))
      return tx
    },
  }
  globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) }
  globalThis.indexedDB = {
    open() {
      const req = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null }
      later(() => req.onsuccess?.())
      return req
    },
  }
  return { data, calls }
}

let IndexedDBStorage
before(async () => {
  installFakeIndexedDb()
  ;({ IndexedDBStorage } = await bundleTs('src/storage/indexeddb.ts', 'idb-storage'))
})

describe('IndexedDBStorage prefix reads', () => {
  let fake
  beforeEach(() => {
    fake = installFakeIndexedDb()
    for (const [k, v] of [
      ['state:guards', 'g'], ['state:circuit_timeouts', 't'],
      ['dir:md:a', '1'], ['dir:md:b', '2'], ['dir:consensus:x', '3'],
      ['other', 'o'], ['stat', 's'], ['dire', 'd'],
    ]) fake.data.set(k, v)
  })

  test('getAll asks the database for the prefix range, not the whole store', async () => {
    const store = new IndexedDBStorage('t')
    const state = await store.getAll('state:')
    assert.deepEqual(state, [['state:circuit_timeouts', 't'], ['state:guards', 'g']])
    assert.deepEqual(fake.calls.map(([, r]) => r), [{ lower: 'state:', upper: 'state:￿' }, { lower: 'state:', upper: 'state:￿' }])
  })

  test('getAll("dir:") returns only dir: keys and does not pick up lookalikes', async () => {
    const dir = await new IndexedDBStorage('t').getAll('dir:')
    assert.deepEqual(dir.map(([k]) => k), ['dir:consensus:x', 'dir:md:a', 'dir:md:b'])
  })

  test('keys() uses the range too, sorted', async () => {
    const keys = await new IndexedDBStorage('t').keys('dir:md:')
    assert.deepEqual(keys, ['dir:md:a', 'dir:md:b'])
    assert.deepEqual(fake.calls[0][1], { lower: 'dir:md:', upper: 'dir:md:￿' })
  })

  test('an empty prefix still reads everything', async () => {
    const all = await new IndexedDBStorage('t').getAll('')
    assert.equal(all.length, 8)
    assert.deepEqual(fake.calls.map(([, r]) => r), [null, null])
  })

  test('get, set and delete are unchanged', async () => {
    const s = new IndexedDBStorage('t')
    assert.equal(await s.get('other'), 'o')
    assert.equal(await s.get('missing'), null)
    await s.set('new', 'v')
    assert.equal(await s.get('new'), 'v')
    await s.delete('new')
    assert.equal(await s.get('new'), null)
  })
})
