// Unit tests for borrowing a page's WebRTC peer connection (src/site/peerRelay.ts):
// both ends over a real MessageChannel, with a fake RTCPeerConnection.
//
//   npm run test:unit

import { test, before, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-peer')
})

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const enc = new TextEncoder()
const dec = new TextDecoder()

// --- a fake RTCPeerConnection -------------------------------------------------

class FakeDataChannel extends EventTarget {
  readyState = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  binaryType = 'blob'
  sent = []
  onmessage = null
  onclose = null
  send(data) { this.sent.push(new Uint8Array(data)) }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
    this.dispatchEvent(new Event('close'))
  }
  open() {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }
  receive(bytes) { this.onmessage?.({ data: bytes.slice().buffer }) }
}

class FakePeerConnection extends EventTarget {
  static last = null
  static noCandidates = false
  static neverOpen = false
  iceGatheringState = 'new'
  localDescription = null
  remote = null
  closed = false
  constructor(config) {
    super()
    this.config = config
    this.dc = new FakeDataChannel()
    FakePeerConnection.last = this
  }
  createDataChannel() { return this.dc }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' } }
  async setLocalDescription(d) {
    const sdp = FakePeerConnection.noCandidates ? d.sdp : d.sdp + '\r\na=candidate:1 1 UDP 1 192.0.2.1 9 typ host'
    this.localDescription = { type: d.type, sdp }
    setTimeout(() => {
      this.iceGatheringState = 'complete'
      this.dispatchEvent(new Event('icegatheringstatechange'))
    }, 1)
  }
  async setRemoteDescription(d) {
    this.remote = d
    if (!FakePeerConnection.neverOpen) setTimeout(() => this.dc.open(), 1)
  }
  close() { this.closed = true }
}

beforeEach(() => {
  FakePeerConnection.last = null
  FakePeerConnection.noCandidates = false
  FakePeerConnection.neverOpen = false
})

/** A page end and a worker-side factory joined by one channel. */
function joined(pageDeps = {}, relayOptions = {}) {
  const ch = new MessageChannel()
  m.servePeer(ch.port2, { RTCPeerConnection: FakePeerConnection, ...pageDeps })
  const factory = m.createRemotePeerFactory(async () => ch.port1, relayOptions)
  return { factory, ch }
}

async function open(pageDeps, relayOptions) {
  const { factory, ch } = joined(pageDeps, relayOptions)
  const peer = await factory()
  await peer.offer(['stun:one.example:3478', 'stun:two.example:3478'])
  const socket = await peer.open('ANSWER-SDP')
  return { peer, socket, ch, pc: FakePeerConnection.last }
}

