// Unit tests for the wrappers that turn the WASM's listener and connection into the public API
// (src/host/wrap.ts), with plain fake objects standing in for the WASM.
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('src/host/wrap.ts', 'host-wrap')
})

function rawConn(chunks = []) {
  const log = []
  return {
    log,
    async read() { log.push('read'); return chunks.length ? chunks.shift() : null },
    async write(d) { log.push(['write', Array.from(d)]) },
    async close() { log.push('close') },
    free() { log.push('free') },
  }
}

function rawListener(conns = []) {
  const log = []
  let verified = 0
  return {
    log,
    onion: 'abc.onion',
    bump() { verified++ },
    powStats() {
      log.push('powStats')
      return { enabled: true, verified, rejected: 0, enqueued: verified, dropped: 0, queueLength: 0, suggestedEffort: 0, maxEffortSeen: 0 }
    },
    async accept() { log.push('accept'); return conns.length ? conns.shift() : null },
    close() { log.push('close') },
    free() { log.push('free') },
  }
}

describe('connection', () => {
  test('read and write pass through', async () => {
    const raw = rawConn([new Uint8Array([1, 2])])
    const c = m.wrapConnection(raw)
    assert.deepEqual(Array.from(await c.read()), [1, 2])
    assert.equal(await c.read(), null)
    await c.write(new Uint8Array([9]))
    assert.deepEqual(raw.log, ['read', 'read', ['write', [9]]])
  })

  test('close finishes sending and then frees, once', async () => {
    const raw = rawConn()
    const c = m.wrapConnection(raw)
    await c.close()
    await c.close()
    assert.deepEqual(raw.log, ['close', 'free'])
  })

  test('the connection is freed even if finishing the send fails', async () => {
    const raw = rawConn()
    raw.close = async () => { raw.log.push('close'); throw new Error('stream reset') }
    const c = m.wrapConnection(raw)
    await assert.rejects(c.close(), /stream reset/)
    assert.deepEqual(raw.log, ['close', 'free'])
  })

  test('after close, reads end and writes fail without touching the freed object', async () => {
    const raw = rawConn([new Uint8Array([1])])
    const c = m.wrapConnection(raw)
    await c.close()
    raw.log.length = 0
    assert.equal(await c.read(), null)
    await assert.rejects(c.write(new Uint8Array([1])), /closed/)
    assert.deepEqual(raw.log, [])
  })
})

describe('listener', () => {
  test('exposes the address and the identity it was started with', () => {
    const id = new Uint8Array(32).fill(7)
    const l = m.wrapListener(rawListener(), id)
    assert.equal(l.onion, 'abc.onion')
    assert.equal(l.identity, id)
  })

  test('accept wraps each connection and ends with null', async () => {
    const l = m.wrapListener(rawListener([rawConn(), rawConn()]), new Uint8Array(32))
    const a = await l.accept()
    const b = await l.accept()
    assert.ok(a && b && a !== b)
    assert.equal(typeof a.read, 'function')
    assert.equal(await l.accept(), null)
  })

  test('can be consumed with for await, which ends when the listener does', async () => {
    const l = m.wrapListener(rawListener([rawConn(), rawConn(), rawConn()]), new Uint8Array(32))
    let n = 0
    for await (const c of l) { assert.equal(typeof c.write, 'function'); n++ }
    assert.equal(n, 3)
  })

  test('close stops the service, frees it, tells the owner, and is idempotent', async () => {
    const raw = rawListener()
    const closed = []
    const l = m.wrapListener(raw, new Uint8Array(32), (x) => closed.push(x))
    l.close()
    l.close()
    assert.deepEqual(raw.log, ['powStats', 'close', 'free'])
    assert.deepEqual(closed, [l])
  })

  test('accept after close answers null without touching the freed object', async () => {
    const raw = rawListener([rawConn()])
    const l = m.wrapListener(raw, new Uint8Array(32))
    l.close()
    raw.log.length = 0
    assert.equal(await l.accept(), null)
    assert.deepEqual(raw.log, [])
  })

  test('pow reads fresh counters from the service each time it is read', () => {
    const raw = rawListener()
    const l = m.wrapListener(raw, new Uint8Array(32))
    assert.equal(l.pow.verified, 0)
    raw.bump()
    raw.bump()
    assert.equal(l.pow.verified, 2)
    assert.equal(l.pow.enabled, true)
  })

  test('pow after close is the reading taken at close, and does not touch the freed object', () => {
    const raw = rawListener()
    const l = m.wrapListener(raw, new Uint8Array(32))
    raw.bump()
    l.close()
    raw.bump() // too late: the service is gone
    raw.log.length = 0
    assert.equal(l.pow.verified, 1)
    assert.deepEqual(raw.log, [])
  })
})
