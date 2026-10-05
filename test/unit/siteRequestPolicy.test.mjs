// Unit tests for src/site/requestPolicy.ts: deciding who started a request from what a Service Worker
// can see, and what that request may carry. The evidence in each case is what Chromium 152 showed a
// probe Service Worker (see .agent/code-review-fixes-execplan.md, Surprises & Discoveries).
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-request-policy')
})

const SITE = 'https://user.github.io'
const EVIL = 'https://evil.example'

describe('classifyInitiator', () => {
  const classify = (e) => m.classifyInitiator({ visibleOrigin: SITE, ...e })

  test('anything that is not a navigation comes from a page this worker controls', () => {
    for (const mode of ['cors', 'no-cors', 'same-origin']) {
      assert.equal(classify({ mode, originHeader: EVIL, referrer: `${EVIL}/x` }), 'same-origin', mode)
    }
  })

  test("a navigation started by one of the site's pages is same-origin, even when that page hides its referrer", () => {
    // Form post from a site page with <meta name="referrer" content="no-referrer">: Origin "null", no referrer.
    assert.equal(classify({ mode: 'navigate', clientOrigin: SITE, originHeader: 'null', referrer: '' }), 'same-origin')
    assert.equal(classify({ mode: 'navigate', clientOrigin: SITE, referrer: `${SITE}/form` }), 'same-origin')
  })

  test("another site's form post is cross-site, by its Origin header", () => {
    assert.equal(classify({ mode: 'navigate', clientOrigin: null, originHeader: EVIL, referrer: `${EVIL}/` }), 'cross-site')
  })

  test("Origin \"null\" (a hidden origin) is not the site's", () => {
    assert.equal(classify({ mode: 'navigate', clientOrigin: null, originHeader: 'null', referrer: '' }), 'cross-site')
  })

  test('without Origin, the referrer decides', () => {
    assert.equal(classify({ mode: 'navigate', referrer: `${EVIL}/page` }), 'cross-site')
    assert.equal(classify({ mode: 'navigate', referrer: `${SITE}/page` }), 'same-origin')
  })

  test('a link with referrerpolicy="no-referrer" from elsewhere, or a typed URL, leaves no evidence', () => {
    assert.equal(classify({ mode: 'navigate', clientOrigin: null, originHeader: null, referrer: '' }), 'unknown')
    assert.equal(classify({ mode: 'navigate', referrer: 'about:client' }), 'unknown')
  })

  test('a page on the same host but another port is another origin', () => {
    assert.equal(classify({ mode: 'navigate', originHeader: 'https://user.github.io:8443' }), 'cross-site')
  })
})

describe('refusal', () => {
  test('state-changing methods are refused unless the site started the request', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'post']) {
      assert.match(m.refusal({ method, initiator: 'cross-site' }), /another site/, method)
      assert.match(m.refusal({ method, initiator: 'unknown' }), /could not be identified/, method)
      assert.ok(m.refusal({ method }), `${method} with no initiator`)
      assert.equal(m.refusal({ method, initiator: 'same-origin' }), null, method)
    }
  })

  test('safe methods are never refused', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      for (const initiator of ['cross-site', 'unknown', undefined]) {
        assert.equal(m.refusal({ method, initiator }), null, `${method} ${initiator}`)
      }
    }
  })
})

describe('cookieDecision', () => {
  test('credentials "omit" sends and stores nothing', () => {
    assert.deepEqual(m.cookieDecision({ method: 'GET', initiator: 'same-origin', credentials: 'omit' }), { send: false, includeStrict: false, store: false })
  })

  test('Strict cookies only for the site\'s own requests', () => {
    assert.equal(m.cookieDecision({ method: 'GET', initiator: 'same-origin', credentials: 'same-origin' }).includeStrict, true)
    assert.equal(m.cookieDecision({ method: 'GET', initiator: 'cross-site', credentials: 'include' }).includeStrict, false)
    assert.equal(m.cookieDecision({ method: 'GET', initiator: 'unknown', credentials: 'include' }).includeStrict, false)
    assert.equal(m.cookieDecision({ method: 'GET' }).includeStrict, false)
  })
})

describe('abort helpers', () => {
  test('abortable rejects with a recognisable abort error and leaves the shared promise alone', async () => {
    let resolveShared
    const shared = new Promise((r) => (resolveShared = r))
    const ac = new AbortController()
    const p = m.abortable(shared, ac.signal)
    ac.abort('why')
    const err = await p.catch((e) => e)
    assert.ok(m.isAbortError(err))
    assert.equal(err.cause, 'why')
    resolveShared(7)
    assert.equal(await m.abortable(shared, new AbortController().signal), 7, 'the shared work still completes for others')
  })

  test('isAbortError recognises DOM AbortErrors and the WASM client\'s error', () => {
    assert.ok(m.isAbortError(new DOMException('x', 'AbortError')))
    assert.ok(m.isAbortError(Object.assign(new Error('The operation was aborted'), { code: 'ABORT' })))
    assert.ok(!m.isAbortError(new Error('circuit failed')))
  })
})
