// Unit tests for solving proof-of-work puzzles through a page, for a Tor client in a SharedWorker (which
// has no Worker constructor in Chromium): src/pow/powPage.ts (the page runs the pool) and
// src/pow/powRelay.ts (the host asks it to), joined by real MessageChannels, with fake workers.
//
//   npm run test:unit

import { test, before, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-pow-remote')
})

const BLIND = new Uint8Array(32).fill(7)
const SEED = new Uint8Array(32).fill(9)
const SOLUTION = () => ({ nonce: new Uint8Array(16).fill(1), effort: 8, seedHead: new Uint8Array(4).fill(9), proof: new Uint8Array(16).fill(2) })

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
}

let counter
beforeEach(() => { FakeWorker.all = []; counter = 0 })

const until = async (condition, what = 'condition') => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const POOL = { workerUrl: 'https://site.test/tor-site-pow.js', wasmUrl: 'https://site.test/tor_js_bg.wasm', workers: 2 }

/** A relay whose "page" is in this process: each request gets a channel whose far end servePow serves. */
function relay(extra = {}) {
  const requests = []
  const solver = m.createRemotePowSolver({
    pool: POOL,
    acquirePort: async (e) => {
      const channel = new MessageChannel()
      requests.push(e)
      m.servePow(channel.port2, e.options, { createWorker: (url) => new FakeWorker(url), randomBytes: (n) => new Uint8Array(n).fill(++counter), ...extra })
      return channel.port1
    },
    ...extra,
  })
  return { solver, requests }
}

describe('solving through a page', () => {
  test('the host sends the pool settings, the page starts the workers and returns the first solution', async () => {
    const { solver, requests } = relay()
    const p = solver(BLIND, SEED, 64)
    await until(() => FakeWorker.all.length === 2, 'the page to start two workers')
    assert.deepEqual(requests[0].options, POOL)
    assert.equal(FakeWorker.all[0].sent[0].effort, 64)
    assert.deepEqual([...FakeWorker.all[0].sent[0].blindId], [...BLIND])
    FakeWorker.all[1].reply({ t: 'solved', solution: SOLUTION() })
    const solution = await p
    assert.equal(solution.effort, 8)
    assert.deepEqual([...solution.proof], [...SOLUTION().proof], 'the bytes crossed the port intact')
    await until(() => FakeWorker.all.every((w) => w.terminated), 'the workers to be stopped')
  })

  test('workers that all fail come back as an error', async () => {
    const { solver } = relay()
    const p = solver(BLIND, SEED, 8)
    await until(() => FakeWorker.all.length === 2)
    FakeWorker.all[0].reply({ t: 'error', message: 'no wasm' })
    FakeWorker.all[1].reply({ t: 'error', message: 'no memory' })
    await assert.rejects(p, /every worker/)
  })

  test("cancelling the host side stops the page's workers", async () => {
    const { solver } = relay()
    const abort = new AbortController()
    const p = solver(BLIND, SEED, 5000, abort.signal)
    await until(() => FakeWorker.all.length === 2)
    abort.abort()
    await assert.rejects(p, /cancelled/)
    await until(() => FakeWorker.all.every((w) => w.terminated), 'the workers to be stopped')
  })

  test('already cancelled starts nothing', async () => {
    const { solver, requests } = relay()
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(solver(BLIND, SEED, 8, abort.signal), /cancelled/)
    assert.equal(requests.length, 0)
  })

  test('a page that cannot be found rejects, so the client connects without a solution', async () => {
    const solver = m.createRemotePowSolver({ pool: POOL, acquirePort: async () => { throw new Error('no open page') } })
    await assert.rejects(solver(BLIND, SEED, 8), /no open page/)
  })

  test('a page that never answers is given up on, and told to stop', async () => {
    const channel = new MessageChannel()
    const seen = []
    channel.port2.onmessage = (e) => seen.push(e.data.t)
    const solver = m.createRemotePowSolver({ pool: POOL, acquirePort: async () => channel.port1, timeoutMs: 30 })
    await assert.rejects(solver(BLIND, SEED, 8), /did not return/)
    await until(() => seen.includes('cancel'), 'the page to be told to stop')
    assert.deepEqual(seen.slice(0, 2), ['solve', 'cancel'])
    channel.port2.close()
  })

  test('a newer solve for the same service replaces an older one, which is stopped', async () => {
    const { solver } = relay()
    const first = solver(BLIND, SEED, 5000).then(() => 'solved', (e) => e.message)
    await until(() => FakeWorker.all.length === 2, 'the first solve to start')
    const second = solver(BLIND, SEED, 5000)
    await until(() => FakeWorker.all.length === 4, 'the second solve to start')
    await until(() => FakeWorker.all.slice(0, 2).every((w) => w.terminated), 'the first solve to be stopped')
    assert.match(await first, /cancelled/, 'and the host is told, so it does not wait for an answer')
    assert.equal(FakeWorker.all[2].terminated, false)
    FakeWorker.all[2].reply({ t: 'solved', solution: SOLUTION() })
    assert.equal((await second).effort, 8)
  })

  test('puzzles for different services run side by side', async () => {
    const { solver } = relay()
    const a = solver(BLIND, SEED, 100)
    const b = solver(new Uint8Array(32).fill(1), SEED, 100)
    await until(() => FakeWorker.all.length === 4)
    assert.ok(FakeWorker.all.every((w) => !w.terminated), 'neither was stopped by the other')
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    FakeWorker.all[2].reply({ t: 'solved', solution: { ...SOLUTION(), effort: 9 } })
    assert.equal((await a).effort, 8)
    assert.equal((await b).effort, 9)
  })

  test('the page stops a solve after its time limit even if the host never cancels', async () => {
    const channel = new MessageChannel()
    const seen = []
    channel.port1.onmessage = (e) => seen.push(e.data)
    m.servePow(channel.port2, POOL, { createWorker: (url) => new FakeWorker(url), maxSolveMs: 20 })
    await until(() => seen.some((x) => x.t === 'ready'))
    channel.port1.postMessage({ t: 'solve', blindId: BLIND, seed: SEED, effort: 5000 })
    await until(() => FakeWorker.all.length === 2)
    await until(() => FakeWorker.all.every((w) => w.terminated), 'the time limit to stop the workers')
    await until(() => seen.some((x) => x.t === 'error' && /cancelled/.test(x.message)), 'the host to be told')
    channel.port1.close()
  })

  test('a malformed request is answered with an error', async () => {
    const channel = new MessageChannel()
    const seen = []
    channel.port1.onmessage = (e) => seen.push(e.data)
    m.servePow(channel.port2, POOL, { createWorker: (url) => new FakeWorker(url) })
    await until(() => seen.some((x) => x.t === 'ready'))
    channel.port1.postMessage({ t: 'solve', blindId: 'x', seed: SEED, effort: 8 })
    await until(() => seen.some((x) => x.t === 'error'))
    assert.match(seen.find((x) => x.t === 'error').message, /malformed/)
    assert.equal(FakeWorker.all.length, 0)
    channel.port1.close()
  })
})

