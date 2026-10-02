// Unit tests for the static-site adapter (src/site/): route manifest, cookie
// jar, and the TorHttp semantics layer. TorHttp runs against a real local HTTP
// server; the "Tor side" fetch is raw node:http (not undici, which would
// silently gunzip and hide what tor-js's fetch really delivers).
//
//   npm run test:unit

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { gzipSync } from 'node:zlib'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site')
})

// ===========================================================================
// manifest
// ===========================================================================

describe('manifest routing', () => {
  const ONION = 'http://abcdefghijklmnop.onion'
  const parse = (o) => m.parseManifest({ onion: ONION, ...o })

  test('paths matching nothing are static', () => {
    const man = parse({ tor: ['/api/**'] })
    assert.deepEqual(m.routeFor(man, '/index.html'), { kind: 'static' })
    assert.deepEqual(m.routeFor(man, '/'), { kind: 'static' })
  })

  test('** crosses segments, * does not, and a trailing /** matches the bare directory', () => {
    const man = parse({ tor: ['/api/**', '/u/*/inbox'] })
    assert.equal(m.routeFor(man, '/api').kind, 'tor')
    assert.equal(m.routeFor(man, '/api/').kind, 'tor')
    assert.equal(m.routeFor(man, '/api/a/b/c').kind, 'tor')
    assert.equal(m.routeFor(man, '/apix').kind, 'static')
    assert.equal(m.routeFor(man, '/u/bob/inbox').kind, 'tor')
    assert.equal(m.routeFor(man, '/u/bob/x/inbox').kind, 'static')
  })

  test('static patterns win over tor patterns', () => {
    const man = parse({ tor: ['/**'], static: ['/assets/**', '/index.html'] })
    assert.equal(m.routeFor(man, '/assets/app.js').kind, 'static')
    assert.equal(m.routeFor(man, '/index.html').kind, 'static')
    assert.equal(m.routeFor(man, '/anything').kind, 'tor')
  })

  test('regex metacharacters in a pattern are literal', () => {
    const man = parse({ tor: ['/a.b/(x)+'] })
    assert.equal(m.routeFor(man, '/a.b/(x)+').kind, 'tor')
    assert.equal(m.routeFor(man, '/aXb/(x)+').kind, 'static')
  })

  test('strip mounts a backend under a prefix, at a segment boundary', () => {
    const man = parse({ tor: [{ match: '/duck/**', strip: '/duck' }] })
    assert.deepEqual(m.routeFor(man, '/duck/html/'), { kind: 'tor', onion: ONION, path: '/html/' })
    assert.deepEqual(m.routeFor(man, '/duck'), { kind: 'tor', onion: ONION, path: '/' })
    assert.deepEqual(m.routeFor(man, '/duck/'), { kind: 'tor', onion: ONION, path: '/' })
  })

  test('each rule can name its own onion service', () => {
    const other = 'https://zzzzzzzzzzzzzzzz.onion'
    const man = parse({ tor: ['/a/**', { match: '/b/**', onion: other }] })
    assert.equal(m.routeFor(man, '/a/x').onion, ONION)
    assert.equal(m.routeFor(man, '/b/x').onion, other)
    assert.deepEqual(man.onions.sort(), [ONION, other].sort())
  })

  test('an onion is matched by host, so http and https forms name the same service', () => {
    const man = parse({ tor: ['/api/**'] })
    assert.equal(m.canonicalOnion(man, 'https://abcdefghijklmnop.onion'), ONION)
    assert.equal(m.canonicalOnion(man, 'https://other.onion'), undefined)
  })

  test('visiblePathFor inverts strip', () => {
    const man = parse({ tor: [{ match: '/duck/**', strip: '/duck' }] })
    assert.equal(m.visiblePathFor(man, ONION, '/html/'), '/duck/html/')
    assert.equal(m.visiblePathFor(man, ONION, '/'), '/duck/')
    const plain = parse({ tor: ['/api/**'] })
    assert.equal(m.visiblePathFor(plain, ONION, '/api/x'), '/api/x')
    assert.equal(m.visiblePathFor(plain, ONION, '/other'), null)
  })

  test('rejects malformed manifests with a message naming the field', () => {
    assert.throws(() => m.parseManifest([]), /JSON object/)
    assert.throws(() => m.parseManifest({ version: 2 }), /version/)
    assert.throws(() => m.parseManifest({ onion: 'http://example.com' }), /\.onion/)
    assert.throws(() => m.parseManifest({ onion: 'ftp://a.onion' }), /http/)
    assert.throws(() => m.parseManifest({ onion: ONION + '/path' }), /origin only/)
    assert.throws(() => m.parseManifest({ tor: ['/x'] }), /no onion service/)
    assert.throws(() => parse({ tor: ['api/**'] }), /start with "\/"/)
    assert.throws(() => parse({ tor: [{ strip: '/x' }] }), /match/)
    assert.throws(() => parse({ tor: [{ match: '/x', strip: 'x' }] }), /strip/)
    assert.throws(() => parse({ client: { snowflake: 'carrier-pigeon' } }), /"websocket" or "webrtc"/)
    assert.throws(() => parse({ client: { snowflake: 'webrtc', host: 'service-worker' } }), /"webrtc".*"service-worker"/)
    assert.throws(() => parse({ client: { host: 'nope' } }), /host/)
  })

  test('the WebRTC carrier is accepted with the default (host worker) placement', () => {
    assert.equal(parse({ client: { snowflake: 'webrtc' } }).client.snowflake, 'webrtc')
    assert.equal(parse({ client: { snowflake: 'websocket', host: 'service-worker' } }).client.host, 'service-worker')
  })

  test('client.inject and client.pageScript', () => {
    assert.equal(parse({}).client.inject, undefined, 'unset means on (the Service Worker applies the default)')
    assert.equal(parse({ client: { inject: false } }).client.inject, false)
    assert.equal(parse({ client: { pageScript: 'js/tor-site.js' } }).client.pageScript, 'js/tor-site.js')
    assert.throws(() => parse({ client: { inject: 'yes' } }), /"client.inject" must be true or false/)
    assert.throws(() => parse({ client: { pageScript: 3 } }), /pageScript/)
  })

  test('backendKnowsBase is a boolean that defaults to false', () => {
    assert.equal(parse({}).backendKnowsBase, false)
    assert.equal(parse({ backendKnowsBase: true }).backendKnowsBase, true)
    assert.throws(() => parse({ backendKnowsBase: 'yes' }), /backendKnowsBase/)
  })

  test('the default carrier is WebRTC wherever a page can host the peer, WebSocket otherwise', () => {
    assert.deepEqual(parse({}).client, { snowflake: 'webrtc', host: 'auto' })
    assert.deepEqual(m.parseManifest({}).client, { snowflake: 'webrtc', host: 'auto' }, 'no client section at all')
    assert.equal(parse({ client: { host: 'service-worker' } }).client.snowflake, true, 'no page can host a peer there')
    assert.equal(parse({ client: { snowflake: 'websocket' } }).client.snowflake, 'websocket', 'always an opt-out')
    assert.equal(parse({ client: { snowflake: true } }).client.snowflake, true)
    assert.throws(() => parse({ client: { snowflake: 'webrtc', host: 'service-worker' } }), /"webrtc".*"service-worker"/, 'an explicit choice is not overridden')
  })

  test('client.shell: the persistent frame shell', () => {
    const c = parse({ client: { shell: 'frame', shellPage: 'shell/tor.html' } }).client
    assert.equal(c.shell, 'frame')
    assert.equal(c.shellPage, 'shell/tor.html')
    assert.equal(c.snowflake, 'webrtc', 'WebRTC is available with a shell')
    assert.equal(parse({}).client.shell, undefined)
    assert.throws(() => parse({ client: { shell: 'iframe' } }), /"client.shell" must be "frame"/)
    assert.throws(() => parse({ client: { shell: 'frame', host: 'service-worker' } }), /"frame".*"service-worker"/)
    assert.throws(() => parse({ client: { shellPage: 4 } }), /shellPage/)
  })
})

