/**
 * Host an onion service from a worker instead of from the page, so that it survives a page reload and is
 * shared by every tab of the origin. See .agent/worker-hosting-execplan.md and the README ("Hosting from a
 * worker"). The worker side is hostWorker.ts; the messages are in protocol.ts.
 */

import { TorClient } from '../../TorClient.js';
import { getWasmLocation } from '../../wasm.js';
import type { PowStats } from '../types.js';
import type { FromHostWorker, HostWorkerState, HostWorkerStatus, ToHostWorker } from './protocol.js';

export type { HostWorkerStatus, HostWorkerState };

export interface HostWorkerOptions {
  /**
   * URL of a module whose default export is the request handler, `(request: Request) => Response |
   * Promise<Response>`. It runs inside the worker (no `window`, no DOM), so it cannot be a closure of the
   * page: the page may be reloaded while the service goes on. Relative URLs are resolved against the page.
   */
  handlerUrl: string | URL;
  /** The service's identity (32 secret bytes); a fresh one is made, and returned as `handle.identity`, if omitted. */
  identity?: Uint8Array;
  /** Where the worker script is; default `host-worker.js` next to the package's entry point (`tor-js/host-worker.js`). */
  workerUrl?: string | URL;
  /** Where the worker loads the WASM from; default the one this page loaded, or its bytes when it has no URL. */
  wasmUrl?: string | URL;
  ports?: number[];
  maxConnections?: number;
  proofOfWork?: boolean | { queueDepth?: number };
  /** A directory snapshot to start from (see `TorClientOptions.bootstrapUrl`). */
  bootstrapUrl?: string | URL;
  /** How long the service outlives its last page, in ms (default 30000). Lets a reloading page find it running. */
  keepAliveMs?: number;
  /** Called with every status the worker sends. */
  onStatus?: (status: HostWorkerStatus) => void;
}

export interface HostWorkerHandle {
  /** The service's address. */
  readonly onion: string;
  /** The service's identity. */
  readonly identity: Uint8Array;
  /** The latest status the worker sent. */
  readonly status: HostWorkerStatus;
  /** Proof-of-work counters, from the latest status. */
  readonly pow: PowStats | undefined;
  /**
   * Whether the worker is shared with other tabs. `false` where `SharedWorker` does not exist: the worker is
   * then this page's own and the service ends with the page.
   */
  readonly shared: boolean;
  /** Be told of every status. Returns a function that stops it. */
  onStatus(callback: (status: HostWorkerStatus) => void): () => void;
  /** Stop the service for every page. */
  stop(): void;
  /** This page leaves; the service goes on while other pages are attached, and for `keepAliveMs` after the last. */
  detach(): void;
  /** Resolves when the service has ended (stopped, failed, or kept alive no longer). */
  readonly done: Promise<void>;
}

const PING_MS = 5000;

interface Channel {
  post(message: ToHostWorker): void;
  onMessage(callback: (message: FromHostWorker) => void): void;
  onError(callback: (e: unknown) => void): void;
  close(): void;
}

function openChannel(url: string, name: string): { channel: Channel; shared: boolean } {
  const g = globalThis as unknown as { SharedWorker?: new (url: string, options?: { name?: string }) => { port: MessagePort; onerror: ((e: unknown) => void) | null } };
  if (typeof g.SharedWorker === 'function') {
    const worker = new g.SharedWorker(url, { name });
    const port = worker.port;
    return {
      shared: true,
      channel: {
        post: (m) => port.postMessage(m),
        onMessage: (cb) => { port.onmessage = (e) => cb(e.data as FromHostWorker); port.start(); },
        onError: (cb) => { worker.onerror = cb; },
        close: () => port.close(),
      },
    };
  }
  const worker = new Worker(url, { name });
  return {
    shared: false,
    channel: {
      post: (m) => worker.postMessage(m),
      onMessage: (cb) => { worker.onmessage = (e) => cb(e.data as FromHostWorker); },
      onError: (cb) => { worker.onerror = cb; },
      close: () => worker.terminate(),
    },
  };
}

