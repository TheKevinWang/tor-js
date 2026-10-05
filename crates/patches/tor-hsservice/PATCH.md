# tor-js patch of tor-hsservice

This is `tor-hsservice` 0.45.0 from the voltrevo fork of arti at revision
`cc09d69156011fd80cafa6cb57fb682062f4d112`, with the changes below. Everything else is verbatim;
to see them, diff against that revision (`crates/tor-hsservice` in
`https://github.com/voltrevo/arti`).

Why: upstream keeps an onion service's persistent state in a directory on disk
(`tor_persist::state_dir`, built on `std::fs`, `fs_mistrust` and file locks), which a browser does
not have. Upstream tracks making this optional as TODO #1186. This copy keeps the state in memory
so a service can run in WebAssembly (`crates/tor-js-wasm/src/host.rs`).

1. `Cargo.toml`: the dependencies on sibling crates (`path = "../..."`), which do not exist
   outside the arti workspace, are git dependencies at the same revision (so Cargo treats them as
   the same packages as everywhere else); `[dev-dependencies]` and `[package.metadata.docs.rs]`
   are removed (so the `#[cfg(test)]` code in this crate does not build here, and is left as it
   was); `serde_json` moves from dev-dependencies to dependencies; `tor-persist` no longer asks
   for its `state-dir` feature; the `full` feature no longer names `tor-key-forge`, which is no
   longer a dependency.
2. `src/mem_state.rs` (new): `StateDirectory`, `InstanceStateHandle`, `InstanceRawSubdir` and
   `StorageHandle<T>` with the method names and shapes the service code uses
   (`acquire_instance`, `storage_handle`, `raw_subdir`, `load`, `store`, `delete`), holding
   records as JSON in memory. Its error type, `mem_state::Error`, replaces `tor_persist::Error`,
   whose constructor is private to `tor-persist`. It has two unit tests; run them by including the
   file in a scratch crate (the rest of this crate's tests cannot build, see 1).
3. `src/internal_prelude.rs`, `src/err.rs`, `src/ipt_mgr.rs`, `src/ipt_mgr/persist.rs`,
   `src/ipt_set.rs`, `src/pow/v1.rs`, `src/pow/v1_stub.rs`: the imports and the error variants
   (`LoadState`, `StateDirectoryInaccessible`, `IptStoreError::Store`, `PowError::StorageError`)
   name `mem_state` instead of `tor_persist::state_dir` / `tor_persist::Error`. `src/lib.rs`
   declares `pub mod mem_state;`.
4. `src/replay.rs`: replay logs, which detect a replayed introduction request, are always in
   memory. `ReplayLog::new_logged` keeps its signature and returns `new_ephemeral()`; the file
   code (`PersistFile`, `new_logged_inner`, `truncate_to_multiple`, the on-disk write in
   `check_for_replay`) is removed.
5. `src/ipt_mgr.rs`: the deletion of replay-log files of introduction points that no longer exist
   is a no-op, since there are no files.

6. `src/pow/v1.rs` (proof of work for hosts, with the `hs-pow-full` feature): upstream runs the two
   request-handling loops, `accept_loop` and `expire_old_requests_loop`, on blocking operating-system
   threads (`spawn_blocking`) and blocks them on futures (`reenter_block_on`). A WebAssembly build has one
   thread and cannot block, so they are `async fn`s started with `spawn` (`start_tasks`, replacing
   `start_accept_thread`); `check_solve` stays synchronous (one Equi-X verification, milliseconds with the
   interpreter). Upstream's loops and the seed-rotation task never end; here a `closed` flag, set when the
   inbound channel ends (the service was dropped), ends all three, so no timer is left running for a
   service that is gone. The two that sleep for minutes race their sleep against that event
   (`RendRequestReceiver::wait_closed`), because their shared state holds the directory manager, which
   holds the circuit manager and the channels: a task asleep for five minutes would keep a closed
   client's connections open for five minutes. The percent change of the suggested effort is computed on signed values
   (upstream subtracts two `u32`s, which wraps when the effort went down).
7. `src/pow.rs`, `src/pow/v1.rs`, `src/pow/v1_stub.rs`, `src/lib.rs`: `PowStats` and `PowStatsSnapshot`
   (verified, rejected, enqueued, dropped, queue length, suggested effort, largest effort seen), counted
   by the loops, held by `PowManager::stats()` and read through the new
   `RunningOnionService::pow_stats()`. The stub reports zeros with `enabled: false`.
8. `src/pow/v1.rs` tests: the helper starts `start_tasks`; four tests added (counters, overflow and expiry
   counted as dropped, tasks end on shutdown, zero stats). The five upstream queue tests plus these run in a
   scratch crate that restores arti's dev-dependencies and switches off every other test module (see
   `.agent/host-pow-and-optional-host-execplan.md`, Concrete Steps): 9 pass.

Consequences for a service: a restarted host picks fresh introduction points, and the replay
logs last only as long as the running service. The service's identity key is not part of this
state (it lives in the `KeyMgr`, see `host.rs`). `restricted_discovery` still has a file-based key
provider; it is unused by tor-js (restricted discovery is off) and still compiles for wasm32.

It is used through `[patch."https://github.com/voltrevo/arti"]` in the workspace `Cargo.toml`.
When the pinned arti revision changes, repeat the copy from the new revision and re-apply the
changes (`scripts/` has no tool for it; the changes are small). Checked: compiles for
`wasm32-unknown-unknown` and natively, with and without `hs-pow-full`; the proof-of-work queue tests pass
in the scratch crate.
