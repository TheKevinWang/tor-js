// Live check (needs network): proof of work on a hosted onion service. See
// .agent/host-pow-and-optional-host-execplan.md, Milestone 3.
//
//   (build first: wasm-pack build ... && node build.mjs; see the ExecPlan)
//   node test/hs-live-pow.mjs
//
// A hosted service has proof of work on by default. This test checks, over the real Tor network:
//   1. an honest visitor that pays a small effort is verified and served;
//   2. a visitor whose solution is corrupted is rejected and not served;
//   3. a visitor with no solver at all is still served while the service is idle (so turning proof
//      of work on by default does not lock ordinary visitors out).
//
// How a visitor pays: the tor-js client calls globalThis.__torJsPowSolve(blindId, seed, effort)
// when a service uses proof of work, and reads globalThis.__torJsPowConfig ({ minEffort } is the
// least effort to pay even when the service asks for none, which is what lets this test pay
// against a service that is not under attack). In a browser a pool of Web Workers is that
// function; here a plain function solves in-process with the WASM's own solver, loaded as a
// second instance of the WASM.
//
// ENTRY: which build hosts. After the ExecPlan's Milestone 4 hosting is only in the host build.

import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import initSolver, { powSolveV1 } from '../dist/wasm-pkg/tor_js.js'

const entry = process.env.TORJS_ENTRY ?? '../dist/entryPoints/host-file/index.js'
const { TorClient, storage } = await import(pathToFileURL(fileURLToPath(new URL(entry, import.meta.url))).href)

await initSolver({ module_or_path: readFileSync(new URL('../dist/tor_js_bg.wasm', import.meta.url)) })

const t0 = performance.now()
const say = (msg) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`)
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }

const newClient = () => new TorClient({ snowflake: true, storage: new storage.MemoryStorage(), logLevel: process.env.TORJS_LOG ?? 'warn' })

// ---- solvers a visitor can have
const solved = [] // efforts the visitor was asked to solve for
const randomNonce = () => webcrypto.getRandomValues(new Uint8Array(16)) // a repeated nonce would be (rightly) refused as a replay
const honest = async (blindId, seed, effort) => { solved.push(effort); return powSolveV1(blindId, seed, effort, randomNonce()) }
const cheating = async (blindId, seed, effort) => {
  solved.push(effort)
  const solution = powSolveV1(blindId, seed, effort, randomNonce())
  solution.proof[0] ^= 1 // one bit wrong: a solution that does not solve the puzzle
  return solution
}
const installSolver = (fn, config) => {
  if (fn) { globalThis.__torJsPowSolve = fn; globalThis.__torJsPowConfig = config } else { delete globalThis.__torJsPowSolve; delete globalThis.__torJsPowConfig }
  solved.length = 0
}

const host = newClient()
await host.ready()
say('host is ready')
const service = await host.serve((req) => new Response(`ok ${new URL(req.url).pathname}`))
const base = `http://${service.onion}`
say(`hosting at ${base}; proof of work: ${JSON.stringify(service.pow)}`)
if (!service.pow.enabled) fail('proof of work is not on by default')

async function visit(client, path, { retryFor = 0, timeout = 90_000 } = {}) {
  const deadline = Date.now() + retryFor
  for (;;) {
    try {
      const res = await client.fetch(base + path, { signal: AbortSignal.timeout(timeout) })
      return { status: res.status, text: await res.text() }
    } catch (e) {
      if (Date.now() >= deadline) throw e
      await new Promise((r) => setTimeout(r, 4000))
    }
  }
}

// 1. honest, paying
installSolver(honest, { minEffort: 4, maxEffort: 64 })
const visitor1 = newClient()
const first = await visit(visitor1, '/one', { retryFor: 5 * 60_000 })
const afterHonest = service.pow
say(`1. honest visitor: ${first.status} ${JSON.stringify(first.text)}; it solved for effort ${JSON.stringify(solved)}; service: ${JSON.stringify(afterHonest)}`)
if (first.text !== 'ok /one') fail('the honest visitor was not served')
if (solved.length < 1) fail('the visitor was never asked to solve: the service did not publish proof-of-work parameters')
if (afterHonest.verified < 1) fail('the service did not verify the honest solution')
if (afterHonest.rejected !== 0) fail('the service rejected an honest solution')
if (afterHonest.maxEffortSeen < 4) fail('the verified effort was lower than the visitor paid')
visitor1.close()

// 2. cheating
installSolver(cheating, { minEffort: 4, maxEffort: 64 })
const visitor2 = newClient()
const cheated = await visit(visitor2, '/two', { timeout: 75_000 }).then((r) => `served ${r.status}`, (e) => `not served (${String(e?.message ?? e).slice(0, 70)})`)
await new Promise((r) => setTimeout(r, 3000))
const afterCheat = service.pow
say(`2. cheating visitor: ${cheated}; it tried effort ${JSON.stringify(solved)}; service: ${JSON.stringify(afterCheat)}`)
if (cheated.startsWith('served')) fail('a visitor with a corrupted solution was served')
if (afterCheat.rejected < 1) fail('the service did not count the corrupted solution as rejected')
if (afterCheat.verified !== afterHonest.verified) fail('a corrupted solution was counted as verified')
visitor2.close()

// 3. no solver
installSolver(null)
const visitor3 = newClient()
const plain = await visit(visitor3, '/three', { retryFor: 5 * 60_000 })
const afterPlain = service.pow
say(`3. visitor with no solver: ${plain.status} ${JSON.stringify(plain.text)}; service: ${JSON.stringify(afterPlain)}`)
if (plain.text !== 'ok /three') fail('an idle service refused a visitor that cannot solve')
if (afterPlain.enqueued <= afterCheat.enqueued) fail('the request of the visitor without a solver was not queued')
visitor3.close()

service.close()
await service.done
say(`service closed; final counters: ${JSON.stringify(service.pow)}`)
host.close()
console.log('PASS')
process.exit(0)
