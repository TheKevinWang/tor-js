// Live check (needs network): a plain TorClient pays proof of work with no solver supplied by the
// application.
//
//   node test/visitor-pow-live.mjs
//
// The host (the host build, proof of work on by default) is a service that is idle, so it asks visitors
// for no effort. A visitor given `pow: { minEffort: 4 }` pays 4 anyway, which makes the payment checkable
// against the service's own counters without a flood. Nothing here installs `__torJsPowSolve`: the client
// does it, on worker threads (src/pow/autoInstall.ts).
//
// The installed solver is shared by every client in the process and the first client's settings apply, so
// the visitors are created one after another and each is closed before the next.

import { TorClient, storage } from '../dist/entryPoints/host-file/index.js'

// An uncaught exception is a failure too; "origin" says whether it was thrown or was a rejection nobody handled.
process.on('uncaughtException', (e, origin) => {
  console.error(`FAIL: uncaught exception (origin: ${origin}):`, e?.stack ?? e, e?.cause ? '\ncause: ' + (e.cause?.stack ?? e.cause) : '')
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('FAIL: unhandled rejection:', e?.stack ?? e)
  process.exit(1)
})

const t0 = performance.now()
const say = (msg) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`)
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }
const logLevel = process.env.TORJS_LOG ?? 'warn'
const newClient = (extra = {}) => new TorClient({ snowflake: true, storage: new storage.MemoryStorage(), logLevel, ...extra })
const hasSolver = () => typeof globalThis.__torJsPowSolve === 'function'

if (hasSolver()) fail('a solver was already installed before the test started')

// The host takes no part in the sharing: it does not visit anything.
const host = newClient({ pow: false })
if (hasSolver()) fail('pow: false installed a solver')
await host.ready()
const service = await host.serve((req) => new Response(`ok ${new URL(req.url).pathname}`))
const base = `http://${service.onion}`
say(`hosting at ${base}; proof of work: ${JSON.stringify(service.pow)}`)

async function visit(client, path) {
  const deadline = Date.now() + 6 * 60_000
  for (;;) {
    try {
      const res = await client.fetch(base + path, { signal: AbortSignal.timeout(90_000) })
      return { status: res.status, text: await res.text() }
    } catch (e) {
      if (Date.now() >= deadline) throw e
      await new Promise((r) => setTimeout(r, 4000))
    }
  }
}

// 1. a visitor that pays by default-installed solver, because it asked to pay at least 4
const a = newClient({ pow: { minEffort: 4, maxEffort: 64 } })
if (!hasSolver()) fail('creating a client did not install a solver')
const first = await visit(a, '/one')
const afterA = service.pow
say(`1. visitor with pow.minEffort 4: ${first.status} ${JSON.stringify(first.text)}; service: ${JSON.stringify(afterA)}`)
if (first.text !== 'ok /one') fail('the paying visitor was not served')
if (afterA.verified < 1) fail('the service never verified a payment: the client did not pay, or its solver failed')
if (afterA.rejected !== 0) fail('the service rejected the solution of the default solver')
if (afterA.maxEffortSeen < 4) fail(`the effort paid (${afterA.maxEffortSeen}) was below the configured minimum`)
a.close()
if (hasSolver()) fail('closing the only client that used the solver did not remove it')

// 2. default settings against an idle service: nothing to pay, and the visit still works
const b = newClient()
if (!hasSolver()) fail('a default client did not install a solver')
const second = await visit(b, '/two')
const afterB = service.pow
say(`2. visitor with default settings: ${second.status} ${JSON.stringify(second.text)}; service: ${JSON.stringify(afterB)}`)
if (second.text !== 'ok /two') fail('the default visitor was not served')
if (afterB.verified !== afterA.verified) fail('a default visitor paid although the service asked for no effort')
b.close()

// 3. pow: false installs nothing, and the visit works
const c = newClient({ pow: false })
if (hasSolver()) fail('pow: false installed a solver')
const third = await visit(c, '/three')
say(`3. visitor with pow: false: ${third.status} ${JSON.stringify(third.text)}`)
if (third.text !== 'ok /three') fail('the visitor with pow: false was not served')
c.close()

service.close()
await service.done
host.close()
console.log('PASS')

// Closing every client lets the process end by itself: say so if
// something here keeps it alive.
setTimeout(() => fail('the process did not exit by itself after every client was closed'), 150_000).unref()
