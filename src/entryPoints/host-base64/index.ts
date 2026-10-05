// Entry point: tor-js/host/wasm-base64
// The build of tor-js that can also HOST an onion service, with its WASM embedded as base64.
// Self-contained, no external file needed. See entryPoints/host-cdn/index.ts for what "host" means.

import { setWasmSourceProvider } from '../../wasm.js';
import { wasmBase64 } from '#wasm-base64-data';

export { TorClient } from '../../TorClient.js';
export * from '../../commonExports.js';

setWasmSourceProvider(async () => {
  const binaryString = atob(wasmBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
});
