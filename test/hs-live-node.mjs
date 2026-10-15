// Live check (needs network): one tor-js client hosts an onion service, a second tor-js client
// visits it, both over the real Tor network through Snowflake.
//
//   (build first, on Windows: the two wasm-pack commands and then node build.mjs.
//    Hosting is in the host build: tor-js/host)
//   node test/hs-live-node.mjs
//
// A new onion service needs time before visitors can reach it (it must set up introduction points
// and publish where they are), so the visitor retries for up to five minutes; early failures are
// expected and are not a failure of the test.

import { TorClient, storage } from '../dist/entryPoints/host-file/index.js'

const t0 = performance.now()
const secs = () => `[${((performance.now() - t0) / 1000).toFixed(1)}s]`
const say = (msg) => console.log(`${secs()} ${msg}`)
const fail = (msg) => { console.error(`${secs()} FAIL: ${msg}`); process.exit(1) }

const logLevel = process.env.TORJS_LOG ?? 'warn'
const newClient = () => new TorClient({ snowflake: true, storage: new storage.MemoryStorage(), logLevel })

const host = newClient()
const visitor = newClient()
await Promise.all([host.ready(), visitor.ready()])
say('both clients are ready')

// The address is a function of the identity alone: check it before going online.
const identity = TorClient.generateIdentity()
const expected = await TorClient.onionAddress(identity)
say(`identity decides the address: ${expected}`)

const seen = []
const service = await host.serve(
  async (req) => {
    const body = req.method === 'POST' ? await req.text() : ''
    const url = new URL(req.url)
    seen.push(`${req.method} ${url.pathname}${url.search}`)
    if (url.pathname === '/echo') return new Response(`echo:${body}`, { headers: { 'content-type': 'text/plain' } })
    if (url.pathname === '/big') return new Response('x'.repeat(200_000))
    return new Response(`hello ${url.pathname}`, { headers: { 'content-type': 'text/plain' } })
  },
  { identity },
)
if (service.onion !== expected) fail(`serve() hosts at ${service.onion}, expected ${expected}`)
say(`hosting at http://${service.onion}`)

const base = `http://${service.onion}`
const deadline = Date.now() + 5 * 60_000
let first
for (let attempt = 1; ; attempt++) {
  try {
    const res = await visitor.fetch(`${base}/ping?x=1`, { signal: AbortSignal.timeout(90_000) })
    const text = await res.text()
    say(`attempt ${attempt}: ${res.status} ${JSON.stringify(text)}`)
    first = { res, text }
    break
  } catch (e) {
    say(`attempt ${attempt}: not yet (${String(e?.message ?? e).slice(0, 110)})`)
    if (Date.now() > deadline) fail('the service did not become reachable within five minutes')
    await new Promise((r) => setTimeout(r, 5000))
  }
}
if (first.res.status !== 200 || first.text !== 'hello /ping') fail(`unexpected first response: ${first.res.status} ${first.text}`)
if (first.res.headers.get('content-type') !== 'text/plain') fail('content-type was not passed through')

const post = await visitor.fetch(`${base}/echo`, { method: 'POST', body: 'from the visitor' })
const postText = await post.text()
say(`POST /echo: ${post.status} ${JSON.stringify(postText)}`)
if (post.status !== 200 || postText !== 'echo:from the visitor') fail('the POST body did not reach the handler and back')

const big = await visitor.fetch(`${base}/big`)
const bigText = await big.text()
say(`GET /big: ${big.status} ${bigText.length} bytes`)
if (bigText.length !== 200_000) fail('a body over 64 KiB (sent chunked? or with a length) arrived truncated')

const refused = await visitor.fetch(`http://${service.onion}:8080/`, { signal: AbortSignal.timeout(60_000) }).then(
  (r) => `answered ${r.status}`,
  (e) => `refused (${String(e?.message ?? e).slice(0, 80)})`,
)
say(`a visit to a port that was not listed: ${refused}`)
if (refused.startsWith('answered')) fail('a visitor reached a port the host did not list')

say(`the handler saw: ${seen.join(', ')}`)
service.close()
await service.done
say('service closed, serve() loop ended')
host.close()
visitor.close()
console.log('PASS')
process.exit(0)
