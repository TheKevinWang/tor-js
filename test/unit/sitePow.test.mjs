// Unit tests for the proof-of-work solver pool (src/pow/powPool.ts, install.ts) with fake workers,
// and for the manifest's `client.pow` setting. The puzzle itself is solved by WASM in a real worker
// (tested natively in crates/tor-js-wasm/src/pow.rs and live in test/site-live-pow.mjs).
//
//   npm run test:unit

import { test, before, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-pow')
})

const BLIND = new Uint8Array(32).fill(7)
const SEED = new Uint8Array(32).fill(9)
const SOLUTION = () => ({ nonce: new Uint8Array(16).fill(1), effort: 8, seedHead: new Uint8Array(4).fill(9), proof: new Uint8Array(16).fill(2) })

/** A worker whose replies the test sends. */
class FakeWorker {
  static all = []
  constructor(url) {
    this.url = url
    this.sent = []
    this.terminated = false
    this.onmessage = null
    this.onerror = null
    FakeWorker.all.push(this)
  }
  postMessage(msg) { this.sent.push(msg) }
  terminate() { this.terminated = true }
  reply(data) { this.onmessage?.({ data }) }
  crash(message) { this.onerror?.({ message }) }
}

let counter
const options = (extra = {}) => ({
  workerUrl: 'https://site.test/tor-site-pow.js',
  wasmUrl: 'https://site.test/tor_js_bg.wasm',
  workers: 3,
  createWorker: (url) => new FakeWorker(url),
  randomBytes: (n) => new Uint8Array(n).fill(++counter),
  ...extra,
})
beforeEach(() => { FakeWorker.all = []; counter = 0 })
const settled = (p) => Promise.race([p.then((v) => ({ ok: v }), (e) => ({ err: e })), new Promise((r) => setImmediate(() => r('pending')))])

describe('how many workers', () => {
  test('one less than the cores, between 1 and 8', () => {
    assert.equal(m.defaultWorkerCount(1), 1)
    assert.equal(m.defaultWorkerCount(2), 1)
    assert.equal(m.defaultWorkerCount(4), 3)
    assert.equal(m.defaultWorkerCount(8), 7)
    assert.equal(m.defaultWorkerCount(16), 8)
    assert.equal(m.defaultWorkerCount(128), 8)
  })
})

describe('the pool', () => {
  test('starts the requested workers, each with the same puzzle and its own start nonce', async () => {
    const p = m.createPowSolver(options())(BLIND, SEED, 100)
    assert.equal(FakeWorker.all.length, 3)
    for (const w of FakeWorker.all) assert.equal(w.url, 'https://site.test/tor-site-pow.js')
    const sent = FakeWorker.all.map((w) => w.sent[0])
    for (const s of sent) {
      assert.equal(s.t, 'solve')
      assert.equal(s.wasmUrl, 'https://site.test/tor_js_bg.wasm')
      assert.equal(s.effort, 100)
      assert.deepEqual([...s.blindId], [...BLIND])
      assert.deepEqual([...s.seed], [...SEED])
      assert.equal(s.startNonce.length, 16)
    }
    assert.equal(new Set(sent.map((s) => s.startNonce[0])).size, 3, 'a different start nonce for each worker')
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    await p
  })

  test('the first solution wins and every worker is terminated, the winner too', async () => {
    const p = m.createPowSolver(options())(BLIND, SEED, 8)
    const solution = SOLUTION()
    FakeWorker.all[1].reply({ t: 'solved', solution })
    assert.deepEqual(await p, solution)
    assert.ok(FakeWorker.all.every((w) => w.terminated))
  })

  test('replies after the first are ignored', async () => {
    const p = m.createPowSolver(options())(BLIND, SEED, 8)
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    FakeWorker.all[2].reply({ t: 'solved', solution: { ...SOLUTION(), effort: 99 } })
    assert.equal((await p).effort, 8)
  })

  test('one worker failing does not reject while others are still solving', async () => {
    const p = m.createPowSolver(options())(BLIND, SEED, 8)
    FakeWorker.all[0].reply({ t: 'error', message: 'wasm failed to load' })
    FakeWorker.all[1].crash('script error')
    assert.equal(await settled(p), 'pending')
    assert.equal(FakeWorker.all[0].terminated, true, 'a failed worker is stopped')
    assert.equal(FakeWorker.all[2].terminated, false, 'the one still solving is not')
    FakeWorker.all[2].reply({ t: 'solved', solution: SOLUTION() })
    assert.equal((await p).effort, 8)
  })

  test('every worker failing rejects, naming the reasons', async () => {
    const p = m.createPowSolver(options())(BLIND, SEED, 8)
    FakeWorker.all[0].reply({ t: 'error', message: 'no wasm' })
    FakeWorker.all[1].crash('boom')
    FakeWorker.all[2].reply({ t: 'error', message: 'out of memory' })
    await assert.rejects(p, (e) => /every worker/.test(e.message) && /no wasm/.test(e.message) && /boom/.test(e.message) && /out of memory/.test(e.message))
    assert.ok(FakeWorker.all.every((w) => w.terminated))
  })

  test('a malformed solution is a failure, not an answer', async () => {
    const bad = [
      { ...SOLUTION(), nonce: new Uint8Array(15) },
      { ...SOLUTION(), seedHead: new Uint8Array(5) },
      { ...SOLUTION(), proof: [1, 2, 3] },
      { ...SOLUTION(), effort: NaN },
      undefined,
    ]
    for (const solution of bad) {
      FakeWorker.all = []
      const p = m.createPowSolver(options({ workers: 1 }))(BLIND, SEED, 8)
      FakeWorker.all[0].reply({ t: 'solved', solution })
      await assert.rejects(p, /malformed/, JSON.stringify(solution))
    }
    FakeWorker.all = []
    const p = m.createPowSolver(options({ workers: 1 }))(BLIND, SEED, 8)
    FakeWorker.all[0].reply('what')
    await assert.rejects(p, /unexpected message/)
  })

  test('workers that cannot be created are skipped; none at all rejects', async () => {
    let n = 0
    const some = m.createPowSolver(options({ createWorker: (url) => { if (++n <= 2) throw new Error('no Worker here'); return new FakeWorker(url) } }))
    const p = some(BLIND, SEED, 8)
    assert.equal(FakeWorker.all.length, 1)
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    await p

    const none = m.createPowSolver(options({ createWorker: () => { throw new Error('no Worker here') } }))
    await assert.rejects(none(BLIND, SEED, 8), /no Worker here/)
  })

  test('when the only workers that could be created fail, it rejects then, not before', async () => {
    let n = 0
    const p = m.createPowSolver(options({ createWorker: (url) => { if (++n === 1) throw new Error('first failed'); return new FakeWorker(url) } }))(BLIND, SEED, 8)
    FakeWorker.all[0].crash('a')
    assert.equal(await settled(p), 'pending')
    FakeWorker.all[1].crash('b')
    await assert.rejects(p, /every worker/)
  })

  test('a timeout rejects and stops the workers', async () => {
    const p = m.createPowSolver(options({ timeoutMs: 20 }))(BLIND, SEED, 8)
    await assert.rejects(p, /not solved within 20 ms/)
    assert.ok(FakeWorker.all.every((w) => w.terminated))
  })

  test('separate calls use separate workers', async () => {
    const solve = m.createPowSolver(options({ workers: 2 }))
    const a = solve(BLIND, SEED, 8)
    const b = solve(BLIND, SEED, 16)
    assert.equal(FakeWorker.all.length, 4)
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    assert.equal(FakeWorker.all[2].terminated, false, 'the second call is still solving')
    FakeWorker.all[3].reply({ t: 'solved', solution: { ...SOLUTION(), effort: 16 } })
    assert.equal((await a).effort, 8)
    assert.equal((await b).effort, 16)
  })
})