describe('installing the solver where workers cannot be started', () => {
  const g = globalThis
  beforeEach(() => { delete g.__torJsPowSolve; delete g.__torJsPowConfig })

  test('with a way to ask a page, it installs the page-backed solver', async () => {
    let asked = null
    const remove = m.installPowSolver({
      workerUrl: 'w', wasmUrl: 'x', workers: 2, minEffort: 16,
      acquirePort: async (extra) => {
        asked = extra
        const channel = new MessageChannel()
        m.servePow(channel.port2, extra.options, { createWorker: (url) => new FakeWorker(url) })
        return channel.port1
      },
    })
    assert.equal(typeof g.__torJsPowSolve, 'function')
    assert.deepEqual(g.__torJsPowConfig, { maxEffort: undefined, minEffort: 16 })
    const p = g.__torJsPowSolve(BLIND, SEED, 16)
    await until(() => FakeWorker.all.length === 2)
    assert.deepEqual(asked.options, { workerUrl: 'w', wasmUrl: 'x', workers: 2 })
    FakeWorker.all[0].reply({ t: 'solved', solution: SOLUTION() })
    assert.equal((await p).effort, 8)
    remove()
  })

  test('the request for a page carries the kind and the settings, and the WebRTC request is unchanged', async () => {
    const posted = []
    const target = { post: (msg) => { posted.push(msg); msg.port.postMessage({ t: 'ready' }) } }
    const port = await m.acquirePeerPort([target], 1000, { kind: 'pow', extra: { options: { workerUrl: 'w' } } })
    assert.equal(posted[0].t, 'pow-request')
    assert.deepEqual(posted[0].options, { workerUrl: 'w' })
    port.close()
    const peerPort = await m.acquirePeerPort([target], 1000)
    assert.equal(posted[1].t, 'peer-request')
    peerPort.close()
  })

  test('with no page to ask, the error says what is missing', async () => {
    await assert.rejects(m.acquirePeerPort([], 10, { kind: 'pow' }), /start the proof-of-work workers/)
    await assert.rejects(m.acquirePeerPort([], 10), /WebRTC peer connection/)
  })
})
