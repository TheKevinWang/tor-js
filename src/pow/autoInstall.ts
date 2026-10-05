/**
 * Let a plain `TorClient` pay proof of work by default (see .agent/visitor-pays-by-default-execplan.md).
 *
 * When the Tor client connects to an onion service that asks for proof of work it calls
 * `globalThis.__torJsPowSolve(blindId, seed, effort)` (see install.ts and the vendored tor-hsclient's
 * `v1_wasm.rs`). The site adapter installs a solver for its pages; this installs one for everyone else,
 * when a client is created, in a page (a pool of Web Workers) or in Node (a pool of worker threads).
 * Where workers cannot be started (a SharedWorker, a Service Worker) nothing is installed and the client
 * connects without a solution, as before.
 *
 * It never replaces a solver that is already installed (the site adapter's, or an application's own),
 * and installs at most once per realm: the Tor client finds the solver through global names, so every
 * client in a realm shares it. A count of the clients that asked for it removes it when the last closes.
 * Everything that needs a worker location, the WASM or a worker is done on first use, never in the
 * constructor: some realms that bundle this code (the anon-rpc worker) have no `import.meta.url`.
 */

import { installSolverFunction, type PowSettings } from './install.js';
import { createPowSolver, type PowSolver, type PowWorkerLike } from './powPool.js';
import { createNodeWorkerFactory } from './nodeWorkers.js';

/** How `TorClientOptions.pow` is written. */
export interface ClientPowOptions extends PowSettings {
  /** How many workers to start per puzzle; default one less than the core count, at most 8. */
  workers?: number;
  /** URL of the worker script; default the one shipped next to this module. */
  workerUrl?: string;
}

/** Where the WASM can be had: a URL a worker can load, and always its bytes. */
export interface WasmLocation {
  url?: string;
  /** "host" when the WASM is the build that can host an onion service (its glue differs). */
  variant?: 'host';
  bytes(): Promise<Uint8Array>;
}

export type Realm = 'node' | 'browser' | 'none';

/** What differs between realms, and the parts a test replaces. */
export interface AutoInstallDeps {
  /** The object the Tor client looks the solver up on (the realm's global). */
  globals?: object;
  /** Which kind of realm this is. */
  realm?: () => Realm;
  /** Where the worker script is by default (`undefined`: unknown, so no solver can be built). */
  defaultWorkerUrl?: (realm: Realm) => string | undefined;
  /** Starts a worker at a URL. */
  workerFactory?: (realm: Realm) => Promise<(url: string) => PowWorkerLike>;
  /** Makes URLs from bytes and reads scripts (browser only). */
  blobs?: {
    fromBytes(bytes: Uint8Array, type: string): string;
    fromScript(url: string): Promise<string>;
    sameOrigin(url: string): boolean;
  };
}

type G = { __torJsPowSolve?: unknown };

export function detectRealm(): Realm {
  const g = globalThis as { process?: { versions?: { node?: string } }; Worker?: unknown };
  if (typeof g.process?.versions?.node === 'string') return 'node';
  if (typeof g.Worker === 'function') return 'browser';
  return 'none';
}

function defaultWorkerUrl(realm: Realm): string | undefined {
  try {
    // Every entry point sits two directories below dist/, next to site/ and pow-node-worker.js.
    return realm === 'node'
      ? new URL('../../pow-node-worker.js', import.meta.url).href
      : new URL('../../pow-worker.js', import.meta.url).href;
  } catch {
    return undefined; // no import.meta.url here
  }
}

const browserBlobs: NonNullable<AutoInstallDeps['blobs']> = {
  fromBytes: (bytes, type) => URL.createObjectURL(new Blob([bytes as BlobPart], { type })),
  fromScript: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cannot load the proof-of-work worker script: HTTP ${res.status}`);
    return res.text();
  },
  sameOrigin: (url) => {
    try { return new URL(url, (globalThis as { location?: { href: string } }).location?.href).origin === (globalThis as { location?: { origin: string } }).location?.origin; } catch { return false; }
  },
};

// The solver this module installed, shared by every client in the realm.
let shared: { count: number; remove: () => void } | null = null;

/**
 * Install the default solver for a client, unless `settings` is `false`, a solver is already installed,
 * or this realm cannot start workers. Returns a function to call when the client closes.
 */
export function installClientPow(
  settings: ClientPowOptions | false | undefined,
  wasm: () => WasmLocation,
  deps: AutoInstallDeps = {},
): () => void {
  const noop = () => {};
  if (settings === false) return noop;
  const globals = deps.globals ?? globalThis;
  const realm = (deps.realm ?? detectRealm)();
  if (realm === 'none') return noop;

  if (shared) {
    // Ours, already installed for another client: share it.
    shared.count++;
    return release();
  }
  if (typeof (globals as G).__torJsPowSolve === 'function') return noop; // someone else's: leave it

  const options = settings ?? {};
  let solver: Promise<PowSolver> | null = null;
  const build = async (): Promise<PowSolver> => {
    const location = wasm();
    const workerUrl = options.workerUrl ?? (deps.defaultWorkerUrl ?? defaultWorkerUrl)(realm);
    if (!workerUrl) throw new Error('no location for the proof-of-work worker script: pass `pow.workerUrl`');
    const blobs = deps.blobs ?? browserBlobs;
    let scriptUrl = workerUrl;
    let wasmUrl = location.url;
    let wasmBytes: Uint8Array | undefined;
    if (realm === 'browser') {
      // A Worker cannot be started from another origin's script: run its text from a blob instead.
      if (!blobs.sameOrigin(workerUrl)) scriptUrl = blobs.fromBytes(new TextEncoder().encode(await blobs.fromScript(workerUrl)), 'text/javascript');
      // Give workers a URL to load the WASM from; make one from the bytes when there is none.
      if (!wasmUrl) wasmUrl = blobs.fromBytes(await location.bytes(), 'application/wasm');
    } else if (!wasmUrl || !wasmUrl.startsWith('file:')) {
      // Node reads file: URLs itself; anything else is sent as bytes.
      wasmBytes = await location.bytes();
      wasmUrl = wasmUrl ?? 'bytes:';
    }
    const createWorker = realm === 'node'
      ? await (deps.workerFactory ?? (() => createNodeWorkerFactory()))(realm)
      : await (deps.workerFactory?.(realm) ?? Promise.resolve((url: string) => new (globalThis as unknown as { Worker: new (url: string) => PowWorkerLike }).Worker(url)));
    return createPowSolver({ workerUrl: scriptUrl, wasmUrl: wasmUrl!, wasmBytes, variant: location.variant, workers: options.workers, createWorker });
  };
  const solve = async (blindId: Uint8Array, seed: Uint8Array, effort: number) => {
    solver ??= build();
    try {
      return await (await solver)(blindId, seed, effort);
    } catch (e) {
      solver = null; // try again next time (a failure to set up may be temporary)
      throw e;
    }
  };

  const remove = installSolverFunction(solve, options, globals);
  shared = { count: 1, remove };
  return release();
}

/** The function a client calls when it closes: once only. */
function release(): () => void {
  let done = false;
  return () => {
    if (done || !shared) return;
    done = true;
    if (--shared.count <= 0) {
      shared.remove();
      shared = null;
    }
  };
}

/** For tests: forget the shared install. */
export function resetClientPowForTests(): void {
  shared?.remove();
  shared = null;
}
