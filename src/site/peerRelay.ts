/**
 * Borrowing a page's WebRTC peer connection for the Tor client in a worker:
 * the worker's half (the page's half is in peerPage.ts).
 *
 * The Snowflake WebRTC carrier needs `RTCPeerConnection`, which exists in a
 * page but not in a worker. The Tor client lives in the host worker, so a page
 * of the site hosts the peer connection and relays the data channel's bytes
 * over a `MessagePort`:
 *
 *   Tor client (host worker) --- RemotePeer ---[MessagePort]--- servePeer (peerPage.ts) --- RTCPeerConnection ---> proxy
 *
 * Everything above the data channel (the broker exchange, Turbo Tunnel, KCP,
 * smux) stays in the Tor client; the page does only what needs the browser
 * object (see {@link RtcPeer}). If the page closes, its connection dies; the
 * Snowflake session layer notices the dropped carrier and redials it, which
 * then lands on another page.
 *
 * Messages, worker to page: `offer {stun}`, `answer {sdp}`, `data {data}`,
 * `close`, `hb`. Page to worker: `ready`, `offer-ok {sdp}`, `open`, `error
 * {message}`, `data {data}`, `credit {n}`, `hb`, `closed`. Either end that sees
 * the other go silent for {@link DEFAULT_SILENCE_MS} tears its side down, and a
 * side that gives up first says `close`/`closed`, so neither end leaks.
 *
 * Writes toward the page are flow-controlled by a credit window: the worker
 * may have at most {@link WINDOW_BYTES} written but not yet acknowledged, and
 * the page acknowledges a chunk once `dataChannel.bufferedAmount` is low,
 * because `RTCDataChannel.send` has no backpressure of its own.
 */

import type { RtcPeer, RtcPeerFactory, RtcSocket } from '../types.js';

/** Most bytes the worker may have outstanding toward the page. */
export const WINDOW_BYTES = 256 * 1024;
/** How often each end tells the other it is alive while a peer is open. */
export const HEARTBEAT_MS = 5_000;
/** How long an end may hear nothing before it gives up on the other. */
export const DEFAULT_SILENCE_MS = 20_000;

/** Somewhere a page can be asked to host a peer: a page's control port, or the worker's owner. */
export interface PageTarget {
  post(msg: unknown, transfer: Transferable[]): void;
}

/**
 * Ask pages, newest first (`targets` is oldest first), to accept a peer, and
 * return the worker's end of the channel to the first that answers. A page
 * that has closed never answers, hence the timeout; such targets are removed
 * from `targets` so the next request does not wait for them again.
 */
export async function acquirePeerPort(
  targets: PageTarget[],
  timeoutMs = 3000,
  /** What is asked of the page: the message is `${kind}-request`; `extra` is added to it. */
  request: { kind?: 'peer' | 'pow'; extra?: Record<string, unknown> } = {},
): Promise<MessagePort> {
  const kind = request.kind ?? 'peer';
  for (let i = targets.length - 1; i >= 0; i--) {
    const channel = new MessageChannel();
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      channel.port1.onmessage = (e: MessageEvent) => {
        if ((e.data as { t?: string } | null)?.t === 'ready') {
          clearTimeout(timer);
          resolve(true);
        }
      };
    });
    try {
      targets[i].post({ t: `${kind}-request`, ...request.extra, port: channel.port2 }, [channel.port2]);
    } catch {
      channel.port1.close();
      targets.splice(i, 1);
      continue;
    }
    if (await ready) return channel.port1;
    channel.port1.close();
    targets.splice(i, 1);
  }
  throw new Error(kind === 'pow'
    ? 'no open page of the site can start the proof-of-work workers'
    : 'no open page of the site can host a WebRTC peer connection (open the site in a tab, or use the WebSocket carrier)');
}

export interface RemotePeerOptions {
  /** How long an open peer may be silent (the page sends a heartbeat every 5 s) before it counts as closed. */
  silenceMs?: number;
  /** How often the worker tells the page it is alive. */
  heartbeatMs?: number;
}

