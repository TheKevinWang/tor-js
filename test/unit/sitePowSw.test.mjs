// Unit tests for solving proof-of-work puzzles when the Tor client is in the Service Worker, which cannot
// start workers: it asks the pages it controls (src/pow/clientRelay.ts), and the manifest-driven
// installation shared with the host worker (src/pow/manifestPow.ts). Fake clients stand in for the
// pages; the page's half is src/pow/powPage.ts, tested in sitePowRemote.test.mjs.
//
//   npm run test:unit

import { test, before, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-pow-sw')
})

const BLIND = new Uint8Array(32).fill(7)
const SEED = new Uint8Array(32).fill(9)
const SOLUTION = () => ({ nonce: new Uint8Array(16).fill(1), effort: 8, seedHead: new Uint8Array(4).fill(9), proof: new Uint8Array(16).fill(2) })

class FakeWorker {
  static all = []
  constructor(url) { this.url = url; this.sent = []; this.terminated = false; this.onmessage = null; this.onerror = null; FakeWorker.all.push(this) }
  postMessage(msg) { this.sent.push(msg) }
  terminate() { this.terminated = true }
  reply(data) { this.onmessage?.({ data }) }
}
beforeEach(() => { FakeWorker.all = [] })

const until = async (condition, what = 'condition') => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** A Service Worker client (a page). An answering one runs the page's half; a silent one never replies. */
function client(name, { answers = true, log }) {
  return {
    name,
    postMessage(message, transfer) {
      log.push({ name, message, transfer })
      if (answers && message.t === 'pow-request') {
        m.servePow(message.port, message.options, { createWorker: (url) => new FakeWorker(url) })
      }
    },
  }
}
const OPTIONS = { workerUrl: 'https://site.test/tor-site-pow.js', wasmUrl: 'https://site.test/tor_js_bg.wasm', workers: 2 }

describe('asking the pages a Service Worker controls', () => {
  test('the request carries the kind, the pool settings and a port; a page that answers runs the workers', async () => {
    const log = []
    const acquire = m.createClientPowAcquirer(async () => [client('page', { log })])
    const solver = m.createRemotePowSolver({ pool: OPTIONS, acquirePort: acquire })
    const p = solver(BLIND, SEED, 16)
    await until(() => FakeWorker.all.length === 2, 'the page to start two workers')
    assert.equal(log[0].message.t, 'pow-request')
    assert.deepEqual(log[0].message.options, OPTIONS)
    assert.ok(log[0].message.port instanceof MessagePort)
    assert.equal(log[0].transfer.length, 1, 'the port is transferred')
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    assert.equal((await p).effort, 8)
  })

  test('the most recently focused client is asked first (matchAll lists it first), and only it if it answers', async () => {
    const log = []
    const acquire = m.createClientPowAcquirer(async () => [client('focused', { log }), client('older', { log }), client('oldest', { log })])
    const solver = m.createRemotePowSolver({ pool: OPTIONS, acquirePort: acquire })
    const p = solver(BLIND, SEED, 16)
    await until(() => FakeWorker.all.length === 2)
    assert.deepEqual(log.map((l) => l.name), ['focused'])
    FakeWorker.all[1].reply({ t: 'solved', solution: SOLUTION() })
    await p
  })

  test('a client that does not answer is skipped after the timeout, and the next one is asked', async () => {
    const log = []
    const acquire = m.createClientPowAcquirer(async () => [client('closed tab', { log, answers: false }), client('open tab', { log })], 40)
    const solver = m.createRemotePowSolver({ pool: OPTIONS, acquirePort: acquire })
    const p = solver(BLIND, SEED, 16)
    await until(() => FakeWorker.all.length === 2, 'the second client to be used')
    assert.deepEqual(log.map((l) => l.name), ['closed tab', 'open tab'])
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    assert.equal((await p).effort, 8)
  })

  test('a client whose postMessage throws is skipped at once', async () => {
    const log = []
    const broken = { postMessage() { throw new Error('client is gone') } }
    const acquire = m.createClientPowAcquirer(async () => [client('good', { log }), broken])
    const solver = m.createRemotePowSolver({ pool: OPTIONS, acquirePort: acquire })
    const p = solver(BLIND, SEED, 16)
    await until(() => FakeWorker.all.length === 2)
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    await p
    assert.deepEqual(log.map((l) => l.name), ['good'])
  })

  test('with no client to ask the solve fails, so the Tor client connects without a solution', async () => {
    const acquire = m.createClientPowAcquirer(async () => [])
    await assert.rejects(m.createRemotePowSolver({ pool: OPTIONS, acquirePort: acquire })(BLIND, SEED, 16), /start the proof-of-work workers/)
  })

  test('the clients are listed afresh for every puzzle', async () => {
    let calls = 0
    const log = []
    const acquire = m.createClientPowAcquirer(async () => { calls++; return [client('page', { log })] })
    const solver = m.createRemotePowSolver({ pool: OPTIONS, acquirePort: acquire })
    for (let i = 0; i < 2; i++) {
      FakeWorker.all = []
      const p = solver(BLIND, new Uint8Array(32).fill(i), 16)
      await until(() => FakeWorker.all.length === 2)
      FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
      await p
    }
    assert.equal(calls, 2)
  })
})