describe('peer relay', () => {
  test('offer returns SDP with candidates, built from the STUN list; the answer reaches the connection', async () => {
    const { factory } = joined()
    const peer = await factory()
    const sdp = await peer.offer(['stun:one.example:3478', 'stun:two.example:3478'])
    assert.match(sdp, /a=candidate:/)
    const pc = FakePeerConnection.last
    assert.deepEqual(pc.config.iceServers, [{ urls: 'stun:one.example:3478' }, { urls: 'stun:two.example:3478' }])
    assert.equal(pc.dc.binaryType, 'arraybuffer')
    await peer.open('ANSWER-SDP')
    assert.deepEqual(pc.remote, { type: 'answer', sdp: 'ANSWER-SDP' })
    peer.close()
  })

  test('bytes flow both ways', async () => {
    const { socket, pc, peer } = await open()
    const writer = socket.writable.getWriter()
    await writer.write(enc.encode('to the proxy'))
    await tick()
    assert.equal(dec.decode(pc.dc.sent[0]), 'to the proxy')

    pc.dc.receive(enc.encode('from the proxy'))
    const reader = socket.readable.getReader()
    const { value } = await reader.read()
    assert.equal(dec.decode(value), 'from the proxy')
    peer.close()
  })

  test('a subarray write sends only its own bytes', async () => {
    const { socket, pc, peer } = await open()
    const backing = enc.encode('XXhelloYY')
    await socket.writable.getWriter().write(backing.subarray(2, 7))
    await tick()
    assert.equal(dec.decode(pc.dc.sent[0]), 'hello')
    peer.close()
  })

  test('the credit window stops a writer until the data channel drains', async () => {
    const { socket, pc, peer } = await open()
    pc.dc.bufferedAmount = 2 * 1024 * 1024 // above the page's high-water mark
    const writer = socket.writable.getWriter()
    const chunk = new Uint8Array(200 * 1024)
    await writer.write(chunk) // within the 256 KiB window
    let secondDone = false
    const second = writer.write(chunk).then(() => { secondDone = true }) // 400 KiB outstanding
    await tick(60)
    assert.equal(secondDone, false, 'blocked: no credit while the channel is backed up')
    pc.dc.bufferedAmount = 0
    pc.dc.dispatchEvent(new Event('bufferedamountlow'))
    await second
    assert.equal(secondDone, true)
    assert.equal(pc.dc.sent.length, 2)
    peer.close()
  })

  test('closing from the worker closes the data channel and connection', async () => {
    const { socket, pc, peer } = await open()
    socket.close()
    await tick()
    assert.equal(pc.dc.readyState, 'closed')
    assert.equal(pc.closed, true)
    const { done } = await socket.readable.getReader().read()
    assert.equal(done, true)
    peer.close() // idempotent
  })

  test('the data channel closing ends the reader and fails later writes', async () => {
    const { socket, pc } = await open()
    pc.dc.receive(enc.encode('last words'))
    pc.dc.close()
    const reader = socket.readable.getReader()
    assert.equal(dec.decode((await reader.read()).value), 'last words')
    assert.equal((await reader.read()).done, true)
    await assert.rejects(socket.writable.getWriter().write(enc.encode('x')), /closed/)
  })

  test('a page that goes silent counts as closed', async () => {
    const { socket } = await open({ heartbeatMs: 1e9 }, { silenceMs: 120 })
    const reader = socket.readable.getReader()
    const result = await Promise.race([reader.read(), tick(1000).then(() => 'still open')])
    assert.notEqual(result, 'still open')
    assert.equal(result.done, true)
  })

  test('when the worker gives up on a silent page it tells the page, which tears down', async () => {
    const { socket, pc } = await open({ heartbeatMs: 1e9 }, { silenceMs: 100 })
    await socket.readable.getReader().read() // ends when the worker gives up
    await tick(40)
    assert.equal(pc.closed, true)
  })

  test('a page whose worker goes silent tears its connection down', async () => {
    const { pc, ch } = await open({ silenceMs: 100, heartbeatMs: 1e9 }, { heartbeatMs: 1e9, silenceMs: 1e9 })
    await tick(300)
    assert.equal(pc.closed, true, 'the page stopped waiting for a worker that stopped talking')
    ch.port1.close()
  })

  test('heartbeats keep an idle channel open', async () => {
    const { socket, peer } = await open({ heartbeatMs: 20, silenceMs: 120 }, { silenceMs: 120, heartbeatMs: 20 })
    const reader = socket.readable.getReader()
    const result = await Promise.race([reader.read(), tick(400).then(() => 'still open')])
    assert.equal(result, 'still open')
    peer.close()
  })

  test('an offer with no ICE candidates fails', async () => {
    FakePeerConnection.noCandidates = true
    const { factory } = joined()
    const peer = await factory()
    await assert.rejects(peer.offer(['stun:x:1']), /no ICE candidates/)
  })

  test('a data channel that never opens rejects open()', async () => {
    FakePeerConnection.neverOpen = true
    const { factory } = joined({ openTimeoutMs: 50 })
    const peer = await factory()
    await peer.offer(['stun:x:1'])
    await assert.rejects(peer.open('ANSWER'), /did not open/)
  })

  test('without RTCPeerConnection the page reports it', async () => {
    const ch = new MessageChannel()
    m.servePeer(ch.port2, { RTCPeerConnection: null })
    // `null ??` falls through to the global, which Node does not have.
    const peer = await m.createRemotePeerFactory(async () => ch.port1)()
    await assert.rejects(peer.offer(['stun:x:1']), /RTCPeerConnection is not available/)
  })
})

describe('acquiring a page', () => {
  const liveTarget = (deps = { RTCPeerConnection: FakePeerConnection }) => ({
    calls: 0,
    post(msg, transfer) {
      this.calls++
      m.servePeer(msg.port, deps)
    },
  })
  const deadTarget = () => ({ calls: 0, post() { this.calls++ } })

  test('the newest page that answers is used; one that does not is skipped', async () => {
    const older = liveTarget()
    const newer = deadTarget()
    const targets = [older, newer]
    const port = await m.acquirePeerPort(targets, 60)
    assert.equal(newer.calls, 1)
    assert.equal(older.calls, 1)
    assert.deepEqual(targets, [older], 'the silent page is forgotten, so the next request does not wait for it')
    const peer = await m.createRemotePeerFactory(async () => port)()
    assert.match(await peer.offer(['stun:x:1']), /a=candidate:/)
    peer.close()
  })

  test('the newest page is tried first', async () => {
    const older = liveTarget()
    const newer = liveTarget()
    const port = await m.acquirePeerPort([older, newer], 60)
    assert.equal(newer.calls, 1)
    assert.equal(older.calls, 0)
    port.close()
  })

  test('a target that throws is skipped', async () => {
    const throwing = { post() { throw new Error('port closed') } }
    const live = liveTarget()
    const targets = [live, throwing]
    const port = await m.acquirePeerPort(targets, 60)
    assert.equal(live.calls, 1)
    assert.deepEqual(targets, [live])
    port.close()
  })

  test('with no page that answers it explains what to do', async () => {
    await assert.rejects(m.acquirePeerPort([deadTarget()], 40), /no open page of the site/)
    await assert.rejects(m.acquirePeerPort([], 40), /no open page of the site/)
  })
})
