// Unit tests for the default proof-of-work solver a plain TorClient installs (src/pow/autoInstall.ts),
// with a fake realm and fake workers. See .agent/visitor-pays-by-default-execplan.md.
//
//   npm run test:unit

import { test, before, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('src/pow/autoInstall.ts', 'auto-pow')
})
beforeEach(() => m.resetClientPowForTests())

const solution = () => ({ nonce: new Uint8Array(16), effort: 4, seedHead: new Uint8Array(4), proof: new Uint8Array(16) })

/** A fake worker factory that records what it was asked, and answers every solve request. */
function fakeWorkers(log) {
  return async () => (url) => {
    const worker = {
      url,
      terminated: false,
      onmessage: null,
      onerror: null,
      postMessage(request) {
        log.requests.push({ url, request })
        queueMicrotask(() => worker.onmessage?.({ data: { t: 'solved', solution: solution() } }))
      },
      terminate() { worker.terminated = true },
    }
    log.workers.push(worker)
    return worker
  }
}

const loc = (url, bytes = new Uint8Array([1, 2, 3]), variant) => () => ({ url, variant, bytes: async () => bytes })

function setup(over = {}) {
  const log = { requests: [], workers: [], blobs: [] }
  const globals = {}
  const deps = {
    globals,
    realm: () => 'node',
    defaultWorkerUrl: () => 'file:///dist/pow-node-worker.js',
    workerFactory: fakeWorkers(log),
    blobs: {
      fromBytes: (bytes, type) => { log.blobs.push(type); return `blob:${type}`; },
      fromScript: async () => 'self.onmessage = () => {}',
      sameOrigin: () => true,
    },
    ...over,
  }
  return { log, globals, deps }
}

describe('when it installs', () => {
  test('a solver and its settings are put where the Tor client looks, and removed on release', () => {
    const { globals, deps } = setup()
    const release = m.installClientPow({ minEffort: 4, maxEffort: 100 }, loc('file:///a.wasm'), deps)
    assert.equal(typeof globals.__torJsPowSolve, 'function')
    assert.deepEqual(globals.__torJsPowConfig, { maxEffort: 100, minEffort: 4 })
    release()
    assert.equal(globals.__torJsPowSolve, undefined)
    assert.equal(globals.__torJsPowConfig, undefined)
  })

  test('with no options it installs, with default settings', () => {
    const { globals, deps } = setup()
    m.installClientPow(undefined, loc('file:///a.wasm'), deps)
    assert.equal(typeof globals.__torJsPowSolve, 'function')
    assert.deepEqual(globals.__torJsPowConfig, { maxEffort: undefined, minEffort: undefined })
  })

  test('pow: false installs nothing', () => {
    const { globals, deps } = setup()
    const release = m.installClientPow(false, loc('file:///a.wasm'), deps)
    assert.equal(globals.__torJsPowSolve, undefined)
    release() // harmless
  })

  test('where no worker can be started (a SharedWorker, a Service Worker) it installs nothing', () => {
    const { globals, deps } = setup({ realm: () => 'none' })
    m.installClientPow(undefined, loc('file:///a.wasm'), deps)
    assert.equal(globals.__torJsPowSolve, undefined)
  })

  test('it never replaces a solver somebody else installed, and leaves it when released', () => {
    const { globals, deps } = setup()
    const theirs = async () => solution()
    globals.__torJsPowSolve = theirs
    globals.__torJsPowConfig = { minEffort: 9 }
    const release = m.installClientPow({ minEffort: 1 }, loc('file:///a.wasm'), deps)
    assert.equal(globals.__torJsPowSolve, theirs)
    assert.deepEqual(globals.__torJsPowConfig, { minEffort: 9 })
    release()
    assert.equal(globals.__torJsPowSolve, theirs)
  })

  test('it puts back what was there before it, when that was only settings', () => {
    const { globals, deps } = setup()
    globals.__torJsPowConfig = { maxEffort: 7 }
    const release = m.installClientPow({ minEffort: 1 }, loc('file:///a.wasm'), deps)
    release()
    assert.deepEqual(globals.__torJsPowConfig, { maxEffort: 7 })
  })

  test('constructing never reads the wasm location or the worker location (some realms have no import.meta.url)', () => {
    const { globals, deps } = setup({ defaultWorkerUrl: () => { throw new Error('must not be called at install') } })
    m.installClientPow(undefined, () => { throw new Error('must not be called at install') }, deps)
    assert.equal(typeof globals.__torJsPowSolve, 'function')
  })
})

