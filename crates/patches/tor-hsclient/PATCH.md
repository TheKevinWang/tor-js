# tor-js patch of tor-hsclient

This is `tor-hsclient` 0.45.0 from the voltrevo fork of arti at revision
`cc09d69156011fd80cafa6cb57fb682062f4d112`, with three changes. Everything else is
verbatim; to see them, diff against that revision (`crates/tor-hsclient` in
`https://github.com/voltrevo/arti`).

1. `Cargo.toml`: the dependencies on sibling crates (`path = "../..."`), which do not exist
   outside the arti workspace, are git dependencies at the same revision (so Cargo treats them as
   the same packages as everywhere else); `[dev-dependencies]` are removed; on `wasm32`, `js-sys`,
   `wasm-bindgen` and `wasm-bindgen-futures` are added.
2. `src/pow.rs`: on `wasm32` with the `hs-pow-full` feature, `mod v1` is `pow/v1_wasm.rs`.
3. `src/pow/v1_wasm.rs` (new): upstream's `v1.rs` runs the puzzle solver on an operating-system
   thread, which a single-threaded WASM build does not have. This version hands the puzzle to a
   JavaScript function, `globalThis.__torJsPowSolve`, and builds the proof from its answer. It also
   reads two settings (`maxEffort`, default 2000, and `minEffort`, default 0) from
   `globalThis.__torJsPowConfig`. Its header comment documents the contract.

It is used through `[patch."https://github.com/voltrevo/arti"]` in the workspace `Cargo.toml`.
When the pinned arti revision changes, repeat the copy from the new revision and re-apply the
three changes (`scripts/` has no tool for it; the changes are small).
