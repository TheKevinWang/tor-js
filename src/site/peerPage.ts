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
/**
 * ICE gathering "completes" only when every configured STUN server has answered
 * or timed out, which in a measured cold start was the whole 10 s it was given.
 * The offer only needs a candidate the proxy can reach, in practice a
 * server-reflexive one, so gathering ends shortly after the first of those, and
 * never later than the cap.
 */
const GATHER_GRACE_MS = 600;
const GATHER_MAX_MS = 4_000;
/** A proxy whose data channel has not opened by now is unreachable or too slow; ask for another. */
const OPEN_TIMEOUT_MS = 6_000;
/** A spare peer's candidates go stale (NAT bindings expire); older than this it is not used. */
const SPARE_MAX_AGE_MS = 20_000;

export interface PeerDeps {
  /** Override the global `RTCPeerConnection` (tests). */
  RTCPeerConnection?: typeof RTCPeerConnection;
  /** Override the timers' lengths (tests). */
  gatherGraceMs?: number;
  gatherMaxMs?: number;
  openTimeoutMs?: number;
  heartbeatMs?: number;
  /** How long the worker may be silent before the page gives up on it. */
  silenceMs?: number;
}

/** A peer connection with its data channel and an offer that is being (or has been) prepared. */
interface Prepared {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  /** Resolves with the offer SDP once ICE gathering is useful; rejects if no candidate was found. */
  sdp: Promise<string>;
  key: string;
  at: number;
  Ctor: typeof RTCPeerConnection;
}

function prepare(
  PC: typeof RTCPeerConnection,
  stun: readonly string[],
  deps: Pick<PeerDeps, 'gatherGraceMs' | 'gatherMaxMs'>,
): Prepared {
  const pc = new PC({ iceServers: stun.map((urls) => ({ urls })) });
  const dc = pc.createDataChannel('snowflake');
  dc.binaryType = 'arraybuffer';
  const sdp = (async () => {
    await pc.setLocalDescription(await pc.createOffer());
    await gatherIce(pc, deps.gatherGraceMs ?? GATHER_GRACE_MS, deps.gatherMaxMs ?? GATHER_MAX_MS);
    const text = pc.localDescription?.sdp ?? '';
    if (!text.includes('a=candidate:')) throw new Error('WebRTC gathered no ICE candidates');
    return text;
  })();
  sdp.catch(() => {}); // surfaced where the offer is used
  return { pc, dc, sdp, key: stun.join(','), at: Date.now(), Ctor: PC };
}

let spare: Prepared | null = null;

/**
 * Start preparing a peer connection (create it, gather ICE candidates, build the
 * offer) before anyone asks for one, so that the Tor client's request for an
 * offer, which comes only after the WASM has loaded and storage has been read,
 * is answered at once. Used once, only if the request names the same STUN
 * servers and arrives while the candidates are fresh.
 */
export function prepareSpare(stunUrls: readonly string[], deps: PeerDeps = {}): void {
  const PC = deps.RTCPeerConnection ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  if (!PC || spare) return;
  try {
    spare = prepare(PC, stunUrls, deps);
  } catch {
    spare = null;
  }
}

/** Close and forget the spare peer, if any. */
export function discardSpare(): void {
  const s = spare;
  spare = null;
  if (!s) return;
  try { s.dc.close(); s.pc.close(); } catch { /* already closed */ }
}

function takeSpare(PC: typeof RTCPeerConnection, stun: readonly string[]): Prepared | null {
  const s = spare;
  spare = null;
  if (!s) return null;
  if (s.Ctor !== PC || s.key !== stun.join(',') || Date.now() - s.at > SPARE_MAX_AGE_MS) {
    try { s.dc.close(); s.pc.close(); } catch { /* already closed */ }
    return null;
  }
  return s;
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
    const prepared = takeSpare(PC, stun) ?? prepare(PC, stun, deps);
    pc = prepared.pc;
    dc = prepared.dc;
    dc.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) send({ t: 'data', data: e.data }, [e.data]);
    };
    dc.onclose = () => {
      send({ t: 'closed' });
      teardown();
    };
    send({ t: 'offer-ok', sdp: await prepared.sdp });
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

function gatherIce(pc: RTCPeerConnection, graceMs: number, maxMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    let grace: ReturnType<typeof setTimeout> | null = null;
    const cap = setTimeout(done, maxMs); // use the candidates gathered so far
    function done() {
      clearTimeout(cap);
      if (grace) clearTimeout(grace);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done();
    }
    function onCandidate(e: RTCPeerConnectionIceEvent) {
      // The first server-reflexive candidate is what a proxy behind another NAT
      // can reach; a short grace lets a second STUN answer arrive, then go.
      if (!grace && e.candidate && / typ srflx/.test(e.candidate.candidate)) grace = setTimeout(done, graceMs);
    }
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
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

