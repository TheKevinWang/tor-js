// Unit tests for the HTTP/1.1 server over onion-service connections (src/host/http.ts).
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('src/host/http.ts', 'serve')
})

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (x) => (typeof x === 'string' ? enc.encode(x) : x)

/** A connection that delivers `inbound` chunks, then ends (or hangs), and records what is written. */
function fakeConn(inbound, { hang = false, failWritesAfter = Infinity } = {}) {
  const out = []
  let i = 0
  let closed = false
  let writes = 0
  return {
    out,
    get closed() { return closed },
    async read() {
      if (i < inbound.length) return bytes(inbound[i++])
      if (hang) return new Promise(() => {})
      return null
    },
    async write(chunk) {
      if (writes++ >= failWritesAfter) throw new Error('visitor gone')
      out.push(chunk)
    },
    close() { closed = true },
  }
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.length }
  return all
}

/** Split what was written into status, headers (lowercased names) and the decoded body. */
function parseResponse(conn) {
  const all = concat(conn.out)
  const text = dec.decode(all)
  const split = text.indexOf('\r\n\r\n')
  assert.ok(split >= 0, 'no header terminator in: ' + JSON.stringify(text.slice(0, 200)))
  const [statusLine, ...lines] = text.slice(0, split).split('\r\n')
  const sl = statusLine.match(/^HTTP\/1\.[01] (\d{3}) ?(.*)$/)
  assert.ok(sl, 'bad status line: ' + statusLine)
  const status = sl[1]
  const reason = [sl[2]]
  const headers = {}
  for (const l of lines) { const c = l.indexOf(':'); headers[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim() }
  let rest = all.subarray(enc.encode(text.slice(0, split + 4)).length)
  let body
  if (headers['transfer-encoding'] === 'chunked') {
    const parts = []
    let s = dec.decode(rest)
    for (;;) {
      const eol = s.indexOf('\r\n')
      const size = parseInt(s.slice(0, eol), 16)
      if (size === 0) { assert.equal(s.slice(eol), '\r\n\r\n', 'chunked body must end with 0 CRLF CRLF'); break }
      parts.push(s.slice(eol + 2, eol + 2 + size))
      assert.equal(s.slice(eol + 2 + size, eol + 4 + size), '\r\n')
      s = s.slice(eol + 4 + size)
    }
    body = parts.join('')
  } else {
    body = dec.decode(rest)
  }
  return { status: Number(status), reason: reason[0], headers, body, raw: text }
}

async function run(inbound, handler, limits, opts) {
  const conn = fakeConn(Array.isArray(inbound) ? inbound : [inbound], opts)
  await m.handleConnection(conn, handler, limits, 'abc.onion')
  return { conn, res: conn.out.length ? parseResponse(conn) : null }
}

const ok = (text = 'hi', init) => () => new Response(text, init)

describe('requests', () => {
  test('a GET reaches the handler with method, URL, query and headers, and the answer comes back', async () => {
    let seen
    const { conn, res } = await run('GET /a/b?x=1&y=2 HTTP/1.1\r\nHost: abc.onion\r\nX-Thing: yes\r\n\r\n', (req) => {
      seen = { method: req.method, url: req.url, thing: req.headers.get('x-thing') }
      return new Response('hello', { headers: { 'content-type': 'text/plain' } })
    })
    assert.deepEqual(seen, { method: 'GET', url: 'http://abc.onion/a/b?x=1&y=2', thing: 'yes' })
    assert.equal(res.status, 200)
    assert.equal(res.reason, 'OK')
    assert.equal(res.body, 'hello')
    assert.equal(res.headers['content-length'], '5')
    assert.equal(res.headers.connection, 'close')
    assert.equal(res.headers['content-type'], 'text/plain')
    assert.equal(conn.closed, true)
  })

  test('without a Host header the URL uses the onion address', async () => {
    let url
    await run('GET /p HTTP/1.1\r\n\r\n', (req) => { url = req.url; return new Response('') })
    assert.equal(url, 'http://abc.onion/p')
  })

  test('a request delivered one byte at a time parses the same', async () => {
    const raw = 'POST /echo HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\nabcd'
    let got
    const { res } = await run([...raw].map((c) => c), async (req) => { got = await req.text(); return new Response('ok') })
    assert.equal(got, 'abcd')
    assert.equal(res.status, 200)
  })

  test('a POST with Content-Length gives the handler its body', async () => {
    let got
    const { res } = await run('POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 11\r\n\r\nhello world', async (req) => {
      got = [req.method, await req.text()]
      return new Response('done', { status: 201 })
    })
    assert.deepEqual(got, ['POST', 'hello world'])
    assert.equal(res.status, 201)
    assert.equal(res.reason, 'Created')
  })

  test('a chunked POST (with a chunk extension and a trailer) is decoded', async () => {
    let got
    const raw = 'POST /x HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: t\r\n\r\n'
    const { res } = await run([raw.slice(0, 50), raw.slice(50)], async (req) => { got = await req.text(); return new Response('k') })
    assert.equal(got, 'hello world')
    assert.equal(res.status, 200)
  })

  test('Expect: 100-continue is answered before the body is read', async () => {
    const conn = fakeConn(['POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n', 'ok'])
    await m.handleConnection(conn, ok('fine'), {}, 'abc.onion')
    assert.equal(dec.decode(conn.out[0]), 'HTTP/1.1 100 Continue\r\n\r\n')
    assert.match(dec.decode(concat(conn.out)), /HTTP\/1\.1 200 OK/)
  })
})

describe('responses', () => {
  test('a HEAD request gets the headers and the declared length but no body', async () => {
    const { res } = await run('HEAD /x HTTP/1.1\r\nHost: h\r\n\r\n', () => new Response('twelve bytes', { headers: { 'content-length': '12' } }))
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-length'], '12')
    assert.equal(res.body, '')
  })

  test('204 and 304 carry no body and no length', async () => {
    for (const status of [204, 304]) {
      const { res } = await run('GET /x HTTP/1.1\r\n\r\n', () => new Response(null, { status }))
      assert.equal(res.status, status)
      assert.equal(res.headers['content-length'], undefined)
      assert.equal(res.headers['transfer-encoding'], undefined)
      assert.equal(res.body, '')
    }
  })

  test('a small body without a declared length is sent with an exact Content-Length, even when streamed', async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(enc.encode('one,')); c.enqueue(new Uint8Array(0)); c.enqueue(enc.encode('two')); c.close() },
    })
    const { res } = await run('GET /x HTTP/1.1\r\n\r\n', () => new Response(stream))
    assert.equal(res.headers['content-length'], '7')
    assert.equal(res.headers['transfer-encoding'], undefined)
    assert.equal(res.body, 'one,two')
  })

  test('a large streamed body is sent chunked, in order, skipping empty chunks', async () => {
    const piece = (c) => enc.encode(String.fromCharCode(97 + c).repeat(40_000))
    const stream = new ReadableStream({
      start(c) { c.enqueue(piece(0)); c.enqueue(new Uint8Array(0)); c.enqueue(piece(1)); c.enqueue(piece(2)); c.close() },
    })
    const { res } = await run('GET /x HTTP/1.1\r\n\r\n', () => new Response(stream))
    assert.equal(res.headers['transfer-encoding'], 'chunked')
    assert.equal(res.headers['content-length'], undefined)
    assert.equal(res.body, 'a'.repeat(40_000) + 'b'.repeat(40_000) + 'c'.repeat(40_000))
  })

  test('hop-by-hop headers from the handler are not forwarded, and the length is recomputed', async () => {
    const { res } = await run('GET /x HTTP/1.1\r\n\r\n', () => new Response('abc', { headers: { connection: 'keep-alive', 'keep-alive': 'timeout=5', 'x-ok': '1' } }))
    assert.equal(res.headers.connection, 'close')
    assert.equal(res.headers['keep-alive'], undefined)
    assert.equal(res.headers['x-ok'], '1')
  })

  test('HTTP/1.0 gets an HTTP/1.0 answer with a length, never chunked', async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode('ab')); c.enqueue(enc.encode('cd')); c.close() } })
    const { res } = await run('GET /x HTTP/1.0\r\n\r\n', () => new Response(stream))
    assert.match(res.raw, /^HTTP\/1\.0 200 OK/)
    assert.equal(res.headers['content-length'], '4')
    assert.equal(res.headers['transfer-encoding'], undefined)
    assert.equal(res.body, 'abcd')
  })

  test('a handler-declared Content-Length that the body does not match closes the connection without a second status', async () => {
    const { conn } = await run('GET /x HTTP/1.1\r\n\r\n', () => new Response('abcdef', { headers: { 'content-length': '3' } }))
    const text = dec.decode(concat(conn.out))
    assert.equal((text.match(/HTTP\/1\.1/g) ?? []).length, 1, 'exactly one status line')
    assert.equal(conn.closed, true)
  })

  test('a visitor that disconnects mid-response does not get an error status written into the stream', async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode('x')); c.enqueue(enc.encode('y')); c.close() } })
    const conn = fakeConn(['GET /x HTTP/1.1\r\n\r\n'], { failWritesAfter: 1 })
    await m.handleConnection(conn, () => new Response(stream), {}, 'abc.onion')
    assert.equal(conn.out.length, 1)
    assert.equal(conn.closed, true)
  })
})

