/**
 * The wire protocol between the Service Worker and the persistent Tor host.
 *
 * The Service Worker is only a router: browsers stop it after about half a
 * minute without events, and while the Tor client is busy on its thread even
 * static requests queue behind it. So the Tor client lives in a SharedWorker
 * (or a dedicated Worker where SharedWorker does not exist) and the two talk
 * over a `MessagePort` the page hands to both ends:
 *
 *   Service Worker  --- PortBackend ---[MessagePort]--- serveBackend --- LocalBackend --- Tor
 *
 * `serveBackend` runs in the host and exposes any {@link SiteBackend};
 * `PortBackend` runs in the Service Worker and is itself a {@link SiteBackend},
 * so the rest of the worker does not care where Tor is.
 *
 * Bodies travel as transferred `ArrayBuffer`s, one message per chunk. There is
 * no flow control: a fast Tor stream feeding a slow page buffers in the
 * worker, which is acceptable at Tor's bandwidth.
 */

import type { SiteBackend, SiteStatus } from './backend.js';
import type { SiteRequest, SiteResponse } from './torHttp.js';

type WireRequest = Omit<SiteRequest, 'signal'>;

type ToHost =
  | { t: 'req'; id: number; req: WireRequest }
  | { t: 'cancel'; id: number }
  | { t: 'warm'; id: number }
  | { t: 'ping'; id: number };

type FromHost =
  | { t: 'head'; id: number; status: number; statusText: string; headers: [string, string][]; hasBody: boolean }
  | { t: 'chunk'; id: number; data: ArrayBuffer }
  | { t: 'end'; id: number }
  | { t: 'err'; id: number; message: string }
  | { t: 'warmed'; id: number }
  | { t: 'pong'; id: number }
  | { t: 'status'; status: SiteStatus }
  | { t: 'log'; level: string; message: string };

/** Host side: answer requests arriving on `port` from `backend`. */
export function serveBackend(port: MessagePort, backend: SiteBackend): {
  /** Send a status or log line to the other end of the port. */
  push(msg: Extract<FromHost, { t: 'status' | 'log' }>): void;
} {
  const inflight = new Map<number, AbortController>();
  const send = (msg: FromHost, transfer?: Transferable[]) => port.postMessage(msg, transfer ?? []);

  async function serve(id: number, req: WireRequest): Promise<void> {
    const ac = new AbortController();
    inflight.set(id, ac);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const res = await backend.handle({ ...req, signal: ac.signal });
      send({ t: 'head', id, status: res.status, statusText: res.statusText, headers: res.headers, hasBody: res.body !== null });
      if (res.body) {
        reader = res.body.getReader();
        // A cancel must reach the upstream stream even while a read is pending,
        // or the Tor stream stays open until the server closes it.
        const upstream = reader;
        ac.signal.addEventListener('abort', () => void upstream.cancel().catch(() => {}), { once: true });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ac.signal.aborted) break;
          const buf = exactBuffer(value);
          send({ t: 'chunk', id, data: buf }, [buf]);
        }
      }
      if (!ac.signal.aborted) send({ t: 'end', id });
    } catch (e) {
      if (!ac.signal.aborted) send({ t: 'err', id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      inflight.delete(id);
    }
  }

  port.onmessage = (event: MessageEvent) => {
    const msg = event.data as ToHost;
    switch (msg.t) {
      case 'req':
        void serve(msg.id, msg.req);
        break;
      case 'cancel':
        inflight.get(msg.id)?.abort();
        break;
      case 'warm':
        void backend.warm().then(() => send({ t: 'warmed', id: msg.id }));
        break;
      case 'ping':
        send({ t: 'pong', id: msg.id });
        break;
    }
  };
  port.start?.();

  return { push: (msg) => send(msg) };
}

interface Pending {
  resolve(res: SiteResponse): void;
  reject(err: Error): void;
  stream: ReadableStreamDefaultController<Uint8Array> | null;
  started: boolean;
}

export interface PortBackendHooks {
  onStatus?(status: SiteStatus): void;
  onLog?(level: string, message: string): void;
}

/** Service Worker side: a {@link SiteBackend} that forwards over a port to a host. */
export class PortBackend implements SiteBackend {
  /** When anything last arrived from the host (epoch ms); used to decide whether to ping first. */
  lastSeen = Date.now();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters = new Map<number, () => void>();

  constructor(
    private readonly port: MessagePort,
    private readonly hooks: PortBackendHooks = {},
  ) {
    port.onmessage = (event: MessageEvent) => this.onMessage(event.data as FromHost);
    port.start?.();
  }

  handle(req: SiteRequest): Promise<SiteResponse> {
    const id = this.nextId++;
    const { signal, ...wire } = req;
    return new Promise<SiteResponse>((resolve, reject) => {
      const entry: Pending = { resolve, reject, stream: null, started: false };
      this.pending.set(id, entry);
      const abort = () => {
        this.port.postMessage({ t: 'cancel', id } satisfies ToHost);
        this.fail(id, new DOMException('The request was aborted', 'AbortError'));
      };
      if (signal) {
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
      }
      const transfer: Transferable[] = wire.body ? [wire.body.buffer as ArrayBuffer] : [];
      this.port.postMessage({ t: 'req', id, req: wire } satisfies ToHost, transfer);
    });
  }

  warm(): Promise<void> {
    const id = this.nextId++;
    return new Promise<void>((resolve) => {
      this.waiters.set(id, resolve);
      this.port.postMessage({ t: 'warm', id } satisfies ToHost);
    });
  }

  /** True if the host answers within `timeoutMs`. A host whose page closed never does. */
  ping(timeoutMs = 1500): Promise<boolean> {
    const id = this.nextId++;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(false);
      }, timeoutMs);
      this.waiters.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
      this.port.postMessage({ t: 'ping', id } satisfies ToHost);
    });
  }

  close(): void {
    this.port.onmessage = null;
    this.port.close();
    for (const id of [...this.pending.keys()]) this.fail(id, new Error('The Tor host went away'));
  }

  private onMessage(msg: FromHost): void {
    this.lastSeen = Date.now();
    switch (msg.t) {
      case 'head': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        p.started = true;
        const body = msg.hasBody
          ? new ReadableStream<Uint8Array>({
              start: (c) => {
                p.stream = c;
              },
              cancel: () => {
                this.pending.delete(msg.id);
                this.port.postMessage({ t: 'cancel', id: msg.id } satisfies ToHost);
              },
            })
          : null;
        p.resolve({ status: msg.status, statusText: msg.statusText, headers: msg.headers, body });
        break;
      }
      case 'chunk':
        this.pending.get(msg.id)?.stream?.enqueue(new Uint8Array(msg.data));
        break;
      case 'end': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.stream?.close();
        break;
      }
      case 'err':
        this.fail(msg.id, new Error(msg.message));
        break;
      case 'warmed':
      case 'pong': {
        const w = this.waiters.get(msg.id);
        this.waiters.delete(msg.id);
        w?.();
        break;
      }
      case 'status':
        this.hooks.onStatus?.(msg.status);
        break;
      case 'log':
        this.hooks.onLog?.(msg.level, msg.message);
        break;
    }
  }

  private fail(id: number, err: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.started) p.stream?.error(err);
    else p.reject(err);
  }
}

/** A buffer holding exactly the bytes of `view`, transferable without dragging a larger backing store along. */
function exactBuffer(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.buffer instanceof ArrayBuffer) {
    return view.buffer;
  }
  return view.slice().buffer as ArrayBuffer;
}
