// Types for hosting an onion service.

/** Options for {@link TorClient.listen} and {@link TorClient.serve}. */
export interface ListenOptions {
  /**
   * The service's identity: 32 secret bytes that decide its `.onion` address. Keep them (in
   * IndexedDB, a file, ...) to host at the same address again; anyone who has them can host as
   * you. If omitted, a fresh identity is made and returned as `listener.identity`.
   */
  identity?: Uint8Array;
  /** Ports visitors may connect to (default `[80]`, what an `http://` URL uses). Others are refused. */
  ports?: number[];
  /** The most visitors held open at once (default 32). More are refused. */
  maxConnections?: number;
  /**
   * Proof of work, a defence against floods (default on). The service publishes a puzzle; when it
   * is busy it asks visitors for effort and serves the highest effort first, and a visitor that
   * pays nothing still connects while the service is idle. `{ queueDepth }` sets how many waiting
   * requests are kept (default 256); when full, the lowest effort is dropped. `false` turns it off.
   */
  proofOfWork?: boolean | { queueDepth?: number };
}

/** What a service's proof of work has done so far (see {@link Listener.pow}). */
export interface PowStats {
  /** Whether proof of work is on for this service. */
  enabled: boolean;
  /** Solutions that checked out. */
  verified: number;
  /** Solutions refused: unknown or expired seed, a replayed nonce, a malformed or wrong solution. */
  rejected: number;
  /** Requests put on the priority queue. */
  enqueued: number;
  /** Requests removed from the queue unserved: queue full, or too old. */
  dropped: number;
  /** Requests waiting on the queue now. */
  queueLength: number;
  /** The effort the service currently asks visitors for (0 when it is not busy). */
  suggestedEffort: number;
  /** The largest effort seen in a verified solution. */
  maxEffortSeen: number;
}

/** One visitor: a duplex byte stream, end-to-end encrypted with them. */
export interface Connection {
  /** The next bytes (at most 16 KiB), or `null` once the visitor has closed its end. */
  read(): Promise<Uint8Array | null>;
  /** Send bytes to the visitor; resolves once they are handed to the circuit. */
  write(chunk: Uint8Array): Promise<void>;
  /**
   * Finish sending and release the connection: the visitor sees the end of the stream, and
   * reading is no longer possible. Always call it when done; an unreleased connection keeps
   * counting against `maxConnections`.
   */
  close(): Promise<void>;
}

/** A hosted onion service. */
export interface Listener extends AsyncIterable<Connection> {
  /** The service's address: `<56 characters>.onion`. Visitors use `http://<onion>/` for HTTP. */
  readonly onion: string;
  /** The identity this service was started with (see {@link ListenOptions.identity}). */
  readonly identity: Uint8Array;
  /** What proof of work has done so far; read it again for fresh numbers. After `close()`, the final reading. */
  readonly pow: PowStats;
  /** The next visitor, or `null` once the listener is closed. */
  accept(): Promise<Connection | null>;
  /** Take the service offline. Connections already open stay open until their ends close. */
  close(): void;
}

/** Limits that protect a host from visitors that send too much or too slowly. */
export interface ServeLimits {
  /** Largest request line plus headers accepted, in bytes (default 16384; over it gets 431). */
  maxHeadBytes?: number;
  /** Largest request body accepted, in bytes (default 1048576; over it gets 413). */
  maxBodyBytes?: number;
  /** How long a visitor may take to send a complete request head, in ms (default 30000). */
  headTimeoutMs?: number;
  /** How long a visitor may take to send the body once the head is in, in ms (default 60000). */
  bodyTimeoutMs?: number;
}

/** A request handler, as for `fetch` servers: build a `Response` from a `Request`. */
export type Handler = (request: Request) => Response | Promise<Response>;
