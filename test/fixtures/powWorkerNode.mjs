// A proof-of-work solver worker for Node (worker_threads), speaking the same messages as
// src/pow/powWorker.ts does in a browser: it loads the project's WASM and runs powSolveV1.
// Used by test/site-live-pow.mjs, which builds a pool of these through `createWorker`.

import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import init, { powSolveV1 } from '../../crates/tor-js-wasm/pkg/tor_js.js'

parentPort.on('message', async (request) => {
  if (request?.t !== 'solve') return
  try {
    const wasm = request.wasmUrl.startsWith('file:') ? readFileSync(fileURLToPath(request.wasmUrl)) : request.wasmUrl
    await init({ module_or_path: wasm })
    parentPort.postMessage({ t: 'solved', solution: powSolveV1(request.blindId, request.seed, request.effort, request.startNonce) })
  } catch (e) {
    parentPort.postMessage({ t: 'error', message: e instanceof Error ? e.message : String(e) })
  }
})
