/**
 * Make `globalThis.__torJsPowSolve` the pool of Web Workers, so that the Tor client in this
 * realm can solve an onion service's proof-of-work puzzles (see powPool.ts for the whole story).
 *
 * The Tor client looks these globals up when it needs to solve a puzzle, so it works in
 * whichever realm the WASM runs in (a worker host, a page), for every client in it.
 */

import { createPowSolver, type PowSolver, type PowSolverOptions } from './powPool.js';
import { createRemotePowSolver, type PowRelayOptions } from './powRelay.js';

export interface PowSettings {
  /** The most effort this client will pay; default 2000 (arti's own cap is 10000). */
  maxEffort?: number;
  /** The least effort to pay whenever the service uses proof of work, even if it asks for none; default 0. */
  minEffort?: number;
}

type PowGlobals = {
  __torJsPowSolve?: (blindId: Uint8Array, seed: Uint8Array, effort: number) => Promise<unknown>;
  __torJsPowConfig?: PowSettings;
};

/** Whether this realm can start workers, which the pool needs. */
export function canSolveProofOfWork(): boolean {
  return typeof (globalThis as { Worker?: unknown }).Worker === 'function';
}

/**
 * Install a solver. Returns a function that removes it again.
 *
 * Where workers can be started (a page, a dedicated worker, Node with `createWorker`), the pool is
 * used directly. Where they cannot (a SharedWorker has no `Worker` in Chromium, nor does a Service
 * Worker), `acquirePort` asks a page to run the pool (powRelay.ts, powPage.ts; for a Service Worker,
 * clientRelay.ts). With neither, nothing is installed and the Tor client connects without offering a
 * solution, as before.
 */
export function installPowSolver(
  options: PowSolverOptions & PowSettings & { acquirePort?: PowRelayOptions['acquirePort'] },
): () => void {
  const local = !!options.createWorker || canSolveProofOfWork();
  if (!local && !options.acquirePort) return () => {};
  const solve: PowSolver = local
    ? createPowSolver(options)
    : createRemotePowSolver({
      acquirePort: options.acquirePort!,
      pool: { workerUrl: options.workerUrl, wasmUrl: options.wasmUrl, workers: options.workers },
    });
  return installSolverFunction(solve, options);
}

/**
 * Make `solve` the function the Tor client calls to solve a puzzle, with these settings. Returns a function
 * that puts back whatever was there before. `globals` is where the Tor client looks (the realm's global).
 */
export function installSolverFunction(
  solve: (blindId: Uint8Array, seed: Uint8Array, effort: number) => Promise<unknown>,
  settings: PowSettings,
  globals: object = globalThis,
): () => void {
  const g = globals as PowGlobals;
  const previous = { solve: g.__torJsPowSolve, config: g.__torJsPowConfig };
  g.__torJsPowSolve = (blindId, seed, effort) => solve(blindId, seed, effort);
  g.__torJsPowConfig = { maxEffort: settings.maxEffort, minEffort: settings.minEffort };
  return () => {
    g.__torJsPowSolve = previous.solve;
    g.__torJsPowConfig = previous.config;
  };
}
