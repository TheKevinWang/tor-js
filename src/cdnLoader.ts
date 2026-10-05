// Loads a tor-js WASM binary from a CDN, verifying its SHA-256 hash, with a local cache.
//
// Shared by the CDN entry points: `tor-js` (the default build) and `tor-js/host` (the build that can
// host onion services, a different binary with a different hash and file name).
//
// The GitHub CDN source stores AES-256-GCM encrypted files keyed by the WASM hash, with filenames
// derived from hash(hash) so the key isn't revealed by the URL. It is filled by CI for the default
// binary only, so the host build turns it off and uses the two npm mirrors.

import { createAutoStorage } from './storage/index.js';

export interface CdnWasmOptions {
  /** File name in the npm package's `dist/`, e.g. `tor_js_bg.wasm`. */
  fileName: string;
  /** SHA-256 (hex) the downloaded or cached bytes must have. */
  sha256: string;
  /** Version of the npm package to fetch from the mirrors. */
  packageVersion: string;
  /** Key under which the verified bytes are cached in local storage. */
  cacheKey: string;
  /** Whether to also try the GitHub hash-artifact mirror (encrypted, filled by CI). */
  githubMirror: boolean;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sha256hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = bytes instanceof Uint8Array ? bytes.buffer as ArrayBuffer : bytes;
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Node.js fallback
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
}

async function decryptAesGcm(encrypted: ArrayBuffer, keyBytes: Uint8Array): Promise<ArrayBuffer> {
  const iv = keyBytes.slice(0, 12);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const key = await crypto.subtle.importKey('raw', keyBytes.buffer as ArrayBuffer, 'AES-GCM', false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  }

  // Node.js fallback — crypto.subtle output is ciphertext || 16-byte auth tag
  const { createDecipheriv } = await import('node:crypto');
  const data = new Uint8Array(encrypted);
  const authTag = data.slice(-16);
  const ciphertext = data.slice(0, -16);
  const decipher = createDecipheriv('aes-256-gcm', keyBytes, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength);
}

type Source = { urls: string[], encrypted: boolean };

/** The places to try, before shuffling: the npm mirrors, and optionally the GitHub artifact mirror. */
export function cdnSources(options: CdnWasmOptions, hashHashPrefix: string, hashHash: string): Source[] {
  const githubBase = `https://raw.githubusercontent.com/voltrevo/arti/hash-artifacts/`;
  const sources: Source[] = [
    { urls: [`https://cdn.jsdelivr.net/npm/tor-js@${options.packageVersion}/dist/${options.fileName}`], encrypted: false },
    { urls: [`https://unpkg.com/tor-js@${options.packageVersion}/dist/${options.fileName}`], encrypted: false },
  ];
  if (options.githubMirror) {
    sources.push({ urls: [`${githubBase}${hashHashPrefix}/${hashHash}`, `${githubBase}tmp/${hashHash}`], encrypted: true });
  }
  return sources;
}

/** Make the function an entry point registers with `setWasmSourceProvider`. */
export function createCdnWasmSource(options: CdnWasmOptions): () => Promise<Uint8Array> {
  return async () => {
    let cache: ReturnType<typeof createAutoStorage> | undefined;
    try {
      cache = createAutoStorage('tor-js-wasm');
    } catch {
      // No persistent storage available — proceed without caching
    }

    // Try loading from cache
    if (cache) {
      try {
        const cached = await cache.get(options.cacheKey);
        if (cached) {
          const bytes = base64ToBytes(cached);
          const hash = await sha256hex(bytes);
          if (hash === options.sha256) {
            return bytes;
          }
          // Hash mismatch — stale cache, delete it
          await cache.delete(options.cacheKey);
        }
      } catch {
        // Cache read failed — proceed to download
      }
    }

    // Download from CDN
    const hashBytes = hexToBytes(options.sha256);
    const hashHash = await sha256hex(hashBytes);
    const hashHashPrefix = hashHash.slice(0, 2);

    const sources = cdnSources(options, hashHashPrefix, hashHash);

    // Shuffle sources for load balancing
    for (let i = sources.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sources[i], sources[j]] = [sources[j], sources[i]];
    }

    const errors: string[] = [];
    for (const source of sources) {
      for (const url of source.urls) {
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          let bytes = await resp.arrayBuffer();

          if (source.encrypted) {
            bytes = await decryptAesGcm(bytes, hashBytes);
          }

          const hash = await sha256hex(bytes);
          if (hash !== options.sha256) {
            throw new Error(`SHA256 mismatch: expected ${options.sha256}, got ${hash}`);
          }

          const result = new Uint8Array(bytes);

          // Cache for next time (fire and forget)
          if (cache) {
            cache.set(options.cacheKey, bytesToBase64(result)).catch(() => {});
          }

          return result;
        } catch (err) {
          errors.push(`${url}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    throw new Error(`Failed to load WASM from any CDN:\n  ${errors.join('\n  ')}`);
  };
}
