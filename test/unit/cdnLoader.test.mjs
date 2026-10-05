// Unit tests for the shared CDN WASM loader (src/cdnLoader.ts), which the default entry point
// (`tor-js`) and the host entry point (`tor-js/host`) both use with different settings.
//
//   npm run test:unit

import { test, before, beforeEach, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  // A stub indexedDB makes every cache operation fail, which the loader treats as "no cache": the
  // tests then neither read nor write the real disk.
  globalThis.indexedDB = {}
  m = await bundleTs('src/cdnLoader.ts', 'cdn-loader')
})

const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251])
const sha = createHash('sha256').update(bytes).digest('hex')
const options = (over = {}) => ({ fileName: 'tor_js_bg.wasm', sha256: sha, packageVersion: '9.9.9', cacheKey: 'wasm', githubMirror: true, ...over })

let realFetch
let calls
beforeEach(() => { realFetch = globalThis.fetch; calls = [] })
afterEach(() => { globalThis.fetch = realFetch })

/** fetch stub: `answer(url)` returns a Response, or throws. */
function stubFetch(answer) {
  globalThis.fetch = async (url) => { calls.push(String(url)); return answer(String(url)) }
}
const ok = (body) => new Response(body)
const notFound = () => new Response('no', { status: 404 })

describe('the places it tries', () => {
  test('the default build tries both npm mirrors and the encrypted GitHub mirror', () => {
    const s = m.cdnSources(options(), 'ab', 'abcdef')
    assert.equal(s.length, 3)
    assert.deepEqual(s.map((x) => x.encrypted), [false, false, true])
    assert.ok(s[0].urls[0].includes('cdn.jsdelivr.net/npm/tor-js@9.9.9/dist/tor_js_bg.wasm'))
    assert.ok(s[1].urls[0].includes('unpkg.com/tor-js@9.9.9/dist/tor_js_bg.wasm'))
    assert.ok(s[2].urls[0].includes('raw.githubusercontent.com') && s[2].urls[0].endsWith('/ab/abcdef'))
  })

  test('the host build names its own file and never tries the GitHub mirror', () => {
    const s = m.cdnSources(options({ fileName: 'tor_js_host_bg.wasm', githubMirror: false }), 'ab', 'abcdef')
    assert.equal(s.length, 2)
    for (const source of s) {
      assert.equal(source.encrypted, false)
      assert.ok(source.urls.every((u) => u.endsWith('/dist/tor_js_host_bg.wasm')), source.urls.join())
    }
  })
})

describe('downloading', () => {
  test('returns bytes whose hash matches', async () => {
    stubFetch(() => ok(bytes))
    const out = await m.createCdnWasmSource(options())()
    assert.deepEqual(Array.from(out), Array.from(bytes))
  })

  test('falls back to the next source when one fails, whatever order they are tried in', async () => {
    for (let i = 0; i < 12; i++) {
      calls = []
      stubFetch((url) => (url.includes('jsdelivr') ? notFound() : ok(bytes)))
      const out = await m.createCdnWasmSource(options({ githubMirror: false }))()
      assert.deepEqual(Array.from(out), Array.from(bytes))
      assert.ok(calls.every((u) => u.includes('jsdelivr') || u.includes('unpkg')))
    }
  })

  test('refuses bytes whose hash does not match, and lists every source it tried', async () => {
    stubFetch(() => ok(new Uint8Array([9, 9, 9])))
    await assert.rejects(m.createCdnWasmSource(options({ githubMirror: false }))(), (e) => {
      assert.match(e.message, /Failed to load WASM from any CDN/)
      assert.match(e.message, /SHA256 mismatch/)
      assert.ok(e.message.includes('jsdelivr') && e.message.includes('unpkg'))
      return true
    })
  })

  test('the host build asks only for its own file and never contacts GitHub', async () => {
    stubFetch(() => ok(bytes))
    await m.createCdnWasmSource(options({ fileName: 'tor_js_host_bg.wasm', githubMirror: false, cacheKey: 'wasm-host' }))()
    assert.ok(calls.length >= 1)
    assert.ok(calls.every((u) => u.endsWith('/dist/tor_js_host_bg.wasm')), calls.join())
    assert.ok(!calls.some((u) => u.includes('githubusercontent')))
  })
})
