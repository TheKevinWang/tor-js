/**
 * The page's half of borrowing a WebRTC peer connection for the Tor client in
 * a worker (the worker's half, and the protocol, are described in
 * peerRelay.ts): host an `RTCPeerConnection` and relay its data channel over a
 * `MessagePort`.
 */

import { DEFAULT_SILENCE_MS, HEARTBEAT_MS } from './peerRelay.js';

/** The page holds its credit until the data channel's send buffer is below this. */
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;
const ICE_GATHERING_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_MS = 10_000;

export interface PeerDeps {
  /** Override the global `RTCPeerConnection` (tests). */
  RTCPeerConnection?: typeof RTCPeerConnection;
  /** Override the timers' lengths (tests). */
  iceGatheringTimeoutMs?: number;
  openTimeoutMs?: number;
  heartbeatMs?: number;
  /** How long the worker may be silent before the page gives up on it. */
  silenceMs?: number;
}

/**
 * Serve one peer connection on `port` (the page end of the channel created by
 * {@link acquirePeerPort}). The connection is created when the worker asks for
 * an offer and torn down when the worker closes the port, the channel closes,
 * or the page goes away.
 */
export function servePeer(port: MessagePort, deps: PeerDeps = {}): void {
  const PC = deps.RTCPeerConnection ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastSeen = Date.now();
  let torn = false;
  // Data messages are applied in order even though each may wait for credit.
  let queue: Promise<void> = Promise.resolve();

  const send = (msg: unknown, transfer: Transferable[] = []) => {
    try {
      port.postMessage(msg, transfer);
    } catch {
      // The other end is gone.
    }
  };
  const onHide = () => {
    send({ t: 'closed' });
    teardown();
  };
  const teardown = () => {
    if (torn) return;
    torn = true;
    if (heartbeat) clearInterval(heartbeat);
    if (watchdog) clearInterval(watchdog);
    (globalThis as { removeEventListener?: (t: string, f: () => void) => void }).removeEventListener?.('pagehide', onHide);
    try { dc?.close(); } catch { /* already closed */ }
    try { pc?.close(); } catch { /* already closed */ }
    try { port.close(); } catch { /* already closed */ }
  };
  (globalThis as { addEventListener?: (t: string, f: () => void) => void }).addEventListener?.('pagehide', onHide);

  async function offer(stun: string[]): Promise<void> {
    if (!PC) throw new Error('RTCPeerConnection is not available in this page');
    pc = new PC({ iceServers: stun.map((urls) => ({ urls })) });
    dc = pc.createDataChannel('snowflake');
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) send({ t: 'data', data: e.data }, [e.data]);
    };
    dc.onclose = () => {
      send({ t: 'closed' });
      teardown();
    };
    const description = await pc.createOffer();
    await pc.setLocalDescription(description);
    await gatherIce(pc, deps.iceGatheringTimeoutMs ?? ICE_GATHERING_TIMEOUT_MS);
    const sdp = pc.localDescription?.sdp ?? '';
    if (!sdp.includes('a=candidate:')) throw new Error('WebRTC gathered no ICE candidates');
    send({ t: 'offer-ok', sdp });
  }

  async function answer(sdp: string): Promise<void> {
    if (!pc || !dc) throw new Error('answer before offer');
    await pc.setRemoteDescription({ type: 'answer', sdp });
    await waitForOpen(dc, deps.openTimeoutMs ?? OPEN_TIMEOUT_MS);
    heartbeat = setInterval(() => send({ t: 'hb' }), deps.heartbeatMs ?? HEARTBEAT_MS);
    // A worker that stops talking (its page-side owner closed, or it was
    // terminated) will never say `close`; do not hold the connection forever.
    const silenceMs = deps.silenceMs ?? DEFAULT_SILENCE_MS;
    lastSeen = Date.now();
    watchdog = setInterval(() => {
      if (Date.now() - lastSeen > silenceMs) {
        send({ t: 'closed' });
        teardown();
      }
    }, Math.max(10, Math.floor(silenceMs / 4)));
    send({ t: 'open' });
  }

  async function relay(data: ArrayBuffer): Promise<void> {
    if (!dc || dc.readyState !== 'open') {
      send({ t: 'closed' });
      teardown();
      return;
    }
    dc.send(data);
    if (dc.bufferedAmount > BUFFER_HIGH) await bufferedLow(dc);
    send({ t: 'credit', n: data.byteLength });
  }

  port.onmessage = (event: MessageEvent) => {
    lastSeen = Date.now();
    const msg = event.data as { t: string; stun?: string[]; sdp?: string; data?: ArrayBuffer };
    const fail = (e: unknown) => {
      send({ t: 'error', message: e instanceof Error ? e.message : String(e) });
      teardown();
    };
    switch (msg.t) {
      case 'offer':
        offer(msg.stun ?? []).catch(fail);
        break;
      case 'answer':
        answer(msg.sdp ?? '').catch(fail);
        break;
      case 'data':
        queue = queue.then(() => relay(msg.data!)).catch(() => {});
        break;
      case 'close':
        teardown();
        break;
    }
  };
  port.start?.();
  send({ t: 'ready' });
}

function gatherIce(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, timeoutMs); // use the candidates gathered so far
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done();
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function waitForOpen(dc: RTCDataChannel, timeoutMs: number): Promise<void> {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("the proxy's data channel did not open")), timeoutMs);
    const onOpen = () => finish();
    const onFail = () => finish(new Error("the proxy's data channel did not open"));
    function finish(err?: Error) {
      clearTimeout(timer);
      dc.removeEventListener('open', onOpen);
      dc.removeEventListener('error', onFail);
      dc.removeEventListener('close', onFail);
      if (err) reject(err);
      else resolve();
    }
    dc.addEventListener('open', onOpen);
    dc.addEventListener('error', onFail);
    dc.addEventListener('close', onFail);
  });
}

function bufferedLow(dc: RTCDataChannel): Promise<void> {
  dc.bufferedAmountLowThreshold = BUFFER_LOW;
  return new Promise<void>((resolve) => {
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      dc.removeEventListener('close', done);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);
    dc.addEventListener('close', done);
  });
}

