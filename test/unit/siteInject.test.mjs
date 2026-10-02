// Unit tests for inserting the adapter's page script into HTML responses
// (src/site/inject.ts).
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-inject')
})

const enc = new TextEncoder()
const dec = new TextDecoder()
const TAG = '<script src="/tor-site.js"></script>'

/** Run `html` through the injector, delivered as chunks of `size` bytes. */
async function inject(html, size = Infinity) {
  const bytes = typeof html === 'string' ? enc.encode(html) : html
  const ts = m.injectIntoHtml(TAG)
  const out = []
  const reader = ts.readable.getReader()
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      out.push(value)
    }
  })()
  const writer = ts.writable.getWriter()
  for (let i = 0; i < bytes.length; i += Math.min(size, bytes.length)) {
    await writer.write(bytes.slice(i, i + size))
  }
  await writer.close()
  await reading
  return dec.decode(await new Blob(out).arrayBuffer())
}

describe('HTML injection', () => {
  test('goes right after <head>, after the doctype', async () => {
    const out = await inject('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>')
    assert.equal(out, `<!doctype html>\n<html lang="en"><head>${TAG}<meta charset="utf-8"><title>t</title></head><body>x</body></html>`)
  })

  test('a <head> with attributes works, and <header> is not mistaken for it', async () => {
    assert.match(await inject('<html><head profile="x" ><title>t</title>'), /<head profile="x" >\<script/)
    const out = await inject('<html><body><header>nav</header></body></html>')
    assert.equal(out, `<html>${TAG}<body><header>nav</header></body></html>`)
  })

  test('without <head>: after <html>; without both: before <body>', async () => {
    assert.equal(await inject('<html lang="en"><p>x</p></html>'), `<html lang="en">${TAG}<p>x</p></html>`)
    assert.equal(await inject('<!doctype html><body class="a">x</body>'), `<!doctype html>${TAG}<body class="a">x</body>`)
  })

  test('the result is the same however the document is chunked', async () => {
    const doc = '<!DOCTYPE html><HTML><HEAD><title>té中</title></HEAD><BODY>bé中</BODY></HTML>'
    const whole = await inject(doc)
    for (const size of [1, 2, 3, 7, 16]) assert.equal(await inject(doc, size), whole, `chunk size ${size}`)
    assert.equal(whole, doc.replace('<HEAD>', `<HEAD>${TAG}`), 'case-insensitive, UTF-8 intact')
  })

  test('a tag split across chunks is still found', async () => {
    const out = await inject('<html><he' + 'ad><title>x</title>', 11)
    assert.equal(out, `<html><head>${TAG}<title>x</title>`)
  })

  test('only the first place is used', async () => {
    const out = await inject('<html><head></head><body><head>again</head></body></html>')
    assert.equal(out.split(TAG).length - 1, 1)
  })

  test('content after the insertion point streams through without waiting for the end', async () => {
    const ts = m.injectIntoHtml(TAG)
    const writer = ts.writable.getWriter()
    const reader = ts.readable.getReader()
    void writer.write(enc.encode('<html><head>'))
    let seen = ''
    while (!seen.includes(TAG)) seen += dec.decode((await reader.read()).value)
    void writer.write(enc.encode('later chunk'))
    while (!seen.includes('later chunk')) seen += dec.decode((await reader.read()).value)
    assert.equal(seen, `<html><head>${TAG}later chunk`, 'delivered before the stream was closed')
    await writer.close()
  })

  test('a document that ends before any head or body still gets the tag after <html>', async () => {
    assert.equal(await inject('<html lang="x"></html>'), `<html lang="x">${TAG}</html>`)
  })

  test('a document with no place for the tag within 16 KB passes through unchanged', async () => {
    const doc = '<p>' + 'x'.repeat(20_000) + '</p>'
    assert.equal(await inject(doc, 1000), doc)
  })

  test('short non-HTML-looking bodies pass through unchanged', async () => {
    assert.equal(await inject('plain text, no tags'), 'plain text, no tags')
    assert.equal(await inject(''), '')
  })

  test('binary-safe: a multibyte character split across chunks survives', async () => {
    const doc = enc.encode('<html><head></head><body>é中😀</body></html>')
    const out = await inject(doc, 5)
    assert.equal(out, `<html><head>${TAG}</head><body>é中😀</body></html>`)
  })
})

describe('when to inject', () => {
  test('only HTML documents, and only in charsets where an ASCII tag is safe', () => {
    assert.equal(m.shouldInject('document', 'text/html; charset=utf-8'), true)
    assert.equal(m.shouldInject('document', 'text/html'), true)
    assert.equal(m.shouldInject('document', 'TEXT/HTML;charset="UTF-8"'), true)
    assert.equal(m.shouldInject('document', 'text/html; charset=utf-16'), false)
    assert.equal(m.shouldInject('document', 'text/html; charset=shift_jis'), false)
    assert.equal(m.shouldInject('document', 'application/json'), false)
    assert.equal(m.shouldInject('document', 'text/htmlx'), false)
    assert.equal(m.shouldInject('document', undefined), false)
    assert.equal(m.shouldInject('script', 'text/html'), false, 'subresources and fetch() calls are left alone')
    assert.equal(m.shouldInject('', 'text/html'), false)
    assert.equal(m.shouldInject('iframe', 'text/html'), false)
  })

  test('iframe documents are injected only where the shell shows the site in an iframe', () => {
    assert.equal(m.shouldInject('iframe', 'text/html', true), true)
    assert.equal(m.shouldInject('iframe', 'text/html', false), false)
    assert.equal(m.shouldInject('iframe', 'application/json', true), false)
    assert.equal(m.shouldInject('script', 'text/html', true), false)
  })

  test('the frame role is marked on the tag, and only then', () => {
    const urls = { script: '/s.js', sw: '/sw.js', manifest: '/m.json' }
    assert.match(m.pageScriptTag(urls, 'frame'), / data-role="frame"><\/script>$/)
    assert.doesNotMatch(m.pageScriptTag(urls), /data-role/)
  })

  test('the tag escapes its attribute values', () => {
    const tag = m.pageScriptTag({ script: '/a b/tor-site.js', sw: '/sw.js?manifest=%2Ftor-site.json&x="1"', manifest: '/m.json' })
    assert.match(tag, /data-sw="\/sw\.js\?manifest=%2Ftor-site\.json&amp;x=&quot;1&quot;"/)
    assert.match(tag, /data-prewarm="false"/)
    assert.ok(tag.startsWith('<script ') && tag.endsWith('></script>'))
  })
})
