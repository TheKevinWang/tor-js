// Unit tests for the message handling of the hosting worker (src/host/worker/protocol.ts), with a fake service,
// fake pages and a fake clock. See .agent/worker-hosting-execplan.md.
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('src/host/worker/protocol.ts', 'host-worker-protocol')
})

const pow = (verified = 0) => ({ enabled: true, verified, rejected: 0, enqueued: 0, dropped: 0, queueLength: 0, suggestedEffort: 0, maxEffortSeen: 0 })

/** A manual clock with the timer functions the core takes. */
function fakeClock() {
  let now = 1_000
  let nextHandle = 1
  const timers = new Map() // handle -> { at, fn, every }
  return {
    now: () => now,
    setInterval: (fn, ms) => { const h = nextHandle++; timers.set(h, { at: now + ms, fn, every: ms }); return h },
    clearInterval: (h) => { timers.delete(h) },
    setTimeout: (fn, ms) => { const h = nextHandle++; timers.set(h, { at: now + ms, fn, every: 0 }); return h },
    clearTimeout: (h) => { timers.delete(h) },
    get pending() { return timers.size },
    advance(ms) {
      const end = now + ms
      for (;;) {
        let next = null
        for (const [h, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { h, t }
        if (!next) break
        now = next.t.at
        if (next.t.every) next.t.at += next.t.every
        else timers.delete(next.h)
        next.t.fn()
      }
      now = end
    },
  }
}

/** A service the test controls. */
function fakeService(onion = 'abc.onion') {
  let end
  const done = new Promise((r) => { end = r })
  const service = {
    onion, done, closed: 0, verified: 0,
    get pow() { return pow(service.verified) },
    close() { service.closed++; end() },
  }
  return service
}

function setup(overrides = {}) {
  const clock = fakeClock()
  const started = []
  const services = []
  let failWith = null
  let gate = null // a promise start() waits for
  const core = new m.HostWorkerCore({
    ...clock,
    async start(request) {
      started.push(request)
      if (gate) await gate
      if (failWith) throw failWith
      const s = fakeService()
      services.push(s)
      return s
    },
    ...overrides,
  })
  const page = () => {
    const received = []
    const id = core.attach({ post: (msg) => received.push(msg.status) })
    return { id, received, last: () => received.at(-1) }
  }
  return { core, clock, started, services, page, fail: (e) => { failWith = e }, hold: () => { let open; gate = new Promise((r) => { open = r }); return () => { gate = null; open() } } }
}

const START = { handlerUrl: 'http://x/h.js', identity: new Uint8Array(32), wasmUrl: 'http://x/w.wasm' }
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('starting', () => {
  test('a page attaching is told the worker is idle', () => {
    const { page } = setup()
    const a = page()
    assert.deepEqual(a.last(), { state: 'idle', attached: 1 })
  })

  test('start goes through starting to online and tells the page', async () => {
    const { core, page, started } = setup()
    const a = page()
    core.receive(a.id, { t: 'start', start: START })
    assert.equal(a.last().state, 'starting')
    await settle()
    assert.equal(a.last().state, 'online')
    assert.equal(a.last().onion, 'abc.onion')
    assert.equal(a.last().pow.enabled, true)
    assert.equal(started.length, 1)
    assert.deepEqual(started[0], START)
  })

  test('a failure to start is reported with its message, and a later start tries again', async () => {
    const { core, page, started, fail } = setup()
    const a = page()
    fail(new Error('no handler'))
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    assert.equal(a.last().state, 'error')
    assert.equal(a.last().error, 'no handler')
    fail(null)
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    assert.equal(a.last().state, 'online')
    assert.equal(a.last().error, undefined)
    assert.equal(started.length, 2)
  })

  test('start throwing synchronously is an error too', async () => {
    const { core, page } = setup({ start() { throw new Error('boom') } })
    const a = page()
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    assert.equal(a.last().error, 'boom')
  })
})

describe('sharing', () => {
  test('a second page that starts joins the running service and starts nothing', async () => {
    const { core, page, started } = setup()
    const a = page()
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    const b = page()
    assert.equal(b.last().state, 'online') // told on attaching
    core.receive(b.id, { t: 'start', start: START })
    assert.equal(started.length, 1)
    assert.equal(b.last().state, 'online')
    assert.equal(b.last().attached, 2)
  })

  test('a page that starts while it is still starting joins it', async () => {
    const { core, page, started, hold } = setup()
    const release = hold()
    const a = page()
    core.receive(a.id, { t: 'start', start: START })
    const b = page()
    core.receive(b.id, { t: 'start', start: START })
    assert.equal(b.last().state, 'starting')
    release()
    await settle()
    assert.equal(a.last().state, 'online')
    assert.equal(b.last().state, 'online')
    assert.equal(started.length, 1)
  })

  test('every attached page hears about changes', async () => {
    const { core, page } = setup()
    const a = page()
    const b = page()
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    assert.equal(a.last().state, 'online')
    assert.equal(b.last().state, 'online')
  })
})

describe('lifetime', () => {
  test('the service stays while a page pings, and is stopped keepAliveMs after the last page says goodbye', async () => {
    const { core, clock, page, services } = setup()
    const a = page()
    core.receive(a.id, { t: 'start', start: { ...START, keepAliveMs: 20_000 } })
    await settle()
    core.receive(a.id, { t: 'bye' })
    clock.advance(19_000)
    assert.equal(services[0].closed, 0)
    clock.advance(2_000)
    assert.equal(services[0].closed, 1)
    await settle()
  })

  test('a page that comes back within the grace period finds the same service', async () => {
    const { core, clock, page, services, started } = setup()
    const a = page()
    core.receive(a.id, { t: 'start', start: { ...START, keepAliveMs: 20_000 } })
    await settle()
    core.receive(a.id, { t: 'bye' }) // a reload
    clock.advance(5_000)
    const b = page()
    assert.equal(b.last().state, 'online')
    assert.equal(b.last().onion, 'abc.onion')
    core.receive(b.id, { t: 'start', start: START })
    for (let i = 0; i < 12; i++) { clock.advance(5_000); core.receive(b.id, { t: 'ping' }) }
    assert.equal(services[0].closed, 0, 'the returning page cancelled the countdown')
    assert.equal(started.length, 1)
  })

  test('a page that stops pinging is dropped and the service ends after the grace period', async () => {
    const { core, clock, page, services } = setup({ staleMs: 15_000 })
    const a = page()
    core.receive(a.id, { t: 'start', start: { ...START, keepAliveMs: 10_000 } })
    await settle()
    for (let i = 0; i < 6; i++) { clock.advance(5_000); core.receive(a.id, { t: 'ping' }) }
    assert.equal(services[0].closed, 0, 'pings keep the page attached')
    clock.advance(16_000) // silence: dropped at about 15 s
    assert.equal(services[0].closed, 0, 'still in its grace period')
    clock.advance(11_000)
    assert.equal(services[0].closed, 1)
  })

  test('the service stays while any one page remains', async () => {
    const { core, clock, page, services } = setup()
    const a = page()
    const b = page()
    core.receive(a.id, { t: 'start', start: { ...START, keepAliveMs: 1_000 } })
    await settle()
    core.receive(a.id, { t: 'bye' })
    for (let i = 0; i < 20; i++) { clock.advance(5_000); core.receive(b.id, { t: 'ping' }) }
    assert.equal(services[0].closed, 0)
  })

  test('stop from any page ends the service for all, and everyone hears it', async () => {
    const { core, page, services } = setup()
    const a = page()
    const b = page()
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    core.receive(b.id, { t: 'stop' })
    await settle()
    assert.equal(services[0].closed, 1)
    assert.equal(a.last().state, 'closed')
    assert.equal(b.last().state, 'closed')
  })

  test('stop while it is still starting closes the service as soon as it is up', async () => {
    const { core, page, services, hold } = setup()
    const release = hold()
    const a = page()
    core.receive(a.id, { t: 'start', start: START })
    core.receive(a.id, { t: 'stop' })
    release()
    await settle()
    assert.equal(services[0].closed, 1)
    assert.equal(a.last().state, 'closed')
  })

  test('a service that ends by itself is reported closed, with its last counters', async () => {
    const { core, page, services } = setup()
    const a = page()
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    services[0].verified = 7
    services[0].close()
    await settle()
    assert.equal(a.last().state, 'closed')
    assert.equal(a.last().pow.verified, 7)
  })

  test('after it closed, a start makes a new service', async () => {
    const { core, page, services, started } = setup()
    const a = page()
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    core.receive(a.id, { t: 'stop' })
    await settle()
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    assert.equal(started.length, 2)
    assert.equal(services.length, 2)
    assert.equal(a.last().state, 'online')
  })

  test('no page, no timers: nothing keeps ticking once the service is gone', async () => {
    const { core, clock, page } = setup()
    const a = page()
    core.receive(a.id, { t: 'start', start: { ...START, keepAliveMs: 1_000 } })
    await settle()
    core.receive(a.id, { t: 'bye' })
    clock.advance(2_000)
    await settle()
    assert.equal(clock.pending, 0)
  })
})

describe('status pushes', () => {
  test('fresh counters are pushed every statusMs while online and a page is attached', async () => {
    const { core, clock, page, services } = setup({ statusMs: 3_000 })
    const a = page()
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    const before = a.received.length
    services[0].verified = 3
    clock.advance(3_100)
    assert.ok(a.received.length > before)
    assert.equal(a.last().pow.verified, 3)
  })

  test('messages from a page that was dropped are ignored', async () => {
    const { core, page, services } = setup()
    const a = page()
    core.receive(a.id, { t: 'start', start: START })
    await settle()
    core.receive(a.id, { t: 'bye' })
    core.receive(a.id, { t: 'stop' })
    assert.equal(services[0].closed, 0)
  })
})