// ===========================================================================
// cookie jar
// ===========================================================================

describe('cookie jar', () => {
  const URL_ = 'http://abcdefghijklmnop.onion/app/page'
  const T0 = 1_000_000

  test('a cookie round-trips; the newest value replaces the old', () => {
    const jar = new m.CookieJar()
    jar.setFromResponse(URL_, ['sid=one; HttpOnly'], T0)
    assert.equal(jar.headerFor(URL_, T0), 'sid=one')
    jar.setFromResponse(URL_, ['sid=two'], T0 + 1)
    assert.equal(jar.headerFor(URL_, T0), 'sid=two')
    assert.equal(jar.all().length, 1)
  })

  test('host-only cookies do not go to other hosts; Domain cookies go to subdomains', () => {
    const jar = new m.CookieJar()
    jar.setFromResponse('http://a.example.onion/', ['h=1', 'd=2; Domain=example.onion'], T0)
    assert.equal(jar.headerFor('http://a.example.onion/', T0), 'h=1; d=2')
    assert.equal(jar.headerFor('http://b.example.onion/', T0), 'd=2')
    assert.equal(jar.headerFor('http://example.onion/', T0), 'd=2')
    assert.equal(jar.headerFor('http://other.onion/', T0), '')
  })

  test('a Domain naming another host, or a bare TLD, is rejected', () => {
    const jar = new m.CookieJar()
    jar.setFromResponse('http://a.onion/', ['x=1; Domain=b.onion', 'y=1; Domain=onion'], T0)
    assert.equal(jar.all().length, 0)
  })

  test('Path scoping, longest path first', () => {
    const jar = new m.CookieJar()
    jar.setFromResponse('http://a.onion/', ['root=1; Path=/', 'deep=2; Path=/app/x'], T0)
    assert.equal(jar.headerFor('http://a.onion/app/x/y', T0), 'deep=2; root=1')
    assert.equal(jar.headerFor('http://a.onion/app/xy', T0), 'root=1')
    assert.equal(jar.headerFor('http://a.onion/other', T0), 'root=1')
  })

  test('the default path is the directory of the request URL', () => {
    const jar = new m.CookieJar()
    jar.setFromResponse('http://a.onion/app/login', ['k=v'], T0)
    assert.equal(jar.all()[0].path, '/app')
    assert.equal(jar.headerFor('http://a.onion/app/x', T0), 'k=v')
    assert.equal(jar.headerFor('http://a.onion/x', T0), '')
  })

  test('Max-Age and Expires expire cookies; Max-Age wins; deleting works', () => {
    const jar = new m.CookieJar()
    jar.setFromResponse(URL_, [
      'a=1; Max-Age=10',
      'b=1; Expires=' + new Date(T0 + 5000).toUTCString(),
      'c=1; Max-Age=10; Expires=' + new Date(T0 - 5000).toUTCString(),
    ], T0)
    assert.equal(jar.headerFor(URL_, T0 + 1000), 'a=1; b=1; c=1')
    assert.equal(jar.headerFor(URL_, T0 + 6000), 'a=1; c=1')
    assert.equal(jar.headerFor(URL_, T0 + 11_000), '')
    jar.setFromResponse(URL_, ['s=1'], T0)
    jar.setFromResponse(URL_, ['s=; Max-Age=0'], T0 + 1)
    assert.equal(jar.headerFor(URL_, T0 + 2), '')
  })

  test('Secure cookies are sent to onion hosts over http but refused from plain http hosts', () => {
    const jar = new m.CookieJar()
    jar.setFromResponse('http://a.onion/', ['s=1; Secure'], T0)
    assert.equal(jar.headerFor('http://a.onion/', T0), 's=1')
    jar.setFromResponse('http://plain.example/', ['s=1; Secure'], T0)
    assert.equal(jar.all().length, 1)
  })

  test('junk headers are ignored', () => {
    const jar = new m.CookieJar()
    jar.setFromResponse(URL_, ['noequals', '=novalue', 'bad name=1', 'x'.repeat(5000) + '=1'], T0)
    assert.equal(jar.all().length, 0)
  })

  test('persists through a store and drops expired cookies on load', async () => {
    let saved = []
    const store = { load: async () => saved, save: async (c) => { saved = c } }
    const a = new m.CookieJar(store)
    a.setFromResponse(URL_, ['keep=1; Max-Age=1000', 'gone=1; Max-Age=1'], Date.now())
    await a.flush()
    assert.equal(saved.length, 2)
    const b = new m.CookieJar(store)
    await b.load(Date.now() + 5000)
    assert.equal(b.headerFor(URL_, Date.now() + 5000), 'keep=1')
  })
})

