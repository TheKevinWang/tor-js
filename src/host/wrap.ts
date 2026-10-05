// Turns the WASM's `OnionListener` and `OnionConnection` (crates/tor-js-wasm/src/host.rs) into the
// public `Listener` and `Connection` (types.ts). Kept free of WASM imports so it is unit-tested
// with plain fake objects (test/unit/hostWrap.test.mjs).
//
// The WASM objects own memory on the Rust side that JavaScript must hand back with `free()`, and a
// connection that is never freed keeps counting against the listener's `maxConnections`. So:
// closing a connection finishes sending and then frees it, and closing a listener frees it too.

import type { Connection, Listener, PowStats } from './types.js';

/** What the WASM's `OnionConnection` offers. */
export interface RawConnection {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  free(): void;
}

/** What the WASM's `OnionListener` offers. */
export interface RawListener {
  readonly onion: string;
  powStats(): PowStats;
  accept(): Promise<RawConnection | null>;
  close(): void;
  free(): void;
}

export function wrapConnection(raw: RawConnection): Connection {
  let released = false;
  return {
    async read() {
      if (released) return null;
      return raw.read();
    },
    async write(chunk) {
      if (released) throw new Error('connection is closed');
      await raw.write(chunk);
    },
    async close() {
      if (released) return;
      released = true;
      try {
        await raw.close();
      } finally {
        raw.free();
      }
    },
  };
}

export function wrapListener(raw: RawListener, identity: Uint8Array, onClose?: (l: Listener) => void): Listener {
  let closed = false;
  let lastPow: PowStats | undefined;
  const listener: Listener = {
    onion: raw.onion,
    identity,
    get pow() {
      // After close() the WASM object is freed: answer with the reading taken just before.
      return closed && lastPow ? lastPow : raw.powStats();
    },
    async accept() {
      if (closed) return null;
      const connection = await raw.accept();
      return connection === null ? null : wrapConnection(connection);
    },
    close() {
      if (closed) return;
      closed = true;
      onClose?.(listener);
      lastPow = raw.powStats();
      raw.close();
      // A pending accept() already holds what it needs on the Rust side and resolves to null.
      raw.free();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const connection = await listener.accept();
        if (connection === null) return;
        yield connection;
      }
    },
  };
  return listener;
}
