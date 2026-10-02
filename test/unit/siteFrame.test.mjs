// Unit tests for the frame shell's pure parts (src/site/frame.ts) and for the
// header changes that let Tor-served pages be shown in its iframe
// (src/site/frameHeaders.ts).
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-frame')
})

describe('frame headers', () => {
  test('X-Frame-Options is dropped and framing is limited to this site', () => {
    const out = m.adaptForFrame([['content-type', 'text/html'], ['X-Frame-Options', 'DENY'], ['x-keep', '1']])
    assert.deepEqual(out, [
      ['content-type', 'text/html'], ['x-keep', '1'],
      ['content-security-policy', "frame-ancestors 'self'"],
    ])
  })

  test("the backend's frame-ancestors is removed from its CSP; the rest of the policy stays", () => {
    const out = m.adaptForFrame([
      ['Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; img-src data:"],
    ])
    assert.deepEqual(out, [
      ['Content-Security-Policy', "default-src 'self'; img-src data:"],
      ['content-security-policy', "frame-ancestors 'self'"],
    ])
  })

  test('a CSP that only said frame-ancestors disappears; ours remains', () => {
    const out = m.adaptForFrame([['content-security-policy', 'frame-ancestors https://evil.example']])
    assert.deepEqual(out, [['content-security-policy', "frame-ancestors 'self'"]])
  })

  test('frame-ancestors is matched as a whole directive name, case-insensitively', () => {
    const out = m.adaptForFrame([['content-security-policy', "Frame-Ancestors 'none'; x-frame-ancestors-lookalike a"]])
    assert.deepEqual(out, [
      ['content-security-policy', 'x-frame-ancestors-lookalike a'],
      ['content-security-policy', "frame-ancestors 'self'"],
    ])
  })

  test('with no framing headers at all the response still gets the same-site policy', () => {
    assert.deepEqual(m.adaptForFrame([]), [['content-security-policy', "frame-ancestors 'self'"]])
  })
})

describe('frame shell URLs', () => {
  const loc = (pathname, search = '', hash = '') => ({ pathname, search, hash })

  test('the iframe loads the same path, query and hash as the shell', () => {
    assert.equal(m.initialFrameUrl(loc('/forum/1-welcome', '?page=2', '#x'), '/'), '/forum/1-welcome?page=2#x')
    assert.equal(m.initialFrameUrl(loc('/'), '/'), '/')
  })

  test("a request for the shell's own files means the site root, or the shell would frame itself", () => {
    for (const f of ['index.html', '404.html', 'tor-shell.html']) {
      assert.equal(m.initialFrameUrl(loc('/' + f, '?a=1'), '/'), '/?a=1', f)
      assert.equal(m.initialFrameUrl(loc('/repo/' + f), '/repo/'), '/repo/', f)
    }
    assert.equal(m.initialFrameUrl(loc('/repo/sub/index.html'), '/repo/'), '/repo/sub/index.html', 'only the scope root files')
  })

  test('project-page scope: deep links stay under the prefix', () => {
    assert.equal(m.initialFrameUrl(loc('/repo/topic/3-x'), '/repo'), '/repo/topic/3-x')
  })

  test("the address bar follows the iframe, but only within the site", () => {
    assert.equal(m.mirrorLocation('http://localhost:5180/topic/3?x=1#c', 'http://localhost:5180'), '/topic/3?x=1#c')
    assert.equal(m.mirrorLocation('https://elsewhere.example/x', 'http://localhost:5180'), null)
    assert.equal(m.mirrorLocation('about:blank', 'http://localhost:5180'), null)
    assert.equal(m.mirrorLocation('not a url', 'http://localhost:5180'), null)
  })

  test('links that leave the site, or ask for the top level, leave the iframe', () => {
    const o = 'http://localhost:5180'
    assert.equal(m.leavesFrame('/topic/3', null, o), false)
    assert.equal(m.leavesFrame('http://localhost:5180/topic/3', '_self', o), false)
    assert.equal(m.leavesFrame('https://elsewhere.example/', null, o), true)
    assert.equal(m.leavesFrame('/topic/3', '_top', o), true)
    assert.equal(m.leavesFrame('https://elsewhere.example/', '_blank', o), false, 'a new window needs no help')
    assert.equal(m.leavesFrame('http://[bad', null, o), false)
  })
})
