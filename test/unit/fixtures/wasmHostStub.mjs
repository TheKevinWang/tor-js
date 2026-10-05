// The stand-in for the generated glue of the HOST build of the WASM: the same as wasmStub.mjs plus
// what only that build exports (`onionAddressFor`). Used to test that src/wasm.ts and
// src/TorClient.ts see hosting as available when, and only when, the glue has it.

export * from './wasmStub.mjs'
export { default } from './wasmStub.mjs'

export function onionAddressFor(identity) {
  if (identity.length !== 32) throw new Error('identity must be 32 bytes')
  return 'h'.repeat(56) + '.onion'
}
