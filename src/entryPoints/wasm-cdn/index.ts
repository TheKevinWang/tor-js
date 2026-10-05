// Entry point: tor-js (default), tor-js/wasm-cdn
// Downloads WASM from CDN with SHA256 hash verification.
// Caches the downloaded WASM using createAutoStorage for faster subsequent loads.
// The GitHub CDN source stores AES-256-GCM encrypted files keyed by the WASM hash,
// with filenames derived from hash(hash) so the key isn't revealed by the URL.
// (The loader is shared with tor-js/host: see ../../cdnLoader.ts.)

import { setWasmSourceProvider } from '../../wasm.js';
import { createCdnWasmSource } from '../../cdnLoader.js';

export { TorClient } from '../../TorClient.js';
export * from '../../commonExports.js';

setWasmSourceProvider(createCdnWasmSource({
  fileName: 'tor_js_bg.wasm',
  sha256: __WASM_SHA256__,
  packageVersion: __PACKAGE_VERSION__,
  cacheKey: 'wasm',
  githubMirror: true,
}));