describe('installing the solver a manifest asks for', () => {
  const ONION = 'http://abcdefghijklmnop.onion'
  const MANIFEST_URL = 'https://site.test/app/tor-site.json'
  const WASM = 'https://site.test/app/tor_js_bg.wasm'
  const g = globalThis
  const manifest = (pow) => m.parseManifest({ onion: ONION, client: pow === undefined ? {} : { pow } })
  beforeEach(() => { delete g.__torJsPowSolve; delete g.__torJsPowConfig })

  test('by default the solver is installed, asking a page to run it where there is no Worker (as in a Service Worker)', async () => {
    assert.equal(typeof g.Worker, 'undefined')
    let asked = null
    const remove = m.installManifestPow(manifest(undefined), MANIFEST_URL, WASM, async (extra) => { asked = extra; throw new Error('stop here') })
    assert.equal(typeof g.__torJsPowSolve, 'function')
    await assert.rejects(g.__torJsPowSolve(BLIND, SEED, 16), /stop here/)
    assert.deepEqual(asked.options, { workerUrl: 'https://site.test/app/tor-site-pow.js', wasmUrl: WASM, workers: undefined })
    remove()
  })

  test('`pow: false` installs nothing', () => {
    const remove = m.installManifestPow(manifest(false), MANIFEST_URL, WASM, async () => { throw new Error('unused') })
    assert.equal(g.__torJsPowSolve, undefined)
    assert.equal(g.__torJsPowConfig, undefined)
    remove()
  })

  test('the settings reach the solver: workers, the worker script (resolved against the manifest) and the efforts', async () => {
    let asked = null
    const remove = m.installManifestPow(
      manifest({ workers: 3, minEffort: 16, maxEffort: 500, workerUrl: 'js/pow.js' }), MANIFEST_URL, WASM,
      async (extra) => { asked = extra; throw new Error('stop here') },
    )
    assert.deepEqual(g.__torJsPowConfig, { maxEffort: 500, minEffort: 16 })
    await assert.rejects(g.__torJsPowSolve(BLIND, SEED, 16), /stop here/)
    assert.deepEqual(asked.options, { workerUrl: 'https://site.test/app/js/pow.js', wasmUrl: WASM, workers: 3 })
    remove()
  })

  test('removing it restores what was there', () => {
    const remove = m.installManifestPow(manifest(undefined), MANIFEST_URL, WASM, async () => { throw new Error('unused') })
    assert.equal(typeof g.__torJsPowSolve, 'function')
    remove()
    assert.equal(g.__torJsPowSolve, undefined)
  })
})
