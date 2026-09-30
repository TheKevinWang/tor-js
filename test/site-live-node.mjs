// Live check (needs network): TorHttp over the real Tor client and Snowflake.
// Fetches DuckDuckGo's onion service through the routing layer exactly as the
// Service Worker would, from Node.
//
//   npm run build && node test/site-live-node.mjs

import { TorClient, storage } from '../dist/entryPoints/wasm-file/index.js'
import { bundleTs } from './unit/bundle.mjs'

const ONION = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion'
const VISIBLE = 'https://user.github.io'
const m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-live')

const t0 = performance.now()
const secs = () => ((performance.now() - t0) / 1000).toFixed(1)
const client = new TorClient({ snowflake: true, storage: new storage.MemoryStorage(), logLevel: 'warn' })
await client.ready()
console.log(`[${secs()}s] Tor ready`)

const manifest = m.parseManifest({
  onion: ONION,
  tor: [{ match: '/duck/**', strip: '/duck' }],
})
const jar = new m.CookieJar()
const torHttp = new m.TorHttp({
  manifest, visibleOrigin: VISIBLE, scopePath: '/', jar,
  fetch: (url, init) => client.fetch(url, init),
})

const probe = await client.fetch(ONION + '/robots.txt')
console.log('rawHeaders present:', Array.isArray(probe.rawHeaders), probe.rawHeaders?.map(([k]) => k).join(','))
await probe.body?.cancel()

async function get(path) {
  const r = await torHttp.handle({ url: VISIBLE + path, method: 'GET', headers: [], body: null })
  const bytes = r.body ? new Uint8Array(await new Response(r.body).arrayBuffer()) : new Uint8Array()
  console.log(`[${secs()}s] GET ${path} -> ${r.status} ${r.headers.find(([k]) => k === 'content-type')?.[1] ?? ''} ${bytes.length}B` +
    (r.headers.find(([k]) => k === 'location') ? ` location=${r.headers.find(([k]) => k === 'location')[1]}` : ''))
  return { r, text: new TextDecoder().decode(bytes) }
}

const robots = await get('/duck/robots.txt')
console.log('  robots.txt starts:', JSON.stringify(robots.text.slice(0, 40)))
const home = await get('/duck/')
console.log('  home has DuckDuckGo:', /DuckDuckGo/.test(home.text))
const html = await get('/duck/html/?q=tor+project')
console.log('  search page:', html.r.status, /tor/i.test(html.text))
console.log('jar:', jar.all().map((c) => `${c.name}@${c.domain}`))
client.close()
process.exit(0)