/** The {@link RtcPeerFactory} for the Tor client: each peer is hosted by whichever page `acquirePort` finds. */
export function createRemotePeerFactory(
  acquirePort: () => Promise<MessagePort>,
  options: RemotePeerOptions = {},
): RtcPeerFactory {
  return async () =>
    new RemotePeer(await acquirePort(), options.silenceMs ?? DEFAULT_SILENCE_MS, options.heartbeatMs ?? HEARTBEAT_MS);
}

interface Request {
  ok: string;
  resolve(msg: Record<string, unknown>): void;
  reject(err: Error): void;
}

class RemotePeer implements RtcPeer {
  private request: Request | null = null;
  private closed = false;
  private lastSeen = Date.now();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private inflight = 0;
  private creditWaiters: (() => void)[] = [];
  private readableController: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(
    private readonly port: MessagePort,
    private readonly silenceMs: number,
    private readonly heartbeatMs: number,
  ) {
    port.onmessage = (event: MessageEvent) => this.onMessage(event.data as Record<string, unknown> & { t: string });
    port.start?.();
  }

  offer(stunUrls: string[]): Promise<string> {
    return this.ask({ t: 'offer', stun: stunUrls }, 'offer-ok').then((m) => String(m.sdp));
  }

  async open(answerSdp: string): Promise<RtcSocket> {
    await this.ask({ t: 'answer', sdp: answerSdp }, 'open');
    this.lastSeen = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastSeen > this.silenceMs) {
        this.shutdown(new Error('the page hosting the WebRTC connection went silent'), true);
      }
    }, Math.max(10, Math.floor(this.silenceMs / 4)));
    this.heartbeat = setInterval(() => this.post({ t: 'hb' }), this.heartbeatMs);

    const readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.readableController = c;
      },
      cancel: () => this.close(),
    });
    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.closed) throw new Error('the WebRTC data channel is closed');
        const copy = chunk.slice().buffer as ArrayBuffer;
        this.inflight += copy.byteLength;
        this.port.postMessage({ t: 'data', data: copy }, [copy]);
        while (this.inflight > WINDOW_BYTES && !this.closed) {
          await new Promise<void>((resolve) => this.creditWaiters.push(resolve));
        }
        if (this.closed) throw new Error('the WebRTC data channel is closed');
      },
      close: () => this.close(),
      abort: () => this.close(),
    });
    return { readable, writable, close: () => this.close() };
  }

  close(): void {
    this.shutdown(null, true);
  }

  private post(msg: { t: string }): void {
    try { this.port.postMessage(msg); } catch { /* page gone */ }
  }

  private ask(msg: { t: string; [key: string]: unknown }, ok: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('the WebRTC peer is closed'));
      this.request = { ok, resolve, reject };
      this.port.postMessage(msg);
    });
  }

  private onMessage(msg: Record<string, unknown> & { t: string }): void {
    this.lastSeen = Date.now();
    switch (msg.t) {
      case 'offer-ok':
      case 'open':
        if (this.request?.ok === msg.t) {
          const r = this.request;
          this.request = null;
          r.resolve(msg);
        }
        break;
      case 'error':
        this.shutdown(new Error(String(msg.message)), false);
        break;
      case 'data':
        try { this.readableController?.enqueue(new Uint8Array(msg.data as ArrayBuffer)); } catch { /* cancelled */ }
        break;
      case 'credit':
        this.inflight = Math.max(0, this.inflight - Number(msg.n));
        if (this.inflight <= WINDOW_BYTES) this.releaseWriters();
        break;
      case 'closed':
        this.shutdown(null, false);
        break;
      // 'hb' only refreshes lastSeen.
    }
  }

  /**
   * Stop everything; `err` rejects a request still waiting, and a clean end is
   * an EOF for the reader. `tellPage` is false when the page already ended it.
   */
  private shutdown(err: Error | null, tellPage: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (tellPage) this.post({ t: 'close' });
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.request?.reject(err ?? new Error('the WebRTC peer closed'));
    this.request = null;
    try { this.readableController?.close(); } catch { /* already closed */ }
    this.releaseWriters();
    try { this.port.close(); } catch { /* already closed */ }
  }

  private releaseWriters(): void {
    const waiters = this.creditWaiters;
    this.creditWaiters = [];
    for (const w of waiters) w();
  }
}
