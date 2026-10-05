// Unit tests for hosting being an optional build (see .agent/host-pow-and-optional-host-execplan.md):
// the default build of the WASM has no onion service code and says so clearly; the host build has it
// and TorClient forwards listen() options to it.
//
// The same TypeScript is bundled twice, once against the default build's glue (no `onionAddressFor`)
// and once against the host build's, by aliasing `#wasm` to a different stub.
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { bundleTs, root } from './bundle.mjs'

let def, host, hostStub

before(async () => {
  def = await bundleTs('test/unit/fixtures/clientEntry.ts', 'host-guard-default', {
    alias: { '#wasm': resolve(root, 'test/unit/fixtures/wasmStub.mjs') },
  })
  host = await bundleTs('test/unit/fixtures/clientEntry.ts', 'host-guard-host', {
    alias: { '#wasm': resolve(root, 'test/unit/fixtures/wasmHostStub.mjs') },
  })
  // each bundle carries its own stub, and the one that loaded last is the one on globalThis
  hostStub = globalThis.__wasmStub
  host.setWasmSourceProvider(async () => new Uint8Array())
})

const opts = (m) => ({ storage: new m.MemoryStorage(), socketProvider: { name: 'fake', gatewayFetch: async () => ({ status: 200, statusText: 'OK', body: new Uint8Array() }), close() {} } })

describe('the default build (no hosting)', () => {
  test('hostingAvailable() is false', () => {
    assert.equal(def.hostingAvailable(), false)
  })

  test('listen() fails at once and names the import that has hosting', async () => {
    const client = new def.TorClient(opts(def))
    await assert.rejects(client.listen(), (e) => {
      assert.equal(e.name, 'HostingUnavailableError')
      assert.match(e.message, /tor-js\/host/)
      assert.match(e.message, /not part of this build/)
      return true
    })
    client.close()
  })

  test('serve() fails the same way, and does not wait for the client', async () => {
    const client = new def.TorClient(opts(def))
    await assert.rejects(client.serve(() => new Response('x')), /tor-js\/host/)
    client.close()
  })

  test('TorClient.onionAddress() fails the same way', async () => {
    await assert.rejects(def.TorClient.onionAddress(new Uint8Array(32)), /tor-js\/host/)
  })

  test('generateIdentity() still works: it needs no WASM', () => {
    const id = def.TorClient.generateIdentity()
    assert.equal(id.length, 32)
    assert.notDeepEqual(Array.from(id), Array.from(def.TorClient.generateIdentity()))
  })

  test('the error class is exported so callers can test for it', () => {
    assert.equal(typeof def.HostingUnavailableError, 'function')
  })
})

describe('the host build', () => {
  test('hostingAvailable() is true', () => {
    assert.equal(host.hostingAvailable(), true)
  })

  test('TorClient.onionAddress() asks the WASM', async () => {
    const address = await host.TorClient.onionAddress(new Uint8Array(32))
    assert.equal(address, 'h'.repeat(56) + '.onion')
  })

  /** A fake of the WASM's OnionListener. */
  function rawListener(log) {
    return {
      onion: 'abc.onion',
      powStats: () => ({ enabled: true, verified: 0, rejected: 0, enqueued: 0, dropped: 0, queueLength: 0, suggestedEffort: 0, maxEffortSeen: 0 }),
      accept: async () => null,
      close: () => log.push('close'),
      free: () => log.push('free'),
    }
  }

  test('listen() forwards identity, ports, limits and the proof-of-work option to the WASM', async () => {
    const client = new host.TorClient(opts(host))
    await client.ready()
    const seen = []
    const log = []
    hostStub.clients.at(-1).listen = async (o) => { seen.push(o); return rawListener(log) }

    const identity = new Uint8Array(32).fill(5)
    const listener = await client.listen({ identity, ports: [80, 8080], maxConnections: 3, proofOfWork: { queueDepth: 10 } })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].identity, identity)
    assert.deepEqual(seen[0].ports, [80, 8080])
    assert.equal(seen[0].maxConnections, 3)
    assert.deepEqual(seen[0].proofOfWork, { queueDepth: 10 })
    assert.equal(listener.onion, 'abc.onion')
    assert.equal(listener.pow.enabled, true)
    listener.close()
    client.close()
    assert.deepEqual(log, ['close', 'free'])
  })

  test('listen() without options makes an identity and leaves proofOfWork unset (the WASM default is on)', async () => {
    const client = new host.TorClient(opts(host))
    await client.ready()
    const seen = []
    hostStub.clients.at(-1).listen = async (o) => { seen.push(o); return rawListener([]) }
    const listener = await client.listen()
    assert.equal(seen[0].identity.length, 32)
    assert.equal(listener.identity, seen[0].identity)
    assert.equal(seen[0].proofOfWork, undefined)
    listener.close()
    client.close()
  })

  test('closing the client closes the services it hosts', async () => {
    const client = new host.TorClient(opts(host))
    await client.ready()
    const log = []
    hostStub.clients.at(-1).listen = async () => rawListener(log)
    await client.listen()
    client.close()
    assert.deepEqual(log, ['close', 'free'])
  })
})
