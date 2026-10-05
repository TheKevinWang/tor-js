import type { Log } from './Log.js';
import type { TorStorage } from '#wasm';
import type { ArtiSocketProvider } from './socketProvider.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * Options for creating a TorClient.
 *
 * In browsers, provide a gateway KPS address for relay tunneling and fast
 * bootstrap. In Node.js/Deno, the client connects via direct TCP without a
 * gateway; providing one enables fast bootstrap and gateway fallback (which
 * additionally requires the optional `@kpstreams/quic-client` package).
 */
export type TorClientOptions = {
  /**
   * Paying proof of work when an onion service asks for it. An onion service that is busy asks visitors
   * to prove they did some computation and serves the ones who did the most first; by default this client
   * does the work, on worker threads (Web Workers in a page, `worker_threads` in Node), when it is created
   * where those exist, and otherwise connects without offering any (served last, as before). It never
   * replaces a solver that is already installed, and the solver is shared by every client in the same page
   * or process, so the settings of the first client apply. `false` turns it off.
   *
   * - `maxEffort`: the most effort to pay; default 2000 (about 4 minutes of one core; workers divide it).
   * - `minEffort`: the least effort to pay whenever the service uses proof of work, even if it asks for none;
   *   default 0. Paying more than asked gets priority over visitors who pay less.
   * - `workers`: workers per puzzle; default one less than the core count, at most 8.
   * - `workerUrl`: the worker script, if not the one shipped next to this module.
   */
  pow?: false | { workers?: number; maxEffort?: number; minEffort?: number; workerUrl?: string };

  /**
   * Gateway KPS address(es) (`ip:port:certhash`, e.g.
   * `"198.51.100.7:12298:uEiAxk...9Qw"` — printed by tor-js-gateway at
   * startup). Pass several redundant gateways to fail over and spread load
   * between them; the list is an unordered set, so position implies no
   * priority. Required in browsers for relay connections; optional in
   * Node.js/Deno.
   */
  gateway?: string | string[];

  /**
   * Optional logger instance.
   * Note: WASM logging is global, so all TorClient instances receive all WASM
   * log events, not just their own. This is because wasm-bindgen generates a
   * single module-level instance (`let wasm;`), so all Rust global state
   * (including the tracing subscriber) is shared.
   */
  log?: Log;

  /** Optional storage for persistent state (implements TorStorage). */
  storage?: TorStorage;

  /**
   * Minimum log level for this client's log listener. Defaults to 'debug'.
   * Can be changed at runtime via `TorClient.setLogLevel()`.
   * The WASM subscriber auto-widens to the broadest level across all clients.
   */
  logLevel?: LogLevel;

  /** Optional custom socket provider. When set, overrides the default ArtiSocketProvider created from the gateway address. */
  socketProvider?: ArtiSocketProvider;

  /**
   * Reach Tor through Tor Project's Snowflake service instead of a gateway.
   * Works in browsers with no server of your own. `true` or `'websocket'`
   * connects straight to the Snowflake server (fast; also works in Node);
   * `'webrtc'` goes through a volunteer proxy found by the Snowflake broker
   * (the standard Snowflake path; needs `RTCPeerConnection`). Shorthand for
   * `bridges: SNOWFLAKE_BRIDGES` / `SNOWFLAKE_WEBRTC_BRIDGES`; combined with
   * `bridges`, both lists are used.
   */
  snowflake?: boolean | 'websocket' | 'webrtc';

  /**
   * Where the Snowflake WebRTC carrier (`snowflake: 'webrtc'`) gets its
   * `RTCPeerConnection` when the global one does not exist, as in a worker.
   * The site adapter's host worker passes one that borrows a page's.
   */
  rtcPeerFactory?: RtcPeerFactory;

  /**
   * Bridges to use as the only guards, in Tor `Bridge` line syntax without the
   * `Bridge` keyword, e.g. `snowflake 192.0.2.3:80 <fingerprint> ws=wss://...`.
   * The `snowflake` transport is built in; plain bridges (`ip:port fingerprint`)
   * are dialed through the socket provider like any relay.
   */
  bridges?: string[];

  /**
   * URL of a directory snapshot (`bootstrap.zip` or `bootstrap.zip.zst`, the
   * format tor-js-gateway serves) fetched with plain `fetch()` to pre-fill an
   * empty directory cache. Lets a static site host the snapshot next to the
   * page so a first visit skips downloading the directory over a bridge. The
   * documents are verified as if fetched from the network, so the host need
   * not be trusted. Takes precedence over the gateway's snapshot.
   */
  bootstrapUrl?: string;
};

/**
 * A byte stream to a WebRTC data channel hosted elsewhere: WHATWG streams of
 * `Uint8Array` plus `close()`, the same shape as a relay socket.
 */
export interface RtcSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}

/**
 * One WebRTC peer connection hosted outside the Tor client's own context, for
 * the Snowflake WebRTC carrier. Workers have no `RTCPeerConnection`, so the
 * client can borrow one from a page (see `tor-js/site`). The client does the
 * broker exchange itself; the peer only does what needs the browser object.
 */
export interface RtcPeer {
  /** Create the peer connection and its data channel, gather ICE candidates, return the offer SDP. */
  offer(stunUrls: string[]): Promise<string>;
  /** Apply the broker's answer SDP; resolve with the channel's bytes once it is open, reject if it does not open. */
  open(answerSdp: string): Promise<RtcSocket>;
  close(): void;
}

export type RtcPeerFactory = () => Promise<RtcPeer>;

export type { TorStorage } from '#wasm';

/**
 * The `Response` from `TorClient.fetch()`. `rawHeaders` lists every response
 * header exactly as received (name lower-cased, repeats kept), including ones a
 * `Response` never exposes to script, chiefly `Set-Cookie`.
 */
export type TorResponse = Response & { rawHeaders?: [string, string][] };

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}
