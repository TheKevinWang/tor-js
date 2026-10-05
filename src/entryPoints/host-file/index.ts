// Entry point: tor-js/host/wasm-file
// The build of tor-js that can also HOST an onion service, loading its WASM from a file next to the
// JS module (Node.js filesystem or browser URL). See entryPoints/host-cdn/index.ts.

import { setWasmSourceProvider } from '../../wasm.js';

export { TorClient } from '../../TorClient.js';
export * from '../../commonExports.js';

setWasmSourceProvider(async () => {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const wasmPath = fileURLToPath(new URL('../../tor_js_host_bg.wasm', import.meta.url));
    return readFile(wasmPath);
  }
  const resp = await fetch(new URL('../../tor_js_host_bg.wasm', import.meta.url));
  if (!resp.ok) throw new Error(`Failed to fetch WASM: HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}, { url: new URL('../../tor_js_host_bg.wasm', import.meta.url).href, variant: 'host' });
