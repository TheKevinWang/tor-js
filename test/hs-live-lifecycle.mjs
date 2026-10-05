// Live check (needs network): the lifecycle of a hosted onion service. See
// .agent/onion-service-host-execplan.md, Milestone 5.
//
//   node test/hs-live-lifecycle.mjs
//
// Checks, with one host client and one visitor client over the real Tor network:
//   1. a service answers visitors;
//   2. after listener.close() the same address no longer answers;
//   3. the same identity hosts at the same address again (here with maxConnections 1) and answers;
//   4. while one visitor is held open, a second is refused, and is served once the first is done;
//   5. closing the listener and both clients leaves no handle running that hosting added.
//
// Not checked: that Node exits by itself. It does not, even for a TorClient that never hosted
// anything (measured: it stays alive 45 s+ after close()), which is why the live scripts end in
// process.exit(0). That is existing behaviour, recorded in the ExecPlan, not part of hosting.

import { TorClient, storage } from '../dist/entryPoints/host-file/index.js'

const t0 = performance.now()
const say = (msg) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`)
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }

const newClient = () => new TorClient({ snowflake: true, storage: new storage.MemoryStorage(), logLevel: process.env.TORJS_LOG ?? 'warn' })
const host = newClient()
const visitor = newClient()
await Promise.all([host.ready(), visitor.ready()])
say('both clients are ready')

let hold = null // when set, GET /hold waits for it
const handler = async (req) => {
  const path = new URL(req.url).pathname
  if (path === '/hold' && hold) await hold.promise
  return new Response(`ok ${path}`)
}

async function visit(base, path, { timeout = 90_000, retryFor = 0 } = {}) {
  const deadline = Date.now() + retryFor
  for (;;) {
    try {
      const res = await visitor.fetch(base + path, { signal: AbortSignal.timeout(timeout) })
      return { status: res.status, text: await res.text() }
    } catch (e) {
      if (Date.now() >= deadline) throw e
      await new Promise((r) => setTimeout(r, 4000))
    }
  }
}

const identity = TorClient.generateIdentity()

// 1
let service = await host.serve(handler, { identity })
const base = `http://${service.onion}`
say(`hosting at ${base}`)
const first = await visit(base, '/one', { retryFor: 5 * 60_000 })
say(`1. answers: ${first.status} ${first.text}`)
if (first.text !== 'ok /one') fail('first visit')

// 2
service.close()
await service.done
say('listener closed')
const gone = await visit(base, '/two', { timeout: 60_000 }).then((r) => `still answered ${r.status}`, (e) => `no answer (${String(e?.message ?? e).slice(0, 70)})`)
say(`2. after close: ${gone}`)
if (gone.startsWith('still answered')) fail('the address answered after the service was closed')

// 3
service = await host.serve(handler, { identity, maxConnections: 1 })
if (`http://${service.onion}` !== base) fail(`relaunch hosts at ${service.onion}, not the same address`)
say('relaunched with the same identity at the same address')
const again = await visit(base, '/three', { retryFor: 5 * 60_000 })
say(`3. answers again: ${again.status} ${again.text}`)
if (again.text !== 'ok /three') fail('visit after relaunch')

// 4
let release
hold = { promise: new Promise((r) => (release = r)) }
const held = visit(base, '/hold', { timeout: 120_000 })
await new Promise((r) => setTimeout(r, 8000)) // let the held visit reach the handler
const second = await visit(base, '/four', { timeout: 60_000 }).then((r) => `answered ${r.status}`, (e) => `refused (${String(e?.message ?? e).slice(0, 60)})`)
say(`4. second visitor while one is held and maxConnections is 1: ${second}`)
if (second.startsWith('answered')) fail('the connection limit was not enforced')
release()
const heldResult = await held
if (heldResult.text !== 'ok /hold') fail('the held visit was not answered once released')
const afterRelease = await visit(base, '/five', { retryFor: 60_000 })
say(`   after the first visitor finished: ${afterRelease.status} ${afterRelease.text}`)
if (afterRelease.text !== 'ok /five') fail('the slot was not freed when the first visitor finished')

// 5
service.close()
await service.done
host.close()
visitor.close()
say('5. listener, host and visitor closed; serve() loop ended')
console.log('PASS')
process.exit(0)
