/**
 * The host's half of solving proof-of-work puzzles through a page (the page's half is powPage.ts):
 * a solver, with the same shape as the pool's, that asks a page to run the pool.
 *
 * Used where the Tor client cannot start workers itself, which is a SharedWorker. See powPage.ts
 * for the protocol.
 */

import type { PowPageOptions } from './powPage.js';
import type { PowSolution, PowSolver } from './powPool.js';

export interface PowRelayOptions {
  /** Ask a page for a port to solve one puzzle on; the options are sent along with the request. */
  acquirePort: (extra: { options: PowPageOptions }) => Promise<MessagePort>;
  /** The pool's settings, which the page uses. */
  pool: PowPageOptions;
  /** Give up on a page that never answers after this long (ms); default 11 minutes (the page stops at 10). */
  timeoutMs?: number;
}

export function createRemotePowSolver(options: PowRelayOptions): PowSolver {
  return async (blindId, seed, effort, signal) => {
    if (signal?.aborted) throw new Error('proof-of-work solve cancelled');
    const port = await options.acquirePort({ options: options.pool });
    return new Promise<PowSolution>((resolve, reject) => {
      let settled = false;
      const finish = (end: () => void, cancel: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cancel) {
          try { port.postMessage({ t: 'cancel' }); } catch { /* the page is gone */ }
        }
        try { port.close(); } catch { /* already closed */ }
        end();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error('the page did not return a proof-of-work solution in time')), true),
        options.timeoutMs ?? 11 * 60_000,
      );
      signal?.addEventListener('abort', () => finish(() => reject(new Error('proof-of-work solve cancelled')), true), { once: true });
      port.onmessage = (event: MessageEvent) => {
        const msg = event.data as { t?: string; solution?: PowSolution; message?: string } | null;
        if (msg?.t === 'solved' && msg.solution) finish(() => resolve(msg.solution as PowSolution), false);
        else if (msg?.t === 'error') finish(() => reject(new Error(msg.message ?? 'the page failed to solve the puzzle')), false);
      };
      try {
        port.postMessage({ t: 'solve', blindId, seed, effort });
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))), false);
      }
    });
  };
}
