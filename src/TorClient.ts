import {
  ensureWasmInitialized,
  WasmTorClient,
  WasmTorClientOptions,
  addLogListener,
  setListenerLevel,
  wasmOnionAddressFor,
  hostingAvailable,
  getWasmLocation,
} from './wasm.js';
import { installClientPow } from './pow/autoInstall.js';
import { HostingUnavailableError } from './host/unavailable.js';
import type { TorClientOptions, FetchInit, LogLevel, TorResponse } from './types.js';
import { Log, levelEnabled } from './Log.js';
import { createAutoStorage } from './storage/index.js';
import { abortable } from './abort.js';
import { ArtiSocketProvider } from './socketProvider.js';
import { SNOWFLAKE_BRIDGES, SNOWFLAKE_WEBRTC_BRIDGES } from './snowflake.js';
import type { Handler, Listener, ListenOptions, ServeLimits } from './host/types.js';
import { serve as serveHttp } from './host/http.js';
import { wrapListener, type RawListener } from './host/wrap.js';

function bridgeLines(options: TorClientOptions): string[] {
  const snowflake = options.snowflake === 'webrtc' ? SNOWFLAKE_WEBRTC_BRIDGES
    : options.snowflake ? SNOWFLAKE_BRIDGES
    : [];
  return [...snowflake, ...(options.bridges ?? [])];
}

function isBrowser(): boolean {
  const g = globalThis as any;
  const hasNode = typeof g.process?.versions?.node !== 'undefined';
  const hasDeno = typeof g.Deno !== 'undefined';
  return !hasNode && !hasDeno && typeof g.window !== 'undefined';
}

export class TorClient {
  private log: Log;
  // This client's level, as given to its log listener (whose default is
  // 'debug'). Also applied to the JS-side console output below.
  private logLevel: LogLevel;
  private clientPromise: Promise<WasmTorClient>;
  private removeLogListener: (() => void) | null = null;
  private wasmCallback: ((level: string, target: string, message: string) => void) | null = null;
  private closed = false;
  private readyPromise: Promise<void> | null = null;
  private socketProvider: ArtiSocketProvider | null = null;
  // Gives back the proof-of-work solver this client asked for (see TorClientOptions.pow).
  private releasePow: (() => void) | null = null;
  // Onion services this client hosts; closed with it.
  private listeners = new Set<Listener>();

  constructor(options: TorClientOptions = {}) {
    const hasGateway = Array.isArray(options.gateway)
      ? options.gateway.length > 0
      : !!options.gateway;
    if (isBrowser() && !hasGateway && !options.socketProvider && bridgeLines(options).length === 0) {
      throw new Error(
        'TorClient: in the browser, you must configure a gateway (KPS address "ip:port:certhash") ' +
        'or `snowflake: true`, because browsers can\'t open regular TCP sockets.',
      );
    }
    // Default to a discarding sink so a library never spams a host page's
    // console — but not when the caller has explicitly asked for a log level.
    // `logLevel` only sets the wasm-side tracing filter, so pairing it with the
    // discarding default made arti generate every line and then throw them all
    // away, which reads as "logging is broken".
    //
    // One-time warnings (Log.warnOnce, e.g. a demo gateway) are meant for a
    // person, so the silent default still sends those to the console. A custom
    // `log` gets them like any other line.
    this.logLevel = options.logLevel ?? 'debug';
    const toConsole = (level: LogLevel, ...args: unknown[]) => {
      if (levelEnabled(level, this.logLevel)) console[level](...args);
    };
    this.log = options.log
      ?? (options.logLevel
        ? new Log({ rawLog: toConsole })
        : new Log({ rawLog: () => {}, rawLogOnce: toConsole }));
    this.clientPromise = this.bootstrap(options);
    // Pay proof of work when a service asks, unless told not to (nothing is started until a puzzle comes).
    this.releasePow = installClientPow(options.pow, getWasmLocation);
    // Bootstrap starts immediately, so a failure has no awaiter until the first
    // fetch()/ready(). Attach a sink to keep that from surfacing as an unhandled
    // rejection (fatal in Node); the error still reaches every real awaiter.
    this.clientPromise.catch(() => {});
  }

