/**
 * The routing manifest a Service Worker last validated, kept across restarts.
 *
 * Only the manifest says which requests are private (sent to the onion
 * service). Browsers stop idle Service Workers after about half a minute and
 * start them again on the next request, and each start reads the manifest
 * again. If that read fails, a worker that remembered nothing could only guess,
 * and guessing "static" would hand a private path, query and form body to the
 * static host. So the last manifest that parsed is saved, a fresh copy is
 * preferred at every start (that is how an update takes effect), and the saved
 * one is used whenever the fresh one is missing, unreachable or invalid. With
 * neither, loading fails and the worker must answer locally (see sw.ts).
 */

import type { SiteManifest } from './manifest.js';

export interface SavedManifestStore {
  /** The raw JSON of the last valid manifest, or undefined when none was saved. */
  read(): Promise<unknown>;
  write(raw: unknown): Promise<void>;
}

export interface LoadedManifest {
  manifest: SiteManifest;
  /** `network`: a fresh copy; `saved`: the last valid one, because the fresh copy could not be used. */
  source: 'network' | 'saved';
  /** Why the fresh copy was not used (set when `source` is `saved`). */
  freshError?: string;
  /** Why a fresh copy could not be saved for next time, if it could not. */
  saveError?: string;
}

export interface LoadOptions {
  /** Fetch the manifest and return its parsed JSON; throw when it cannot be had. */
  fetchFresh(): Promise<unknown>;
  /** Null where nothing can be saved (no Cache Storage). */
  store: SavedManifestStore | null;
  parse(raw: unknown): SiteManifest;
}

export async function loadRoutingManifest({ fetchFresh, store, parse }: LoadOptions): Promise<LoadedManifest> {
  let freshError: string;
  try {
    const raw = await fetchFresh();
    const manifest = parse(raw); // only a manifest that parses replaces the saved one
    let saveError: string | undefined;
    try {
      await store?.write(raw);
    } catch (e) {
      saveError = message(e);
    }
    return { manifest, source: 'network', ...(saveError ? { saveError } : {}) };
  } catch (e) {
    freshError = message(e);
  }

  let saved: unknown;
  try {
    saved = await store?.read();
  } catch (e) {
    throw new Error(`${freshError}; the saved copy could not be read either (${message(e)})`);
  }
  if (saved === undefined) throw new Error(`${freshError}; and no earlier valid manifest was saved`);
  try {
    return { manifest: parse(saved), source: 'saved', freshError };
  } catch (e) {
    throw new Error(`${freshError}; and the saved copy is not valid either (${message(e)})`);
  }
}

/** Cache Storage name for {@link cacheManifestStore}. Versioned so a future format change cannot misread an old entry. */
export const MANIFEST_CACHE = 'tor-site-manifest-v1';

/** Saves the manifest in Cache Storage under its own URL; null where Cache Storage does not exist. */
export function cacheManifestStore(manifestUrl: string, cacheName = MANIFEST_CACHE): SavedManifestStore | null {
  if (typeof caches === 'undefined') return null;
  return {
    async read() {
      const hit = await (await caches.open(cacheName)).match(manifestUrl);
      return hit ? hit.json() : undefined;
    },
    async write(raw) {
      const body = JSON.stringify(raw);
      await (await caches.open(cacheName)).put(manifestUrl, new Response(body, { headers: { 'content-type': 'application/json' } }));
    },
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
