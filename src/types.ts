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
   * Works in browsers with no server of your own. Shorthand for
   * `bridges: SNOWFLAKE_BRIDGES`; combined with `bridges`, both lists are used.
   */
  snowflake?: boolean;

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

export type { TorStorage } from '#wasm';

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}
