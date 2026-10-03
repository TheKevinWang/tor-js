/**
 * The page's half of solving proof-of-work puzzles for a Tor client that cannot start workers
 * itself (the other half is powRelay.ts).
 *
 * The site's Tor client runs in a SharedWorker when several pages share it, and a SharedWorker has
 * no `Worker` constructor in Chromium. A page does, so the host asks a page, over a `MessagePort`
 * (the same request the WebRTC peer relay makes, see peerRelay.ts `acquirePeerPort`), to run the
 * pool of workers (powPool.ts) and send back the solution:
 *
 *   Tor client (host) --- powRelay.ts ---[MessagePort]--- servePow (this file) --- Web Workers
 *
 * One port serves one puzzle. Host to page: `solve {blindId, seed, effort}`, `cancel`. Page to host:
 * `ready` (sent as soon as the port is accepted), then `solved {solution}` or `error {message}`.
 * The page also stops after {@link MAX_SOLVE_MS}, so a host that vanished without cancelling does not
 * leave workers running for ever. Workers die with the page.
 */

import { createPowSolver, type PowSolution, type PowSolverOptions } from './powPool.js';

/** The longest the page keeps solving one puzzle for a host that has not cancelled. */
export const MAX_SOLVE_MS = 10 * 60_000;

/** The pool's settings, which the host sends with its request. */
export type PowPageOptions = Pick<PowSolverOptions, 'workerUrl' | 'wasmUrl' | 'workers'>;

export interface ServePowDeps {
  /** For tests: how workers are created and how long a solve may run. */
  createWorker?: PowSolverOptions['createWorker'];
  randomBytes?: PowSolverOptions['randomBytes'];
  maxSolveMs?: number;
}

/** Puzzles being solved, by service: a new request for a service replaces an older one for it. */
const running = new Map<string, AbortController>();

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Serve one puzzle on `port` (the page end of a channel the host asked for). */
export function servePow(port: MessagePort, options: PowPageOptions, deps: ServePowDeps = {}): void {
  const solver = createPowSolver({ ...options, createWorker: deps.createWorker, randomBytes: deps.randomBytes });
  const abort = new AbortController();
  let hostCancelled = false;
  let key: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const done = () => {
    if (timer) clearTimeout(timer);
    if (key && running.get(key) === abort) running.delete(key);
    try { port.close(); } catch { /* already closed */ }
  };
  const reply = (message: unknown) => {
    try { port.postMessage(message); } catch { /* the host is gone */ }
  };

  port.onmessage = (event: MessageEvent) => {
    const msg = event.data as { t?: string; blindId?: Uint8Array; seed?: Uint8Array; effort?: number } | null;
    if (msg?.t === 'cancel') {
      hostCancelled = true;
      abort.abort();
      return done();
    }
    if (msg?.t !== 'solve') return;
    if (!(msg.blindId instanceof Uint8Array) || !(msg.seed instanceof Uint8Array) || typeof msg.effort !== 'number') {
      reply({ t: 'error', message: 'malformed proof-of-work request' });
      return done();
    }
    // The Tor client connects to one service at a time and asks again after a failed attempt,
    // so an older solve for the same service has been given up on.
    key = hex(msg.blindId) + hex(msg.seed);
    running.get(key)?.abort();
    running.set(key, abort);
    timer = setTimeout(() => abort.abort(), deps.maxSolveMs ?? MAX_SOLVE_MS);
    solver(msg.blindId, msg.seed, msg.effort, abort.signal).then(
      (solution: PowSolution) => { reply({ t: 'solved', solution }); done(); },
      // Every stop the host did not ask for is reported (a replacement by a newer solve, the time limit,
      // failed workers), or the host would wait for an answer that never comes.
      (e: unknown) => { if (!hostCancelled) reply({ t: 'error', message: e instanceof Error ? e.message : String(e) }); done(); },
    );
  };
  port.start?.();
  reply({ t: 'ready' });
}
