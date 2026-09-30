// Unit tests for the Service Worker <-> Tor host port protocol (src/site/rpc.ts),
// over a real MessageChannel.
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-rpc')
})

const enc = new TextEncoder()
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

function streamOf(chunks) {
  let i = 0
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]))
      else c.close()
    },
  })
}

/** A backend double plus both ends of a connected pair. */
function pair(handle, extra = {}) {
  const ch = new MessageChannel()
  const backend = { handle, warm: async () => { extra.warmed = true } }
  const server = m.serveBackend(ch.port1, backend)
  const hooks = { statuses: [], logs: [] }
  const client = new m.PortBackend(ch.port2, {
    onStatus: (s) => hooks.statuses.push(s),
    onLog: (l, msg) => hooks.logs.push([l, msg]),
  })
  return { server, client, hooks, close() { ch.port1.close(); ch.port2.close() } }
}

const text = async (r) => (r.body ? await new Response(r.body).text() : '')
const get = (url) => ({ url, method: 'GET', headers: [], body: null })

describe('site rpc', () => {
  test('a response streams back in order with status and headers', async () => {
    const { client, close } = pair(async () => ({
      status: 201, statusText: 'Created', headers: [['x-a', '1'], ['set-thing', 'a'], ['set-thing', 'b']],
      body: streamOf(['one ', 'two ', 'three']),
    }))
    const res = await client.handle(get('https://s/x'))
    assert.equal(res.status, 201)
    assert.equal(res.statusText, 'Created')
    assert.deepEqual(res.headers, [['x-a', '1'], ['set-thing', 'a'], ['set-thing', 'b']])
    assert.equal(await text(res), 'one two three')
    close()
  })

  test('request fields and body reach the backend intact', async () => {
    let got
    const { client, close } = pair(async (req) => {
      got = req
      return { status: 204, statusText: '', headers: [], body: null }
    })
    const body = enc.encode('payload ✓')
    const res = await client.handle({
      url: 'https://s/api', method: 'POST', headers: [['content-type', 'text/plain']], body, redirect: 'manual',
    })
    assert.equal(res.status, 204)
    assert.equal(res.body, null)
    assert.equal(got.url, 'https://s/api')
    assert.equal(got.method, 'POST')
    assert.deepEqual(got.headers, [['content-type', 'text/plain']])
    assert.equal(new TextDecoder().decode(got.body), 'payload ✓')
    assert.equal(got.redirect, 'manual')
    close()
  })

  test('concurrent requests do not mix', async () => {
    const { client, close } = pair(async (req) => {
      if (req.url.endsWith('slow')) await tick(30)
      return { status: 200, statusText: '', headers: [], body: streamOf([req.url]) }
    })
    const [a, b] = await Promise.all([client.handle(get('https://s/slow')), client.handle(get('https://s/fast'))])
    assert.deepEqual([await text(a), await text(b)], ['https://s/slow', 'https://s/fast'])
    close()
  })

  test('a backend exception rejects the request with its message', async () => {
    const { client, close } = pair(async () => { throw new Error('circuit failed') })
    await assert.rejects(client.handle(get('https://s/x')), /circuit failed/)
    close()
  })

  test('an error after the head errors the body stream', async () => {
    let sent = false
    const body = new ReadableStream({
      pull(c) {
        if (!sent) { sent = true; c.enqueue(enc.encode('partial')); return }
        throw new Error('connection reset')
      },
    })
    const { client, close } = pair(async () => ({ status: 200, statusText: '', headers: [], body }))
    const res = await client.handle(get('https://s/x'))
    await assert.rejects(text(res), /connection reset/)
    close()
  })

  test('cancelling the response body cancels the upstream stream', async () => {
    let upstreamCancelled = false
    let aborted = false
    const { client, close } = pair(async (req) => {
      req.signal.addEventListener('abort', () => { aborted = true })
      return {
        status: 200, statusText: '', headers: [],
        body: new ReadableStream({
          pull(c) { return tick(5).then(() => c.enqueue(enc.encode('x'.repeat(100)))) },
          cancel() { upstreamCancelled = true },
        }),
      }
    })
    const res = await client.handle(get('https://s/x'))
    const reader = res.body.getReader()
    await reader.read()
    await reader.cancel()
    await tick(80)
    assert.ok(aborted, 'the backend request was aborted')
    assert.ok(upstreamCancelled, 'the upstream body was cancelled')
    close()
  })

  test('aborting the request signal aborts it at the host and rejects the caller', async () => {
    let hostSignal
    const { client, close } = pair(async (req) => {
      hostSignal = req.signal
      await new Promise((r) => req.signal.addEventListener('abort', r))
      throw new Error('aborted upstream')
    })
    const ac = new AbortController()
    const p = client.handle({ ...get('https://s/x'), signal: ac.signal })
    await tick(20)
    ac.abort()
    await assert.rejects(p, (e) => e.name === 'AbortError')
    await tick(20)
    assert.ok(hostSignal.aborted)
    close()
  })

  test('large bodies survive chunking', async () => {
    const big = 'abcdefghij'.repeat(50_000)
    const { client, close } = pair(async () => ({
      status: 200, statusText: '', headers: [],
      body: streamOf([big.slice(0, 200_000), big.slice(200_000)]),
    }))
    const res = await client.handle(get('https://s/x'))
    assert.equal(await text(res), big)
    close()
  })

  test('a subarray chunk sends only its own bytes', async () => {
    const backing = enc.encode('XXhelloYY')
    const body = new ReadableStream({ start(c) { c.enqueue(backing.subarray(2, 7)); c.close() } })
    const { client, close } = pair(async () => ({ status: 200, statusText: '', headers: [], body }))
    const res = await client.handle(get('https://s/x'))
    assert.equal(await text(res), 'hello')
    close()
  })

  test('ping answers while the host lives and times out when it does not', async () => {
    const live = pair(async () => ({ status: 200, statusText: '', headers: [], body: null }))
    assert.equal(await live.client.ping(500), true)
    live.close()
    // A port whose other end was never served: a host whose page has closed.
    const ch = new MessageChannel()
    const orphan = new m.PortBackend(ch.port2)
    assert.equal(await orphan.ping(80), false)
    ch.port1.close()
    ch.port2.close()
  })

  test('warm reaches the backend and resolves', async () => {
    const extra = {}
    const { client, close } = pair(async () => ({ status: 200, statusText: '', headers: [], body: null }), extra)
    await client.warm()
    assert.equal(extra.warmed, true)
    close()
  })

  test('status and log pushes arrive at the hooks', async () => {
    const { server, hooks, close } = pair(async () => ({ status: 200, statusText: '', headers: [], body: null }))
    server.push({ t: 'status', status: { state: 'ready', where: 'host' } })
    server.push({ t: 'log', level: 'info', message: 'hello' })
    await tick(20)
    assert.deepEqual(hooks.statuses, [{ state: 'ready', where: 'host' }])
    assert.deepEqual(hooks.logs, [['info', 'hello']])
    close()
  })

  test('closing rejects requests still waiting', async () => {
    const ch = new MessageChannel()
    const client = new m.PortBackend(ch.port2)
    const p = client.handle(get('https://s/x'))
    client.close()
    await assert.rejects(p, /went away/)
    ch.port1.close()
  })
})