  private async bootstrap(options: TorClientOptions): Promise<WasmTorClient> {
    await ensureWasmInitialized();

    // Register log listener with per-client level filtering.
    // The WASM subscriber auto-widens to the broadest level across all listeners.
    this.wasmCallback = this.log._makeWasmCallback();
    this.removeLogListener = addLogListener(this.wasmCallback, options.logLevel);

    // ArtiSocketProvider handles relay connections. In browsers it needs a
    // gateway KPS address ("ip:port:certhash") for tunneling; in Node.js/Deno
    // it connects via direct TCP.
    this.socketProvider = options.socketProvider
      ?? new ArtiSocketProvider({ gateway: options.gateway, log: this.log });
    const sp = this.socketProvider;

    let wasmOptions = new WasmTorClientOptions(
      (addr: string) => sp.connect(addr),
    );

    const storage = options.storage ?? createAutoStorage();
    wasmOptions = wasmOptions.withStorage(storage);

    // Bridges (Snowflake included) become the only guards; their transports
    // run inside the WASM module.
    const bridges = bridgeLines(options);
    if (bridges.length > 0) {
      wasmOptions = wasmOptions.withBridges(bridges, undefined);
    }

    // Workers have no RTCPeerConnection; a factory lets the WebRTC carrier
    // borrow one from a page.
    if (options.rtcPeerFactory) {
      wasmOptions = wasmOptions.withPeerFactory(options.rtcPeerFactory);
    }

    // Auto-attempt fast bootstrap from gateway — only when one is configured.
    // The archive is zstd-compressed; the WASM side decompresses it.
    // Go through the provider rather than capturing a gateway: it picks per
    // attempt (one gateway on the happy path) and falls over if that one is
    // down, instead of silently degrading to slow bootstrap.
    const bootstrapUrl = options.bootstrapUrl;
    if (bootstrapUrl) {
      wasmOptions = wasmOptions.withFastBootstrap(async (): Promise<Uint8Array> => {
        this.log.info(`Fast bootstrap: fetching ${bootstrapUrl}...`);
        const res = await fetch(bootstrapUrl);
        if (!res.ok) {
          throw new Error(`Fast bootstrap fetch failed: ${res.status} ${res.statusText}`);
        }
        const body = new Uint8Array(await res.arrayBuffer());
        this.log.info(`Fast bootstrap: received ${body.byteLength} bytes`);
        return body;
      });
    } else if (sp.gateway) {
      wasmOptions = wasmOptions.withFastBootstrap(async (): Promise<Uint8Array> => {
        this.log.info('Fast bootstrap: fetching bootstrap.zip.zst...');
        const res = await sp.gatewayFetch('/bootstrap.zip.zst');
        if (res.status !== 200) {
          throw new Error(`Fast bootstrap fetch failed: ${res.status} ${res.statusText}`);
        }
        this.log.info(`Fast bootstrap: received ${res.body.byteLength} bytes (compressed)`);
        return res.body;
      });
    }

    // Create client (WASM constructor returns a Promise)
    this.log.info('Bootstrapping...');
    const client = await WasmTorClient.create(wasmOptions);
    this.log.info('Bootstrap complete');
    return client;
  }

  /**
   * Make an HTTP fetch request through Tor.
   * Returns a standard browser Response object.
   */
  async fetch(url: string, init?: FetchInit): Promise<TorResponse> {
    if (this.closed) throw new Error('TorClient is closed');
    // Bootstrap and readiness are shared by every caller, so an abort ends only
    // this caller's wait for them; the WASM fetch then honours the signal itself.
    const signal = init?.signal;
    const client = await abortable(this.clientPromise, signal);
    await abortable(this.ready(), signal);
    this.log.info(`Fetching ${url}`);
    return client.fetch(url, init) as Promise<TorResponse>;
  }