describe('installing the solver for the Tor client', () => {
  const g = globalThis
  beforeEach(() => { delete g.__torJsPowSolve; delete g.__torJsPowConfig })

  test('defines the global function and the settings, and removing it restores what was there', async () => {
    g.__torJsPowSolve = 'before'
    g.__torJsPowConfig = { minEffort: 1 }
    const remove = m.installPowSolver(options({ maxEffort: 500, minEffort: 4 }))
    assert.equal(typeof g.__torJsPowSolve, 'function')
    assert.deepEqual(g.__torJsPowConfig, { maxEffort: 500, minEffort: 4 })
    const p = g.__torJsPowSolve(BLIND, SEED, 8)
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    assert.equal((await p).effort, 8)
    remove()
    assert.equal(g.__torJsPowSolve, 'before')
    assert.deepEqual(g.__torJsPowConfig, { minEffort: 1 })
  })

  test('where workers cannot be started it installs nothing, so the client connects without a solution', () => {
    assert.equal(typeof g.Worker, 'undefined', 'this test runs where there is no Worker global')
    const remove = m.installPowSolver({ workerUrl: 'x', wasmUrl: 'y' })
    assert.equal(g.__torJsPowSolve, undefined)
    remove()
    assert.equal(m.canSolveProofOfWork(), false)
  })
})

describe('manifest: client.pow', () => {
  const ONION = 'http://abcdefghijklmnop.onion'
  const pow = (value) => m.parseManifest({ onion: ONION, client: { snowflake: true, pow: value } }).client.pow

  test('absent means the default (on); true and false are kept', () => {
    assert.equal(m.parseManifest({ onion: ONION }).client.pow, undefined)
    assert.equal(pow(true), true)
    assert.equal(pow(false), false)
  })

  test('an object sets workers, efforts and the worker URL', () => {
    assert.deepEqual(pow({ workers: 4, maxEffort: 500, minEffort: 8, workerUrl: 'js/pow.js' }), { workers: 4, maxEffort: 500, minEffort: 8, workerUrl: 'js/pow.js' })
    assert.deepEqual(pow({}), {})
    assert.deepEqual(pow({ minEffort: 0 }), { minEffort: 0 })
  })

  test('nonsense is refused with the name of the setting', () => {
    assert.throws(() => pow('yes'), /"client.pow" must be true, false or an object/)
    assert.throws(() => pow([]), /"client.pow" must be true, false or an object/)
    assert.throws(() => pow({ workers: 0 }), /client.pow.workers.*at least 1/)
    assert.throws(() => pow({ workers: 2.5 }), /client.pow.workers/)
    assert.throws(() => pow({ maxEffort: -1 }), /client.pow.maxEffort/)
    assert.throws(() => pow({ minEffort: '8' }), /client.pow.minEffort/)
    assert.throws(() => pow({ workerUrl: 5 }), /client.pow.workerUrl/)
  })
})
