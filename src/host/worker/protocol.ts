/**
 * What runs inside the hosting worker, apart from the Tor client itself: who is attached, what state the
 * service is in, and when to stop it.
 *
 * Kept free of worker globals and of the Tor client so that a test can drive it with fakes: the real
 * service is a function the worker script hands in (`deps.start`), and time is injectable.
 *
 * A page that wants the service sends `start`, then `ping` every few seconds. The worker keeps the
 * service while at least one page is attached. A page that closes without saying goodbye (a crash, a
 * discarded tab) stops pinging and is dropped; when nobody is left the service gets a grace period
 * (so a page that reloads finds it running, with the same address) and is then stopped.
 */

import type { PowStats } from '../types.js';

/** Everything the worker needs to start the service. Sent by the first page that attaches. */
export interface HostWorkerStart {
  /** Absolute URL of the module whose default export is the request handler. */
  handlerUrl: string;
  /** The service's identity (32 secret bytes). */
  identity: Uint8Array;
  /** Where the worker can load the WASM from, if the page knows a URL. */
  wasmUrl?: string;
  /** The WASM itself, when there is no URL. */
  wasmBytes?: Uint8Array;
  ports?: number[];
  maxConnections?: number;
  proofOfWork?: boolean | { queueDepth?: number };
  /** The Snowflake carrier: workers have no `RTCPeerConnection`, so only the WebSocket one works. */
  snowflake?: boolean | 'websocket';
  /** A directory snapshot to start from (see `TorClientOptions.bootstrapUrl`). */
  bootstrapUrl?: string;
  /** How long the service outlives its last page, in ms (default 30000). */
  keepAliveMs?: number;
}

export type HostWorkerState = 'idle' | 'starting' | 'online' | 'closed' | 'error';

/** What the worker tells the pages. */
export interface HostWorkerStatus {
  state: HostWorkerState;
  /** The service's address, once known. */
  onion?: string;
  /** Proof-of-work counters while online (the final reading once closed). */
  pow?: PowStats;
  /** Why it failed, when `state` is `error`. */
  error?: string;
  /** How many pages are attached. */
  attached: number;
}

export type ToHostWorker =
  | { t: 'start'; start: HostWorkerStart }
  | { t: 'ping' }
  | { t: 'stop' }
  | { t: 'bye' };

export type FromHostWorker = { t: 'status'; status: HostWorkerStatus };

/** The running service, as the protocol needs it. */
export interface RunningHostedService {
  onion: string;
  /** Fresh counters each time it is read. */
  readonly pow: PowStats;
  close(): void;
  /** Resolves when the service has ended, whoever ended it. */
  done: Promise<void>;
}

export interface HostWorkerPeer {
  post(message: FromHostWorker): void;
}

export interface HostWorkerDeps {
  /** Start a service (and whatever it needs: the client, the handler). Rejects on any failure. */
  start(start: HostWorkerStart): Promise<RunningHostedService>;
  now?(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** A page that has not pinged for this long is gone (ms; default 15000). */
  staleMs?: number;
  /** How often to look for stale pages and push fresh counters (ms; default 1000). */
  tickMs?: number;
  /** How often to push the status to pages while online (ms; default 3000). */
  statusMs?: number;
}

const DEFAULT_KEEP_ALIVE_MS = 30_000;

export class HostWorkerCore {
  private readonly deps: HostWorkerDeps;
  private readonly peers = new Map<number, { peer: HostWorkerPeer; lastSeen: number }>();
  private nextId = 1;
  private state: HostWorkerState = 'idle';
  private onion: string | undefined;
  private service: RunningHostedService | null = null;
  private lastPow: PowStats | undefined;
  private error: string | undefined;
  private keepAliveMs = DEFAULT_KEEP_ALIVE_MS;
  private stopRequested = false;
  private tick: unknown = null;
  private grace: unknown = null;
  private lastPush = 0;

  constructor(deps: HostWorkerDeps) {
    this.deps = deps;
  }

