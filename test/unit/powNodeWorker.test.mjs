// Offline test of the Node proof-of-work worker (src/pow/powWorkerNode.ts) and the pool on top of it: a
// real worker thread loads the real WASM and solves a real puzzle. See
// .agent/visitor-pays-by-default-execplan.md.
//
//   npm run test:unit
//
// Needs the WASM the crate builds (crates/tor-js-wasm/pkg/, from `wasm-pack build`); skipped without it.

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundleTs, root } from './bundle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const glue = resolve(root, 'crates/tor-js-wasm/pkg/tor_js.js')
const wasmFile = resolve(root, 'crates/tor-js-wasm/pkg/tor_js_bg.wasm')
const haveWasm = existsSync(glue) && existsSync(wasmFile)
// The build of the WASM that can host an onion service has its own glue and WASM, which only work together.
const hostGlue = resolve(root, 'crates/tor-js-wasm/pkg-host/tor_js_host.js')
const hostWasmFile = resolve(root, 'crates/tor-js-wasm/pkg-host/tor_js_host_bg.wasm')
const haveHost = existsSync(hostGlue) && existsSync(hostWasmFile)

let workerUrl, createNodeWorkerFactory, createPowSolver

before(async () => {
  if (!haveWasm) return
  // The worker script, bundled the way build.mjs bundles it: #wasm is the real glue. (Importing it here is
  // harmless: with no parentPort it does nothing; the test uses the file as a worker script.)
  await bundleTs('src/pow/powWorkerNode.ts', 'pow-node-worker', { alias: { '#wasm': glue, '#wasm-host': haveHost ? hostGlue : glue } })
  workerUrl = pathToFileURL(resolve(here, '.tmp-pow-node-worker.mjs')).href
  ;({ createNodeWorkerFactory } = await bundleTs('src/pow/nodeWorkers.ts', 'pow-node-workers'))
  ;({ createPowSolver } = await bundleTs('src/pow/powPool.ts', 'pow-pool-node'))
})

const blindId = new Uint8Array(32).map((_, i) => i)
const seed = new Uint8Array(32).map((_, i) => 255 - i)
const startNonce = new Uint8Array(16).map((_, i) => i * 3)

function okSolution(s, effort) {
  assert.equal(s.nonce.length, 16)
  assert.equal(s.seedHead.length, 4)
  assert.equal(s.proof.length, 16)
  assert.equal(s.effort, effort)
  assert.deepEqual(Array.from(s.seedHead), Array.from(seed.slice(0, 4)), 'the seed head names the seed that was solved')
}

describe('the Node worker', { skip: !haveWasm && 'the WASM is not built (crates/tor-js-wasm/pkg)' }, () => {
  test('solves a puzzle in a real worker thread, given the WASM bytes', async () => {
    const make = await createNodeWorkerFactory()
    const worker = make(workerUrl)
    const reply = await new Promise((resolveReply, reject) => {
      worker.onmessage = (e) => resolveReply(e.data)
      worker.onerror = (e) => reject(new Error(e.message))
      worker.postMessage({ t: 'solve', wasmUrl: 'bytes:', wasmBytes: readFileSync(wasmFile), blindId, seed, effort: 1, startNonce })
    })
    worker.terminate()
    assert.equal(reply.t, 'solved', JSON.stringify(reply))
    okSolution(reply.solution, 1)
  })

  test('reads the WASM itself from a file: URL', async () => {
    const make = await createNodeWorkerFactory()
    const worker = make(workerUrl)
    const reply = await new Promise((resolveReply, reject) => {
      worker.onmessage = (e) => resolveReply(e.data)
      worker.onerror = (e) => reject(new Error(e.message))
      worker.postMessage({ t: 'solve', wasmUrl: pathToFileURL(wasmFile).href, blindId, seed, effort: 1, startNonce })
    })
    worker.terminate()
    assert.equal(reply.t, 'solved', JSON.stringify(reply))
    okSolution(reply.solution, 1)
  })

  test('solves with the host build of the WASM when the request says variant: host (its glue and WASM only work together)', { skip: !haveHost && 'the host WASM is not built (crates/tor-js-wasm/pkg-host)' }, async () => {
    const make = await createNodeWorkerFactory()
    const worker = make(workerUrl)
    const reply = await new Promise((resolveReply, reject) => {
      worker.onmessage = (e) => resolveReply(e.data)
      worker.onerror = (e) => reject(new Error(e.message))
      worker.postMessage({ t: 'solve', wasmUrl: 'bytes:', wasmBytes: readFileSync(hostWasmFile), variant: 'host', blindId, seed, effort: 1, startNonce })
    })
    worker.terminate()
    assert.equal(reply.t, 'solved', JSON.stringify(reply))
    okSolution(reply.solution, 1)
  })

  test('the default WASM does not work with the host glue: the variant matters', { skip: !haveHost && 'the host WASM is not built' }, async () => {
    const make = await createNodeWorkerFactory()
    const worker = make(workerUrl)
    const reply = await new Promise((resolveReply) => {
      worker.onmessage = (e) => resolveReply(e.data)
      worker.onerror = (e) => resolveReply({ t: 'error', message: e.message })
      worker.postMessage({ t: 'solve', wasmUrl: 'bytes:', wasmBytes: readFileSync(wasmFile), variant: 'host', blindId, seed, effort: 1, startNonce })
    })
    worker.terminate()
    assert.equal(reply.t, 'error', 'the default WASM given to the host glue must fail, which is what the variant field prevents')
  })

  test('answers with an error, not silence, when the WASM cannot be found', async () => {
    const make = await createNodeWorkerFactory()
    const worker = make(workerUrl)
    const reply = await new Promise((resolveReply) => {
      worker.onmessage = (e) => resolveReply(e.data)
      worker.onerror = (e) => resolveReply({ t: 'error', message: e.message })
      worker.postMessage({ t: 'solve', wasmUrl: pathToFileURL(resolve(here, 'does-not-exist.wasm')).href, blindId, seed, effort: 1, startNonce })
    })
    worker.terminate()
    assert.equal(reply.t, 'error')
    assert.ok(reply.message.length > 0)
  })

  test('the pool, with two real workers, returns a valid solution and leaves no worker running', async () => {
    const make = await createNodeWorkerFactory()
    const started = []
    const solve = createPowSolver({
      workerUrl,
      wasmUrl: 'bytes:',
      wasmBytes: readFileSync(wasmFile),
      workers: 2,
      createWorker: (url) => { const w = make(url); started.push(w); return w },
    })
    const s = await solve(blindId, seed, 1)
    okSolution(s, 1)
    assert.equal(started.length, 2)
    // A worker the pool terminated must not keep the process alive: give the event loop a turn.
    await new Promise((r) => setTimeout(r, 50))
  })
})
