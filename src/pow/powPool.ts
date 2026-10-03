/**
 * Solving an onion service's proof-of-work puzzle with a pool of Web Workers.
 *
 * An onion service under attack can ask clients for a solution to a puzzle before it takes
 * their connection request. arti (the Tor client, compiled to WASM) has the solver but
 * would run it on an operating-system thread, which WASM does not have, so the vendored
 * `tor-hsclient` (crates/patches/tor-hsclient) calls `globalThis.__torJsPowSolve` instead.
 * This module is that function.
 *
 * One call starts several workers. Each loads the project's WASM (the file the host already
 * fetched, so the browser has it cached), starts at a different random nonce, and runs the
 * solver until it finds a solution (`powSolveV1`, crates/tor-js-wasm/src/pow.rs). The first
 * solution wins; the others are terminated, which stops them at once even in the middle of a
 * long step. Workers exist only while a puzzle is being solved, so a visit to a service that
 * asks for no effort starts none.
 *
 * In WASM the puzzle runs through its interpreter, about 0.13 s of one worker per unit of
 * effort, so the number of workers matters: effort 1000 is about two minutes of one worker.
 */

/** A solution as the Tor client needs it (see `v1_wasm.rs` in the vendored crate). */
export interface PowSolution {
  /** 16 bytes. */
  nonce: Uint8Array;
  effort: number;
  /** 4 bytes. */
  seedHead: Uint8Array;
  /** 16 bytes. */
  proof: Uint8Array;
}

/** The part of `Worker` the pool uses (so tests can supply a fake). */
export interface PowWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

export interface PowSolverOptions {
  /** URL of the worker script (`tor-site-pow.js`). */
  workerUrl: string;
  /** URL of the project's WASM file, which each worker loads. */
  wasmUrl: string;
  /** How many workers to start; default {@link defaultWorkerCount}. */
  workers?: number;
  /** Creates a worker; default `new Worker(url)`. */
  createWorker?: (url: string) => PowWorkerLike;
  /** Random bytes for the start nonces; default `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array;
  /** Give up after this long (ms); default none: a high effort legitimately takes minutes. */
  timeoutMs?: number;
}

/** Solves a puzzle; aborting `signal` stops the workers and rejects. */
export type PowSolver = (blindId: Uint8Array, seed: Uint8Array, effort: number, signal?: AbortSignal) => Promise<PowSolution>;

/** Messages the pool and its workers exchange. */
export type PowWorkerRequest = {
  t: 'solve';
  wasmUrl: string;
  blindId: Uint8Array;
  seed: Uint8Array;
  effort: number;
  startNonce: Uint8Array;
};
export type PowWorkerReply = { t: 'solved'; solution: PowSolution } | { t: 'error'; message: string };

/**
 * One less than the number of cores, between 1 and 8: the Tor client and the page need a core
 * too, and beyond 8 workers the gain does not justify the memory (each loads the 5 MB WASM).
 */
export function defaultWorkerCount(cores?: number): number {
  const n = cores ?? (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(8, Math.floor(n) - 1));
}

function isReply(data: unknown): data is PowWorkerReply {
  const t = (data as { t?: unknown } | null)?.t;
  return t === 'solved' || t === 'error';
}

function validSolution(s: PowSolution | undefined): s is PowSolution {
  return !!s
    && s.nonce instanceof Uint8Array && s.nonce.length === 16
    && s.seedHead instanceof Uint8Array && s.seedHead.length === 4
    && s.proof instanceof Uint8Array && s.proof.length === 16
    && Number.isFinite(s.effort) && s.effort >= 0;
}

export function createPowSolver(options: PowSolverOptions): PowSolver {
  const create = options.createWorker ?? ((url: string) => new Worker(url) as unknown as PowWorkerLike);
  const random = options.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));

  return (blindId, seed, effort, signal) => new Promise<PowSolution>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('proof-of-work solve cancelled'));
    const count = options.workers ?? defaultWorkerCount();
    const workers: PowWorkerLike[] = [];
    const failures: string[] = [];
    let alive = 0; // workers started and not yet failed
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (end: () => void) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      for (const w of workers) {
        try { w.terminate(); } catch { /* already gone */ }
      }
      end();
    };
    const failed = (reason: string, worker?: PowWorkerLike) => {
      if (finished) return;
      failures.push(reason);
      if (worker) {
        // A worker that failed is done; never count the same one twice.
        const i = workers.indexOf(worker);
        if (i >= 0) { workers.splice(i, 1); try { worker.terminate(); } catch { /* gone */ } }
      }
      alive--;
      if (alive <= 0) {
        finish(() => reject(new Error(`proof-of-work solver failed in every worker: ${failures.join('; ')}`)));
      }
    };

    for (let i = 0; i < count; i++) {
      let worker: PowWorkerLike;
      try {
        worker = create(options.workerUrl);
      } catch (e) {
        failures.push(`could not start a worker: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      workers.push(worker);
      alive++;
      worker.onmessage = (event) => {
        const data = event.data;
        if (!isReply(data)) return failed('unexpected message from a worker', worker);
        if (data.t === 'error') return failed(data.message, worker);
        if (!validSolution(data.solution)) return failed('a worker returned a malformed solution', worker);
        const solution = data.solution;
        finish(() => resolve(solution));
      };
      worker.onerror = (event) => failed(event.message ?? 'a worker failed', worker);
      const request: PowWorkerRequest = {
        t: 'solve', wasmUrl: options.wasmUrl, blindId, seed, effort, startNonce: random(16),
      };
      try {
        worker.postMessage(request);
      } catch (e) {
        failed(`could not message a worker: ${e instanceof Error ? e.message : String(e)}`, worker);
      }
    }

    if (alive === 0) {
      return finish(() => reject(new Error(failures.join('; ') || 'no workers')));
    }
    signal?.addEventListener('abort', () => finish(() => reject(new Error('proof-of-work solve cancelled'))), { once: true });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => finish(() => reject(new Error(`proof of work not solved within ${options.timeoutMs} ms`))), options.timeoutMs);
    }
  });
}