  /**
   * Host an onion service and receive its visitors as raw byte streams.
   *
   * Resolves once the service is launched, with the address in `listener.onion`. The service is
   * not yet reachable then: it still has to set up introduction points and publish itself, which
   * takes from seconds to a few minutes. It stays up while this client and the page or process
   * are running; closing the tab takes it offline.
   *
   * Pass `identity` (32 secret bytes, see `TorClient.generateIdentity()`) to host at the same
   * address again; without it a fresh identity is made and returned as `listener.identity` so
   * the caller can keep it. Anyone who has the identity can host as you.
   *
   * For HTTP use `serve()` instead.
   */
  async listen(options: ListenOptions = {}): Promise<Listener> {
    if (!hostingAvailable()) throw new HostingUnavailableError();
    if (this.closed) throw new Error('TorClient is closed');
    const identity = options.identity ?? TorClient.generateIdentity();
    const client = await this.clientPromise;
    await this.ready();
    if (this.closed) throw new Error('TorClient is closed');
    this.log.info('Starting onion service');
    // Only the host build of the WASM has `listen` (the default build's typings do not), so it is
    // called through its own shape; hostingAvailable() above made sure it is there.
    const hostClient = client as unknown as { listen(options: unknown): Promise<RawListener> };
    const raw = await hostClient.listen({
      identity,
      ports: options.ports,
      maxConnections: options.maxConnections,
      proofOfWork: options.proofOfWork,
    });
    const listener = wrapListener(raw, identity, (l) => this.listeners.delete(l));
    this.listeners.add(listener);
    this.log.info(`Onion service started: ${listener.onion}`);
    return listener;
  }

  /**
   * Host an onion service that answers HTTP requests with `handler`, as a `fetch` handler
   * does: it gets a standard `Request` and returns a `Response`.
   *
   * Visitors use `http://<listener.onion>/` (plain HTTP is fine: the connection to an onion
   * service is already encrypted end to end), for example another tor-js client's `fetch`, or
   * Tor Browser. Takes the same options as `listen()`, plus limits on request size and time
   * (`ServeLimits`). `listener.done` resolves when the service has been closed.
   */
  async serve(handler: Handler, options: ListenOptions & ServeLimits = {}): Promise<Listener & { done: Promise<void> }> {
    const { maxHeadBytes, maxBodyBytes, headTimeoutMs, bodyTimeoutMs, ...listenOptions } = options;
    const listener = await this.listen(listenOptions);
    const done = serveHttp(listener, handler, { maxHeadBytes, maxBodyBytes, headTimeoutMs, bodyTimeoutMs });
    return Object.assign(listener, { done });
  }

  /** Make a new random onion service identity: 32 secret bytes. Keep them safe. */
  static generateIdentity(): Uint8Array {
    const identity = new Uint8Array(32);
    globalThis.crypto.getRandomValues(identity);
    return identity;
  }

  /** The `.onion` address an identity hosts at, without going online. */
  static async onionAddress(identity: Uint8Array): Promise<string> {
    if (!hostingAvailable()) throw new HostingUnavailableError();
    await ensureWasmInitialized();
    return wasmOnionAddressFor(identity);
  }

  /**
   * Wait for the Tor client to be ready for traffic
   * (guard connected, usable consensus, and sufficient microdescs).
   *
   * Parallel callers share the same underlying promise — a single WS
   * connection failure rejects all waiters. The cached promise is cleared
   * on settle so the next call creates a fresh attempt.
   */
  async ready(): Promise<void> {
    if (this.closed) throw new Error('TorClient is closed');
    if (this.readyPromise) return this.readyPromise;

    const p = (async () => {
      const startTime = Date.now();
      this.log.info('Waiting for client');
      const client = await this.clientPromise;
      this.log.info('Waiting for client to be ready');
      await client.ready();
      this.log.info(`Client ready in ${Date.now() - startTime}ms`);
    })();

    this.readyPromise = p;
    // Clear the cache on settle via `then` with both handlers rather than
    // `finally`: `finally` returns a derived promise that would also reject, and
    // nothing awaits *that*, so a failed bootstrap became an unhandled rejection
    // on top of the error the caller already received.
    const clear = () => { this.readyPromise = null; };
    p.then(clear, clear);
    return p;
  }

  /**
   * Change the log level for this client's listener.
   * Also re-syncs the global WASM filter to the broadest level across all clients.
   */
  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
    if (this.wasmCallback) {
      setListenerLevel(this.wasmCallback, level);
    }
  }

  /**
   * Close the TorClient and release resources.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releasePow?.();
    this.releasePow = null;
    for (const listener of [...this.listeners]) listener.close();
    this.removeLogListener?.();
    this.removeLogListener = null;
    this.wasmCallback = null;
    this.socketProvider?.close();
    this.socketProvider = null;
    this.clientPromise.then(client => client.close()).catch(() => {});
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