describe('errors', () => {
  test('a throwing handler gets a 500 that does not leak the error', async () => {
    const { res } = await run('GET /x HTTP/1.1\r\n\r\n', () => { throw new Error('secret db password') })
    assert.equal(res.status, 500)
    assert.doesNotMatch(res.raw, /secret/)
  })

  test('a handler that rejects, or returns something else, also gets a 500', async () => {
    assert.equal((await run('GET /x HTTP/1.1\r\n\r\n', async () => { throw new Error('x') })).res.status, 500)
    assert.equal((await run('GET /x HTTP/1.1\r\n\r\n', () => 'not a response')).res.status, 500)
  })

  test('a head over the limit gets 431 and a body over the limit gets 413 before it is read', async () => {
    const big = 'GET /x HTTP/1.1\r\nX-Pad: ' + 'a'.repeat(200) + '\r\n\r\n'
    assert.equal((await run(big, ok(), { maxHeadBytes: 100 })).res.status, 431)
    const declared = 'POST /x HTTP/1.1\r\nContent-Length: 5000\r\n\r\n' // no body bytes follow
    assert.equal((await run(declared, ok(), { maxBodyBytes: 1000 })).res.status, 413)
  })

  test('a chunked body over the limit gets 413', async () => {
    const raw = 'POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n' + 'a\r\n0123456789\r\n'.repeat(5) + '0\r\n\r\n'
    assert.equal((await run(raw, ok(), { maxBodyBytes: 30 })).res.status, 413)
  })

  const refused = [
    ['a bad request line', 'GARBAGE\r\n\r\n', 400],
    ['an unsupported HTTP version', 'GET /x HTTP/2.0\r\n\r\n', 505],
    ['an absolute-form target', 'GET http://evil/x HTTP/1.1\r\n\r\n', 400],
    ['both Content-Length and Transfer-Encoding', 'POST /x HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n', 400],
    ['a Transfer-Encoding other than chunked', 'POST /x HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n', 501],
    ['a body on a GET', 'GET /x HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi', 400],
    ['obsolete header folding', 'GET /x HTTP/1.1\r\nX-A: 1\r\n folded\r\n\r\n', 400],
    ['a non-numeric Content-Length', 'POST /x HTTP/1.1\r\nContent-Length: 1e3\r\n\r\n', 400],
    ['two Content-Length values', 'POST /x HTTP/1.1\r\nContent-Length: 5, 5\r\n\r\nhello', 400],
    ['a header name with a space', 'GET /x HTTP/1.1\r\nBad Name: 1\r\n\r\n', 400],
    ['a bad chunk size', 'POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n', 400],
  ]
  for (const [name, raw, status] of refused) {
    test(`${name} is refused with ${status} and the handler is not called`, async () => {
      let called = false
      const { res, conn } = await run(raw, () => { called = true; return new Response('') })
      assert.equal(res.status, status)
      assert.equal(called, false)
      assert.equal(conn.closed, true)
    })
  }

  test('a visitor that sends nothing is answered 408 after the head timeout, and the connection is closed', async () => {
    const { res, conn } = await run([], ok(), { headTimeoutMs: 30 }, { hang: true })
    assert.equal(res.status, 408)
    assert.equal(conn.closed, true)
  })

  test('a visitor that stops mid-body is answered 408 after the body timeout', async () => {
    const { res } = await run('POST /x HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc', ok(), { bodyTimeoutMs: 30 }, { hang: true })
    assert.equal(res.status, 408)
  })

  test('a visitor that closes mid-body gets the connection closed, no crash', async () => {
    const { conn } = await run('POST /x HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc', ok())
    assert.equal(conn.closed, true)
  })
})

describe('serve()', () => {
  test('answers every visitor, then resolves when the listener closes', async () => {
    const conns = [fakeConn(['GET /1 HTTP/1.1\r\n\r\n']), fakeConn(['GET /2 HTTP/1.1\r\n\r\n'])]
    const listener = { onion: 'abc.onion', accept: async () => conns.shift() ?? null }
    const paths = []
    const all = [...conns]
    await m.serve(listener, (req) => { paths.push(new URL(req.url).pathname); return new Response(new URL(req.url).pathname) })
    await new Promise((r) => setTimeout(r, 20)) // handlers run in the background
    assert.deepEqual(paths.sort(), ['/1', '/2'])
    assert.deepEqual(all.map((c) => parseResponse(c).body).sort(), ['/1', '/2'])
  })
})
