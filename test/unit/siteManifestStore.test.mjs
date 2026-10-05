// Unit tests for src/site/manifestStore.ts: the Service Worker keeps the last routing manifest it
// validated, so a restart while tor-site.json cannot be fetched never turns private routes into
// "static" ones (requests to which would be sent to the static host).
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-manifest-store')
})

const ONION = 'http://abcdefghijklmnop.onion'
const GOOD = { onion: ONION, tor: ['/api/**'] }
const UPDATED = { onion: ONION, tor: ['/api/**', '/login'] }

function memoryStore(initial) {
  const store = {
    saved: initial,
    writes: 0,
    async read() { return store.saved },
    async write(raw) { store.writes++; store.saved = structuredClone(raw) },
  }
  return store
}
const load = (fetchFresh, store) => m.loadRoutingManifest({ fetchFresh, store, parse: (raw) => m.parseManifest(raw) })
const routeOf = (loaded, path) => m.routeFor(loaded.manifest, path).kind

describe('loadRoutingManifest', () => {
  test('a fresh valid manifest is used and saved for the next start', async () => {
    const store = memoryStore()
    const loaded = await load(async () => GOOD, store)
    assert.equal(loaded.source, 'network')
    assert.equal(routeOf(loaded, '/api/x'), 'tor')
    assert.deepEqual(store.saved, GOOD)
  })

  test('a worker restarting while the manifest cannot be fetched keeps routing private paths to Tor', async () => {
    const store = memoryStore(GOOD)
    const loaded = await load(async () => { throw new TypeError('Failed to fetch') }, store)
    assert.equal(loaded.source, 'saved')
    assert.match(loaded.freshError, /Failed to fetch/)
    assert.equal(routeOf(loaded, '/api/secret'), 'tor')
  })

  test('an invalid or missing fresh manifest does not replace the saved one', async () => {
    const store = memoryStore(GOOD)
    for (const fresh of [async () => ({ onion: 'http://not-an-onion.example' }), async () => { throw new Error('cannot load tor-site.json: HTTP 404') }]) {
      const loaded = await load(fresh, store)
      assert.equal(loaded.source, 'saved')
      assert.equal(routeOf(loaded, '/api/x'), 'tor')
    }
    assert.equal(store.writes, 0)
    assert.deepEqual(store.saved, GOOD)
  })

  test('once the manifest is reachable again, an update takes effect and is saved', async () => {
    const store = memoryStore(GOOD)
    const loaded = await load(async () => UPDATED, store)
    assert.equal(loaded.source, 'network')
    assert.equal(routeOf(loaded, '/login'), 'tor')
    assert.deepEqual(store.saved, UPDATED)
  })

  test('with neither a fresh nor a saved manifest, loading fails (the worker then forwards nothing)', async () => {
    await assert.rejects(load(async () => { throw new Error('HTTP 503') }, memoryStore()), /HTTP 503; and no earlier valid manifest was saved/)
    await assert.rejects(load(async () => { throw new Error('HTTP 503') }, null), /no earlier valid manifest/)
  })

  test('a corrupt saved copy is reported, not used', async () => {
    await assert.rejects(load(async () => { throw new Error('offline') }, memoryStore({ tor: 7 })), /offline; and the saved copy is not valid either/)
  })

  test('a fresh manifest that cannot be saved is still used, with the reason reported', async () => {
    const store = { read: async () => undefined, write: async () => { throw new Error('QuotaExceededError') } }
    const loaded = await load(async () => GOOD, store)
    assert.equal(loaded.source, 'network')
    assert.match(loaded.saveError, /Quota/)
  })
})
