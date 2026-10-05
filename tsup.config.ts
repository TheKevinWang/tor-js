import { defineConfig, type Options } from 'tsup';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, 'crates/tor-js-wasm/pkg');
// The build of the WASM that can also host onion services (Cargo feature `onion-service-host`).
const pkgHostDir = resolve(__dirname, 'crates/tor-js-wasm/pkg-host');

// Settings both builds share.
const common: Options = {
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: false, // build.mjs handles cleaning
  splitting: false,
  target: 'es2022',
  external: ['node:fs/promises', 'node:os', 'node:path', 'node:url', 'node:crypto'],
  // Bundle the KPS browser client (small, zero-dep ESM) so the dist works
  // without a bundler or import map. The optional Node QUIC transport is
  // imported via a non-literal specifier and stays external.
  noExternal: ['@kpstreams/core', '@kpstreams/webrtc-client'],
};

export default defineConfig([
  // The default build: no hosting code in its WASM (tor-js, tor-js/wasm-file, tor-js/wasm-base64).
  {
    ...common,
    entry: {
      'entryPoints/wasm-cdn/index': 'src/entryPoints/wasm-cdn/index.ts',
      'entryPoints/wasm-cdn/singleton': 'src/entryPoints/wasm-cdn/singleton.ts',
      'entryPoints/wasm-base64/index': 'src/entryPoints/wasm-base64/index.ts',
      'entryPoints/wasm-base64/singleton': 'src/entryPoints/wasm-base64/singleton.ts',
      'entryPoints/wasm-file/index': 'src/entryPoints/wasm-file/index.ts',
      'entryPoints/wasm-file/singleton': 'src/entryPoints/wasm-file/singleton.ts',
      // Page-side API of the static-site adapter; its worker scripts are built by build.mjs.
      'site/register': 'src/site/register.ts',
    },
    esbuildPlugins: [{
      name: 'resolve-for-bundling',
      setup(build) {
        build.onResolve({ filter: /^#wasm$/ }, () => ({
          path: resolve(pkgDir, 'tor_js.js'),
        }));
        build.onResolve({ filter: /^#wasm-base64-data$/ }, () => ({
          path: resolve(__dirname, 'src', '_wasm-base64-data.generated.js'),
        }));
      },
    }],
    define: {
      '__WASM_SHA256__': JSON.stringify(process.env.WASM_SHA256 || ''),
      '__PACKAGE_VERSION__': JSON.stringify(process.env.PACKAGE_VERSION || ''),
    },
  },
  // The host build: its WASM includes the onion service code (tor-js/host and its variants).
  {
    ...common,
    entry: {
      'entryPoints/host-cdn/index': 'src/entryPoints/host-cdn/index.ts',
      'entryPoints/host-base64/index': 'src/entryPoints/host-base64/index.ts',
      'entryPoints/host-file/index': 'src/entryPoints/host-file/index.ts',
    },
    esbuildPlugins: [{
      name: 'resolve-for-bundling-host',
      setup(build) {
        build.onResolve({ filter: /^#wasm$/ }, () => ({
          path: resolve(pkgHostDir, 'tor_js_host.js'),
        }));
        build.onResolve({ filter: /^#wasm-base64-data$/ }, () => ({
          path: resolve(__dirname, 'src', '_wasm-host-base64-data.generated.js'),
        }));
      },
    }],
    define: {
      '__WASM_SHA256__': JSON.stringify(process.env.WASM_HOST_SHA256 || ''),
      '__PACKAGE_VERSION__': JSON.stringify(process.env.PACKAGE_VERSION || ''),
    },
  },
]);