  /** A page connected. Returns its id for `receive` and `detach`. */
  attach(peer: HostWorkerPeer): number {
    const id = this.nextId++;
    this.peers.set(id, { peer, lastSeen: this.now() });
    if (this.grace !== null) {
      this.clearTimeout(this.grace);
      this.grace = null;
    }
    this.startTick();
    peer.post({ t: 'status', status: this.status() });
    return id;
  }

  /** A message from an attached page. */
  receive(id: number, message: ToHostWorker): void {
    const entry = this.peers.get(id);
    if (!entry) return;
    entry.lastSeen = this.now();
    switch (message.t) {
      case 'start':
        this.begin(message.start, entry.peer);
        break;
      case 'ping':
        break;
      case 'stop':
        this.stop();
        break;
      case 'bye':
        this.detach(id);
        break;
    }
  }

  /** A page left (said goodbye, or its port went away). */
  detach(id: number): void {
    if (!this.peers.delete(id)) return;
    if (this.peers.size > 0) return;
    this.stopTick();
    if (this.state !== 'starting' && this.state !== 'online') return;
    // Nobody is attached: keep the service for a while, for a page that reloads.
    this.grace = this.setTimeout(() => {
      this.grace = null;
      if (this.peers.size === 0) this.stop();
    }, this.keepAliveMs);
  }

  /** The current status, as pages see it. */
  status(): HostWorkerStatus {
    const pow = this.service ? this.service.pow : this.lastPow;
    return {
      state: this.state,
      ...(this.onion !== undefined ? { onion: this.onion } : {}),
      ...(pow ? { pow } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      attached: this.peers.size,
    };
  }

  private begin(start: HostWorkerStart, requester: HostWorkerPeer): void {
    if (this.state === 'starting' || this.state === 'online') {
      // Another page started it already: this one joins the running service.
      requester.post({ t: 'status', status: this.status() });
      return;
    }
    this.state = 'starting';
    this.error = undefined;
    this.onion = undefined;
    this.lastPow = undefined;
    this.stopRequested = false;
    this.keepAliveMs = start.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
    this.push();
    let attempt: Promise<RunningHostedService>;
    try {
      attempt = this.deps.start(start);
    } catch (e) {
      attempt = Promise.reject(e);
    }
    attempt.then(
      (service) => {
        this.service = service;
        this.onion = service.onion;
        this.state = 'online';
        void service.done.then(
          () => this.ended(service),
          () => this.ended(service),
        );
        if (this.stopRequested) {
          service.close();
          return;
        }
        this.push();
      },
      (e) => {
        this.state = 'error';
        this.error = e instanceof Error ? e.message : String(e);
        this.push();
      },
    );
  }

  private stop(): void {
    if (this.state === 'starting') {
      this.stopRequested = true; // closed as soon as it is up
    } else if (this.service) {
      this.service.close();
    }
  }

  private ended(service: RunningHostedService): void {
    if (this.service !== service) return;
    this.lastPow = service.pow;
    this.service = null;
    this.state = 'closed';
    this.push();
  }

  private push(): void {
    this.lastPush = this.now();
    const status = this.status();
    for (const { peer } of this.peers.values()) peer.post({ t: 'status', status });
  }

  private startTick(): void {
    if (this.tick !== null) return;
    const every = this.deps.tickMs ?? 1000;
    this.tick = (this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms)))(() => this.onTick(), every);
  }

  private stopTick(): void {
    if (this.tick === null) return;
    (this.deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.tick);
    this.tick = null;
  }

  private onTick(): void {
    const now = this.now();
    const stale = this.deps.staleMs ?? 15_000;
    for (const [id, entry] of [...this.peers]) {
      if (now - entry.lastSeen > stale) this.detach(id);
    }
    if (this.peers.size > 0 && this.state === 'online' && now - this.lastPush >= (this.deps.statusMs ?? 3000)) this.push();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private setTimeout(fn: () => void, ms: number): unknown {
    return (this.deps.setTimeout ?? ((f, t) => setTimeout(f, t)))(fn, ms);
  }

  private clearTimeout(handle: unknown): void {
    (this.deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }
}
