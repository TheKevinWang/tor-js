/**
 * Cancellation shared by the client and the site adapter.
 *
 * An aborted wait rejects with the same error the WASM client gives for an
 * abort (an `Error` with `name` "AbortError", `code` "ABORT", `kind` "abort"),
 * so a caller can recognise it the same way wherever the abort landed. The
 * signal's own `reason` is kept as the error's `cause`.
 */

export function abortError(signal?: AbortSignal | null): Error {
  const err = new Error('The operation was aborted', signal ? { cause: signal.reason } : undefined);
  return Object.assign(err, { name: 'AbortError', code: 'ABORT', kind: 'abort', retryable: false });
}

/** True for an error produced by an aborted operation (here, in the WASM client, or a DOM `AbortError`). */
export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object'
    && ((e as { name?: unknown }).name === 'AbortError' || (e as { code?: unknown }).code === 'ABORT');
}

/**
 * `promise`, unless `signal` aborts first, in which case it rejects with
 * {@link abortError}. Only this caller's wait ends: the work behind `promise`,
 * which other callers may share (a Tor client starting up), carries on. The
 * abort listener is removed as soon as either side settles.
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {}); // the shared work may still fail later; that is not this caller's error
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