// ===========================================================================
// TorHttp against a real server
// ===========================================================================

describe('TorHttp', () => {
  let server, origin
  let seen = []

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString() })
        const path = req.url.split('?')[0].replace(/^\/api(?=\/)/, '')
        if (path === '/login') {
          res.writeHead(302, { location: req.url.startsWith('/api') ? '/api/home' : '/home', 'set-cookie': ['sid=abc; Path=/; HttpOnly', 'theme=dark; Path=/'] })
          return res.end()
        }
        if (path === '/schemeup') {
          res.writeHead(301, { location: `https://${req.headers.host}/api/home` })
          return res.end()
        }
        if (path === '/knows') {
          res.writeHead(302, { location: '/repo/api/home' })
          return res.end()
        }
        if (path === '/external') {
          res.writeHead(302, { location: 'https://elsewhere.example/x' })
          return res.end()
        }
        if (path === '/whoami') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          return res.end(`cookie=${req.headers.cookie ?? ''}`)
        }
        if (path === '/echo') {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ method: req.method, body: body.toString(), query: req.url.split('?')[1] ?? '' }))
        }
        if (path === '/gz') {
          const gz = gzipSync('hello '.repeat(1000))
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': gz.length })
          return res.end(gz)
        }
        if (path === '/hsts') {
          res.writeHead(200, { 'strict-transport-security': 'max-age=1', 'clear-site-data': '"storage"', 'x-keep': 'yes' })
          return res.end('ok')
        }
        if (path === '/nobody') {
          res.writeHead(204)
          return res.end()
        }
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('nope')
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${server.address().port}`
  })
  after(() => server.close())

  /** fetch over raw node:http, returning a Response with `rawHeaders` like tor-js does. */
  function rawFetch(url, init = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: init.method ?? 'GET', headers: init.headers ?? {} }, (res) => {
        const bufs = []
        res.on('data', (c) => bufs.push(c))
        res.on('end', () => {
          const status = res.statusCode
          const noBody = status === 204 || status === 304
          const r = new Response(noBody ? null : Buffer.concat(bufs), { status })
          const pairs = []
          for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]])
          r.rawHeaders = pairs
          resolve(r)
        })
      })
      req.on('error', reject)
      if (init.body) req.write(init.body)
      req.end()
    })
  }

  const VISIBLE = 'https://user.github.io'

  function make({ scopePath = '/', fetch = rawFetch } = {}) {
    const manifest = m.parseManifest(
      { onion: origin, tor: ['/api/**', { match: '/site/**', strip: '/site' }] },
      { allowAnyHost: true },
    )
    const jar = new m.CookieJar()
    const torHttp = new m.TorHttp({ manifest, visibleOrigin: VISIBLE, scopePath, fetch, jar })
    return { torHttp, jar }
  }
  const req = (url, extra = {}) => ({ url, method: 'GET', headers: [], body: null, ...extra })
  const text = async (r) => (r.body ? await new Response(r.body).text() : '')
  const header = (r, k) => r.headers.find(([n]) => n === k)?.[1]

  test('route: tor paths, static paths, out-of-scope and foreign hosts', () => {
    const { torHttp } = make({ scopePath: '/repo/' })
    assert.equal(torHttp.route(`${VISIBLE}/repo/api/x`).kind, 'tor')
    assert.equal(torHttp.route(`${VISIBLE}/repo/index.html`).kind, 'static')
    assert.equal(torHttp.route(`${VISIBLE}/api/x`), null, 'outside the scope')
    assert.equal(torHttp.route('https://cdn.example/api/x'), null)
    assert.equal(torHttp.route(`${origin}/anything`).kind, 'tor', 'a direct request to an allowed onion is Tor')
  })

  test('forwards path, query and method to the onion, stripping the mount prefix', async () => {
    const { torHttp } = make()
    seen = []
    const r = await torHttp.handle(req(`${VISIBLE}/site/echo?q=1&b=2`))
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(await text(r)), { method: 'GET', body: '', query: 'q=1&b=2' })
    assert.equal(seen[0].url, '/echo?q=1&b=2')
  })

  test('honours a project-page scope: /repo/api/x reaches the onion as /api/x', async () => {
    const { torHttp } = make({ scopePath: '/repo/' })
    seen = []
    await torHttp.handle(req(`${VISIBLE}/repo/api/echo`))
    assert.equal(seen[0].url, '/api/echo')
  })

  test('POST body is delivered intact', async () => {
    const { torHttp } = make()
    const r = await torHttp.handle(req(`${VISIBLE}/api/echo`, {
      method: 'POST', headers: [['content-type', 'text/plain']], body: new TextEncoder().encode('héllo'),
    }))
    assert.equal(JSON.parse(await text(r)).body, 'héllo')
  })

  test('Set-Cookie fills the jar, is hidden from the page, and comes back as Cookie', async () => {
    const { torHttp, jar } = make()
    const login = await torHttp.handle(req(`${VISIBLE}/api/login`, { method: 'POST' }))
    assert.equal(header(login, 'set-cookie'), undefined)
    assert.equal(jar.all().length, 2)
    assert.ok(jar.all().find((c) => c.name === 'sid').httpOnly)
    const me = await torHttp.handle(req(`${VISIBLE}/api/whoami`))
    assert.equal(await text(me), 'cookie=sid=abc; theme=dark')
  })

  test("the browser's own Cookie header is never forwarded", async () => {
    const { torHttp } = make()
    const me = await torHttp.handle(req(`${VISIBLE}/api/whoami`, { headers: [['Cookie', 'github=secret']] }))
    assert.equal(await text(me), 'cookie=')
  })

  test('redirects are returned to the browser with Location on the visible origin', async () => {
    const { torHttp } = make()
    const r = await torHttp.handle(req(`${VISIBLE}/api/login`, { method: 'POST' }))
    assert.equal(r.status, 302)
    assert.equal(header(r, 'location'), `${VISIBLE}/api/home`)
    const mounted = await torHttp.handle(req(`${VISIBLE}/site/login`))
    assert.equal(header(mounted, 'location'), `${VISIBLE}/site/home`, 'strip is re-applied')
  })

  test('the visible Location keeps the scope prefix', async () => {
    const { torHttp } = make({ scopePath: '/repo/' })
    const r = await torHttp.handle(req(`${VISIBLE}/repo/api/login`))
    assert.equal(header(r, 'location'), `${VISIBLE}/repo/api/home`)
  })

  test('a redirect to the same onion under the other scheme is still ours', async () => {
    const { torHttp } = make()
    const r = await torHttp.handle(req(`${VISIBLE}/api/schemeup`))
    assert.equal(header(r, 'location'), `${VISIBLE}/api/home`)
  })

  test('a backend that knows the site base path gets no second prefix; an unaware one does', async () => {
    const mk = (extra) => {
      const manifest = m.parseManifest({ onion: origin, tor: ['/api/**'], ...extra }, { allowAnyHost: true })
      return new m.TorHttp({ manifest, visibleOrigin: VISIBLE, scopePath: '/repo/', fetch: rawFetch, jar: new m.CookieJar() })
    }
    const aware = await mk({ backendKnowsBase: true }).handle(req(`${VISIBLE}/repo/api/knows`))
    assert.equal(header(aware, 'location'), `${VISIBLE}/repo/api/home`)
    const unaware = await mk({}).handle(req(`${VISIBLE}/repo/api/knows`))
    assert.equal(header(unaware, 'location'), `${VISIBLE}/repo/repo/api/home`, 'what an aware backend would get without the flag')
    // A path outside the prefix still falls back to the unaware mapping, and root hosting is unaffected.
    const root = new m.TorHttp({
      manifest: m.parseManifest({ onion: origin, tor: ['/api/**'], backendKnowsBase: true }, { allowAnyHost: true }),
      visibleOrigin: VISIBLE, scopePath: '/', fetch: rawFetch, jar: new m.CookieJar(),
    })
    assert.equal(header(await root.handle(req(`${VISIBLE}/api/login`)), 'location'), `${VISIBLE}/api/home`)
  })

  test('a redirect to another host is passed through unchanged', async () => {
    const { torHttp } = make()
    const r = await torHttp.handle(req(`${VISIBLE}/api/external`))
    assert.equal(header(r, 'location'), 'https://elsewhere.example/x')
  })

  test('gzip responses are decoded and their length/encoding headers dropped', async () => {
    const { torHttp } = make()
    seen = []
    const r = await torHttp.handle(req(`${VISIBLE}/api/gz`))
    assert.equal(seen[0].headers['accept-encoding'], 'gzip')
    assert.equal(await text(r), 'hello '.repeat(1000))
    assert.equal(header(r, 'content-encoding'), undefined)
    assert.equal(header(r, 'content-length'), undefined)
  })

  test('Range requests ask for no compression', async () => {
    const { torHttp } = make()
    seen = []
    await torHttp.handle(req(`${VISIBLE}/api/echo`, { headers: [['Range', 'bytes=0-9']] }))
    assert.equal(seen[0].headers['accept-encoding'], undefined)
    assert.equal(seen[0].headers.range, 'bytes=0-9')
  })

  test('Origin and Referer name the onion, not the static site; sec-* and hop-by-hop headers are dropped', async () => {
    const { torHttp } = make()
    seen = []
    await torHttp.handle(req(`${VISIBLE}/api/echo`, {
      method: 'POST', body: new Uint8Array([1]),
      headers: [
        ['Origin', VISIBLE], ['Referer', `${VISIBLE}/page`], ['Sec-Fetch-Site', 'same-origin'],
        ['Connection', 'keep-alive'], ['X-Custom', 'kept'],
      ],
    }))
    const h = seen[0].headers
    assert.equal(h.origin, origin)
    assert.equal(h.referer, origin + '/')
    assert.equal(h['sec-fetch-site'], undefined)
    assert.equal(h['x-custom'], 'kept')
  })

  test("every visitor sends the same User-Agent, never the browser's own", async () => {
    const { torHttp } = make()
    seen = []
    await torHttp.handle(req(`${VISIBLE}/api/echo`, { headers: [['User-Agent', 'Chrome/999 real-browser']] }))
    await torHttp.handle(req(`${VISIBLE}/api/echo`, { headers: [['Accept-Language', 'de']] }))
    assert.equal(seen[0].headers['user-agent'], m.TOR_USER_AGENT)
    assert.equal(seen[0].headers['accept-language'], 'en-US,en;q=0.5')
    assert.equal(seen[1].headers['user-agent'], m.TOR_USER_AGENT)
    assert.equal(seen[1].headers['accept-language'], 'de', 'a language the page chose is kept')
  })

  test('response headers that would act on the static site are dropped', async () => {
    const { torHttp } = make()
    const r = await torHttp.handle(req(`${VISIBLE}/api/hsts`))
    assert.equal(header(r, 'strict-transport-security'), undefined)
    assert.equal(header(r, 'clear-site-data'), undefined)
    assert.equal(header(r, 'x-keep'), 'yes')
  })

  test('204 has no body and HEAD releases the stream', async () => {
    const { torHttp } = make()
    const r = await torHttp.handle(req(`${VISIBLE}/api/nobody`))
    assert.equal(r.status, 204)
    assert.equal(r.body, null)
    const h = await torHttp.handle(req(`${VISIBLE}/api/echo`, { method: 'HEAD' }))
    assert.equal(h.body, null)
  })

  test('a Tor-side failure becomes a 502 with an explanation, not an exception', async () => {
    const { torHttp } = make({ fetch: async () => { throw new Error('circuit failed') } })
    const r = await torHttp.handle(req(`${VISIBLE}/api/x`))
    assert.equal(r.status, 502)
    assert.equal(header(r, 'x-tor-site-error'), '1')
    assert.match(await text(r), /circuit failed/)
  })

  test('refuses to handle a static path', async () => {
    const { torHttp } = make()
    await assert.rejects(torHttp.handle(req(`${VISIBLE}/index.html`)), /not routed to Tor/)
  })

  test('falls back to Response.headers.getSetCookie when rawHeaders is absent', async () => {
    const plain = async () => {
      const h = new Headers()
      h.append('set-cookie', 'a=1; Path=/')
      h.append('set-cookie', 'b=2; Path=/')
      return new Response('x', { headers: h })
    }
    const { torHttp, jar } = make({ fetch: plain })
    await torHttp.handle(req(`${VISIBLE}/api/x`))
    assert.equal(jar.all().length, 2)
  })
})
