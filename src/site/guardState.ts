/**
 * Arti remembers how each guard has behaved and saves that in storage
 * (`state:guards`). With a Snowflake bridge as the only guard this is a trap:
 * a few runs in which circuits through a slow volunteer proxy timed out are
 * counted as failures, and once the failure ratio passes a threshold arti marks
 * the bridge `"disabled": { "type": "TooManyIndeterminateFailures", ... }`. A
 * disabled guard is never dialled, and the mark is saved, so every later page
 * load starts with no usable guard and sits silent. (Seen in a real browser
 * profile: 0 successes, 5 failures, 15 indeterminate, ratio 1.0 against a
 * threshold of 0.7, and no dial for over a minute.)
 *
 * The slowness that caused the failures belongs to that run's proxy, not to the
 * bridge, so the mark is dropped whenever the saved state is read.
 */

import type { TorStorage } from '#wasm';

const GUARDS_KEY = 'state:guards';

/** The saved guard state with the `disabled` mark removed from every bridge guard. Unparseable input is returned unchanged. */
export function sanitizeGuardState(json: string): string {
  let state: { bridges?: { guards?: Array<Record<string, unknown>> } };
  try {
    state = JSON.parse(json);
  } catch {
    return json;
  }
  const guards = state?.bridges?.guards;
  if (!Array.isArray(guards)) return json;
  let changed = false;
  for (const g of guards) {
    if (g && typeof g === 'object' && 'disabled' in g) {
      delete g.disabled;
      changed = true;
    }
  }
  return changed ? JSON.stringify(state, null, 2) : json;
}

/** A storage that hands arti the guard state without any bridge's `disabled` mark. Everything else passes through. */
export function withSanitizedGuards(inner: TorStorage): TorStorage {
  return {
    async get(key) {
      const v = await inner.get(key);
      return key === GUARDS_KEY && v !== null ? sanitizeGuardState(v) : v;
    },
    async getAll(prefix) {
      const all = await inner.getAll(prefix);
      return all.map(([k, v]) => [k, k === GUARDS_KEY ? sanitizeGuardState(v) : v] as [string, string]);
    },
    set: (key, value) => inner.set(key, value),
    delete: (key) => inner.delete(key),
    keys: (prefix) => inner.keys(prefix),
    tryLock: () => inner.tryLock(),
    unlock: () => inner.unlock(),
  };
}
