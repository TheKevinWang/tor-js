// Live check (needs network and an onion service with proof of work on): the client solves a
// service's puzzles, the real Tor program accepts the solutions, and rejects a wrong one.
//
//   node test/site-live-pow.mjs http://<onion>.onion [--effort 16] [--workers 3] [--big 200]
//
// The service: a Tor with HiddenServicePoWDefensesEnabled 1, such as one run with
// `torrcLines({ pow: true })` from scripts/onion-hardening.mjs. A service that is not
// under attack asks for no effort, so the test sets the least effort the client pays
// (`__torJsPowConfig.minEffort`, see crates/patches/tor-hsclient/PATCH.md), which makes the client
// solve and send a puzzle solution with its introduction request whenever the service uses proof of
// work. The workers are Node worker_threads running the same WASM (test/fixtures/powWorkerNode.mjs).
//
// 1. Idle: with no minimum effort the service asks for none, so no puzzle is solved and no worker
//    starts: a normal visit costs nothing.
// 2. A solved puzzle is accepted: the connection succeeds with the solution attached.
// 3. A corrupted solution is not: the same client with one bit of the proof flipped gets no answer,
//    where step 2 answered within seconds. (The service silently drops a request whose proof does
//    not verify, so the client's own timeout is what it sees.)
// 4. Optionally, a bigger effort (--big N), to see what it costs.

import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TorClient, storage } from '../dist/entryPoints/wasm-file/index.js'
import { bundleTs } from './unit/bundle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const num = (name, fallback) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : fallback)
const onion = argv.find((a) => a.startsWith('http'))
if (!onion) { console.error('usage: node test/site-live-pow.mjs http://<onion>.onion [--effort 16] [--workers 3] [--big 200]'); process.exit(2) }
const effort = num('--effort', 16)
const workers = num('--workers', 3)
const big = num('--big', 0)
const NO_ANSWER_MS = num('--reject-after', 100) * 1000

const m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-live-pow')
const wasmUrl = pathToFileURL(resolve(here, '../dist/tor_js_bg.wasm')).href
const workerFile = resolve(here, 'fixtures/powWorkerNode.mjs')

/** A pool worker backed by a worker_thread, with the interface the pool expects. */
function createWorker() {
  const w = new Worker(workerFile)
  const adapter = {
    postMessage: (msg) => w.postMessage(msg),
    terminate: () => { void w.terminate() },
    onmessage: null,
    onerror: null,
  }
  w.on('message', (data) => adapter.onmessage?.({ data }))
  w.on('error', (e) => adapter.onerror?.({ message: e.message }))
  return adapter
}

let failures = 0
const t0 = performance.now()
const check = (ok, what, extra = '') => {
  if (!ok) failures++
  console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? ' — ' + extra : ''}`)
}

const g = globalThis
/** Install the pool, wrapped so the test sees every puzzle the client hands over and what comes back. */
function install({ minEffort, corrupt = false }) {
  const calls = []
  const remove = m.installPowSolver({ workerUrl: 'worker', wasmUrl, workers, createWorker, minEffort })
  const pool = g.__torJsPowSolve
  g.__torJsPowSolve = async (blindId, seed, e) => {
    const started = performance.now()
    const solution = await pool(blindId, seed, e)
    calls.push({ effort: e, ms: Math.round(performance.now() - started) })
    if (corrupt) solution.proof[0] ^= 1
    return solution
  }
  return { calls, remove }
}

async function visit(label, { limitMs = 120_000 } = {}) {
  const client = new TorClient({ snowflake: true, storage: new storage.MemoryStorage(), logLevel: 'error' })
  await client.ready()
  const started = performance.now()
  try {
    const r = await Promise.race([
      client.fetch(`${onion}/memberlist`),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${limitMs / 1000} s`)), limitMs)),
    ])
    await r.arrayBuffer()
    return { ok: r.status === 200, status: r.status, ms: Math.round(performance.now() - started), client }
  } catch (e) {
    return { ok: false, error: e.message, ms: Math.round(performance.now() - started), client }
  }
}

// 1. idle
{
  const { calls, remove } = install({ minEffort: 0 })
  const r = await visit('idle')
  check(r.ok, `idle: the service answers (${r.ms} ms)`, r.error ?? `HTTP ${r.status}`)
  check(calls.length === 0, 'idle: no puzzle was solved, so no worker was started', `${calls.length} calls`)
  remove(); await r.client.close()
}

// 2. a solved puzzle is accepted
{
  const { calls, remove } = install({ minEffort: effort })
  const r = await visit('solved')
  check(calls.length >= 1, `the client solved a puzzle at effort ${effort}`, calls.map((c) => `effort ${c.effort} in ${c.ms} ms`).join(', '))
  check(calls.every((c) => c.effort >= effort), 'it paid at least the effort asked of it')
  check(r.ok, `the service accepted the solution and answered (${r.ms} ms in all)`, r.error ?? `HTTP ${r.status}`)
  remove(); await r.client.close()
}

// 3. a corrupted solution is not accepted
{
  const { calls, remove } = install({ minEffort: effort, corrupt: true })
  const r = await visit('corrupted', { limitMs: NO_ANSWER_MS })
  check(calls.length >= 1, 'the client solved and sent a (corrupted) solution', `${calls.length} calls`)
  check(!r.ok, `the service did not answer a corrupted solution within ${NO_ANSWER_MS / 1000} s`, r.error ?? `HTTP ${r.status}`)
  remove(); await r.client.close()
}

// 4. what a bigger effort costs
if (big > 0) {
  const { calls, remove } = install({ minEffort: big })
  const r = await visit('big', { limitMs: 600_000 })
  check(r.ok && calls.length >= 1, `effort ${big} with ${workers} workers: solved and accepted`, `${calls.map((c) => `${c.ms} ms`).join(', ')}; whole visit ${r.ms} ms; ${r.error ?? ''}`)
  remove(); await r.client.close()
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