/**
 * Host an onion service from a worker. Resolves once the service is online (rejects if it cannot start).
 * Tabs that call this with the same identity share one worker and one service.
 */
export async function startHostWorker(options: HostWorkerOptions): Promise<HostWorkerHandle> {
  const identity = options.identity ?? TorClient.generateIdentity();
  const onion = await TorClient.onionAddress(identity); // also checks that this build can host
  const pageBase = (globalThis as { location?: { href: string } }).location?.href;
  const resolve = (u: string | URL) => new URL(String(u), pageBase).href;

  const workerUrl = options.workerUrl !== undefined ? resolve(options.workerUrl) : new URL('../../host-worker.js', import.meta.url).href;
  const wasm = getWasmLocation();
  const wasmUrl = options.wasmUrl !== undefined ? resolve(options.wasmUrl) : wasm.url;
  const wasmBytes = wasmUrl ? undefined : await wasm.bytes();

  // The worker's name is the address: a second tab with the same identity connects to the first one's worker.
  const { channel, shared } = openChannel(workerUrl, onion);

  let latest: HostWorkerStatus = { state: 'idle', attached: 0 };
  const listeners = new Set<(status: HostWorkerStatus) => void>();
  if (options.onStatus) listeners.add(options.onStatus);
  let settled = false;
  let ping: ReturnType<typeof setInterval> | null = null;
  let finish!: () => void;
  const done = new Promise<void>((r) => { finish = r; });

  const leave = () => {
    if (ping !== null) { clearInterval(ping); ping = null; }
    try { channel.post({ t: 'bye' }); } catch { /* the worker is gone */ }
    channel.close();
    finish();
  };

  const handle: HostWorkerHandle = {
    onion,
    identity,
    get status() { return latest; },
    get pow() { return latest.pow; },
    shared,
    onStatus(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    stop() { channel.post({ t: 'stop' }); },
    detach: leave,
    done,
  };

  const ready = new Promise<HostWorkerHandle>((resolveReady, rejectReady) => {
    channel.onError((e) => {
      const message = (e as { message?: string })?.message ?? 'the hosting worker failed to load';
      if (!settled) { settled = true; rejectReady(new Error(`the hosting worker (${workerUrl}) failed: ${message}`)); }
      leave();
    });
    channel.onMessage((message) => {
      if (message.t !== 'status') return;
      latest = message.status;
      for (const cb of [...listeners]) {
        try { cb(latest); } catch { /* a listener's error is its own */ }
      }
      const state = latest.state;
      if (!settled && state === 'online') { settled = true; resolveReady(handle); }
      else if (!settled && (state === 'error' || state === 'closed')) {
        settled = true;
        rejectReady(new Error(latest.error ?? 'the onion service did not start'));
        leave();
      } else if (settled && (state === 'closed' || state === 'error')) {
        leave(); // it ended on its own, or another page stopped it
      }
    });
  });

  const start = {
    handlerUrl: resolve(options.handlerUrl),
    identity,
    ...(wasmUrl ? { wasmUrl } : {}),
    ...(wasmBytes ? { wasmBytes } : {}),
    ...(options.ports ? { ports: options.ports } : {}),
    ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
    ...(options.proofOfWork !== undefined ? { proofOfWork: options.proofOfWork } : {}),
    ...(options.bootstrapUrl !== undefined ? { bootstrapUrl: resolve(options.bootstrapUrl) } : {}),
    ...(options.keepAliveMs !== undefined ? { keepAliveMs: options.keepAliveMs } : {}),
  };
  channel.post({ t: 'start', start });
  ping = setInterval(() => { try { channel.post({ t: 'ping' }); } catch { /* gone */ } }, PING_MS);
  const g = globalThis as { addEventListener?: (type: string, fn: () => void) => void };
  g.addEventListener?.('pagehide', () => { if (ping !== null) leave(); });

  return ready;
}