describe('sharing between clients', () => {
  test('two clients share one install, and it goes only when the last releases', () => {
    const { globals, deps } = setup()
    const a = m.installClientPow({ minEffort: 2 }, loc('file:///a.wasm'), deps)
    const solverA = globals.__torJsPowSolve
    const b = m.installClientPow({ minEffort: 5 }, loc('file:///a.wasm'), deps)
    assert.equal(globals.__torJsPowSolve, solverA, 'the second client does not install another')
    assert.equal(globals.__torJsPowConfig.minEffort, 2, 'the first client\'s settings apply')
    a()
    assert.equal(globals.__torJsPowSolve, solverA, 'still there for the second client')
    b()
    assert.equal(globals.__torJsPowSolve, undefined)
  })

  test('releasing twice does not take another client\'s install away', () => {
    const { globals, deps } = setup()
    const a = m.installClientPow(undefined, loc('file:///a.wasm'), deps)
    const b = m.installClientPow(undefined, loc('file:///a.wasm'), deps)
    a(); a(); a()
    assert.equal(typeof globals.__torJsPowSolve, 'function')
    b()
    assert.equal(globals.__torJsPowSolve, undefined)
  })
})

describe('solving', () => {
  const args = () => [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 4]

  test('workers get the WASM by URL when it is a file: URL in Node, and are told the puzzle', async () => {
    const { globals, deps, log } = setup()
    m.installClientPow({ workers: 2 }, loc('file:///dist/tor_js_bg.wasm'), deps)
    const result = await globals.__torJsPowSolve(...args())
    assert.equal(result.effort, 4)
    assert.equal(log.workers.length, 2)
    assert.ok(log.workers.every((w) => w.url === 'file:///dist/pow-node-worker.js'))
    const request = log.requests[0].request
    assert.equal(request.t, 'solve')
    assert.equal(request.wasmUrl, 'file:///dist/tor_js_bg.wasm')
    assert.equal(request.wasmBytes, undefined)
    assert.equal(request.effort, 4)
    assert.ok(log.workers.every((w) => w.terminated), 'the pool ends its workers once solved')
  })

  test('in Node, a WASM with no file: URL (a CDN or base64 entry) is sent as bytes', async () => {
    const { globals, deps, log } = setup()
    const bytes = new Uint8Array([9, 8, 7])
    m.installClientPow({ workers: 1 }, loc(undefined, bytes), deps)
    await globals.__torJsPowSolve(...args())
    assert.deepEqual(Array.from(log.requests[0].request.wasmBytes), [9, 8, 7])
  })

  test('in a page, a WASM with no URL becomes a blob URL for the workers', async () => {
    const { globals, deps, log } = setup({ realm: () => 'browser', defaultWorkerUrl: () => 'https://site.example/dist/site/tor-site-pow.js' })
    m.installClientPow({ workers: 1 }, loc(undefined), deps)
    await globals.__torJsPowSolve(...args())
    assert.equal(log.requests[0].request.wasmUrl, 'blob:application/wasm')
    assert.equal(log.requests[0].url, 'https://site.example/dist/site/tor-site-pow.js')
  })

  test('in a page, a worker script on another origin is started from a blob', async () => {
    const { globals, deps, log } = setup({
      realm: () => 'browser',
      defaultWorkerUrl: () => 'https://cdn.example/tor-site-pow.js',
      blobs: { fromBytes: (b, t) => `blob:${t}`, fromScript: async () => 'script text', sameOrigin: () => false },
    })
    m.installClientPow({ workers: 1 }, loc('https://site.example/tor_js_bg.wasm'), deps)
    await globals.__torJsPowSolve(...args())
    assert.equal(log.requests[0].url, 'blob:text/javascript')
    assert.equal(log.requests[0].request.wasmUrl, 'https://site.example/tor_js_bg.wasm')
  })

  test('the build of the WASM (variant) travels to the workers, so they use the matching glue', async () => {
    const { globals, deps, log } = setup()
    m.installClientPow({ workers: 1 }, loc('file:///a.wasm', undefined, 'host'), deps)
    await globals.__torJsPowSolve(...args())
    assert.equal(log.requests[0].request.variant, 'host')
    m.resetClientPowForTests()
    const second = setup()
    m.installClientPow({ workers: 1 }, loc('file:///a.wasm'), second.deps)
    await second.globals.__torJsPowSolve(...args())
    assert.equal(second.log.requests[0].request.variant, undefined, 'the default build sends no variant')
  })

  test('a page uses the page worker script by default, Node the Node one', () => {
    // (the default locations are computed from import.meta.url, which a test cannot see; what is checked
    // here is that each realm asks for its own: the fakes record the realm they were called with)
    const seen = []
    const a = setup({ defaultWorkerUrl: (realm) => { seen.push(realm); return 'file:///w.js' } })
    m.installClientPow({ workers: 1 }, loc('file:///a.wasm'), a.deps)
    return a.globals.__torJsPowSolve(new Uint8Array(32), new Uint8Array(32), 1).then(() => {
      m.resetClientPowForTests()
      const b = setup({ realm: () => 'browser', defaultWorkerUrl: (realm) => { seen.push(realm); return 'https://site.example/w.js' } })
      m.installClientPow({ workers: 1 }, loc('https://site.example/a.wasm'), b.deps)
      return b.globals.__torJsPowSolve(new Uint8Array(32), new Uint8Array(32), 1)
    }).then(() => assert.deepEqual(seen, ['node', 'browser']))
  })

  test('pow.workerUrl overrides the default location', async () => {
    const { globals, deps, log } = setup()
    m.installClientPow({ workers: 1, workerUrl: 'file:///elsewhere/w.js' }, loc('file:///a.wasm'), deps)
    await globals.__torJsPowSolve(...args())
    assert.equal(log.requests[0].url, 'file:///elsewhere/w.js')
  })

  test('with no worker location known, a puzzle fails with a message that says what to do (the client then connects without a solution)', async () => {
    const { globals, deps } = setup({ defaultWorkerUrl: () => undefined })
    m.installClientPow(undefined, loc('file:///a.wasm'), deps)
    await assert.rejects(globals.__torJsPowSolve(...args()), /pow\.workerUrl/)
  })

  test('a failure to set up is not remembered: the next puzzle tries again', async () => {
    let attempts = 0
    const { log, globals, deps } = setup()
    const working = fakeWorkers(log)
    deps.workerFactory = async (realm) => { attempts++; if (attempts === 1) throw new Error('no worker_threads'); return working(realm) }
    m.installClientPow({ workers: 1 }, loc('file:///a.wasm'), deps)
    await assert.rejects(globals.__torJsPowSolve(...args()), /no worker_threads/)
    const result = await globals.__torJsPowSolve(...args())
    assert.equal(result.effort, 4)
    assert.equal(attempts, 2)
  })

  test('the pool is built once and reused for later puzzles', async () => {
    let builds = 0
    const { log, globals, deps } = setup()
    const working = fakeWorkers(log)
    deps.workerFactory = async (realm) => { builds++; return working(realm) }
    m.installClientPow({ workers: 1 }, loc('file:///a.wasm'), deps)
    await globals.__torJsPowSolve(...args())
    await globals.__torJsPowSolve(...args())
    assert.equal(builds, 1)
    assert.equal(log.workers.length, 2, 'one worker per puzzle, started fresh each time')
  })
})
