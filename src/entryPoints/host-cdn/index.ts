// Entry point: tor-js/host
// The build of tor-js that can also HOST an onion service (client.listen(), client.serve()).
// It ships a second WASM (tor_js_host_bg.wasm) that is about 330 kB (gzip) larger than the default one,
// so a page that only visits onion services should import `tor-js` instead.
//
// Downloads the WASM from the npm mirrors with SHA256 hash verification and caches it. (The GitHub
// artifact mirror the default entry also uses is filled by CI for the default binary only.)

import { setWasmSourceProvider } from '../../wasm.js';
import { createCdnWasmSource } from '../../cdnLoader.js';

export { TorClient } from '../../TorClient.js';
export * from '../../commonExports.js';

setWasmSourceProvider(createCdnWasmSource({
  fileName: 'tor_js_host_bg.wasm',
  sha256: __WASM_SHA256__,
  packageVersion: __PACKAGE_VERSION__,
  cacheKey: 'wasm-host',
  githubMirror: false,
}));
