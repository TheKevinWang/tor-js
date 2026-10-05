//! In-memory replacement for the service's state directory (tor-js patch).
//!
//! Upstream keeps an onion service's persistent state (its introduction points, the
//! descriptor it last published, replay logs) in a directory on disk, through
//! `tor_persist::state_dir`, which is built on `std::fs` and file locks and so cannot run in a
//! browser. This module has the same shape (the same type and method names as the call sites
//! use) but holds everything in memory.
//!
//! What this means for a service: a restarted host picks fresh introduction points, and the
//! logs that detect replayed introduction requests live only as long as the running service.
//! The service's identity key is not part of this state; it lives in the `KeyMgr`.

use std::collections::HashMap;
use std::fmt;
use std::marker::PhantomData;
use std::sync::{Arc, Mutex};

use serde::{Serialize, de::DeserializeOwned};
use tor_error::{ErrorKind, HasKind};

/// Error from loading or storing in-memory state: the value could not be (de)serialized.
#[derive(Clone, Debug, thiserror::Error)]
#[error("Problem with in-memory service state")]
pub struct Error(#[source] Arc<serde_json::Error>);

impl HasKind for Error {
    fn kind(&self) -> ErrorKind {
        ErrorKind::Internal
    }
}

/// Result type for this module.
pub type Result<T> = std::result::Result<T, Error>;

/// One stored value, as JSON text. `None` means nothing stored (or deleted).
type Slot = Arc<Mutex<Option<String>>>;

/// The place a service keeps its state: replaces `tor_persist::state_dir::StateDirectory`.
///
/// Cheap to clone; clones share the same storage.
#[derive(Clone, Debug, Default)]
pub struct StateDirectory {
    /// Every slot, keyed by `"<instance>/<key>"`.
    slots: Arc<Mutex<HashMap<String, Slot>>>,
}

impl StateDirectory {
    /// An empty in-memory state directory.
    pub fn new_in_memory() -> Self {
        Self::default()
    }

    /// Open the state for the service named `nickname`.
    ///
    /// Unlike the on-disk version this never fails and takes no lock: the state is private to
    /// the process, and a second service with the same nickname would share it just as two
    /// processes sharing a directory would have had to be prevented by the lock.
    pub fn acquire_instance(&self, nickname: &impl fmt::Display) -> Result<InstanceStateHandle> {
        Ok(InstanceStateHandle {
            instance: nickname.to_string(),
            dir: self.clone(),
        })
    }
}

/// A service's view of the state directory: replaces
/// `tor_persist::state_dir::InstanceStateHandle`.
#[derive(Clone, Debug)]
pub struct InstanceStateHandle {
    /// The service nickname.
    instance: String,
    /// The shared storage.
    dir: StateDirectory,
}

impl InstanceStateHandle {
    /// A typed slot named `key`, for one record of type `T` (replaces `StorageHandle` of the
    /// on-disk version).
    pub fn storage_handle<T>(&self, key: &(impl fmt::Display + ?Sized)) -> Result<StorageHandle<T>> {
        let name = format!("{}/{}", self.instance, key);
        let slot = self
            .dir
            .slots
            .lock()
            .expect("poisoned")
            .entry(name)
            .or_default()
            .clone();
        Ok(StorageHandle {
            slot,
            marker: PhantomData,
        })
    }

    /// A raw directory for files named `name` (replay logs, proof-of-work nonces).
    ///
    /// There is no directory here: the logs that would have lived in it are held in memory by
    /// the code that owns them (see `replay.rs`). The handle exists so those call sites keep
    /// their shape.
    pub fn raw_subdir(&self, _name: &(impl fmt::Display + ?Sized)) -> Result<InstanceRawSubdir> {
        Ok(InstanceRawSubdir(()))
    }
}

/// Stand-in for the on-disk raw subdirectory; carries nothing.
#[derive(Clone, Debug)]
pub struct InstanceRawSubdir(());

/// A typed slot holding one stored record: replaces `tor_persist::state_dir::StorageHandle`.
pub struct StorageHandle<T> {
    /// The shared slot.
    slot: Slot,
    /// The record type.
    marker: PhantomData<fn() -> T>,
}

impl<T> fmt::Debug for StorageHandle<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StorageHandle(in memory)")
    }
}

impl<T: Serialize + DeserializeOwned> StorageHandle<T> {
    /// Load the stored record, or `None` if there is none (never stored, or deleted).
    pub fn load(&self) -> Result<Option<T>> {
        match self.slot.lock().expect("poisoned").as_deref() {
            None => Ok(None),
            Some(json) => serde_json::from_str(json)
                .map(Some)
                .map_err(|e| Error(Arc::new(e))),
        }
    }

    /// Store `v`, replacing any earlier record.
    pub fn store(&mut self, v: &T) -> Result<()> {
        let json = serde_json::to_string(v).map_err(|e| Error(Arc::new(e)))?;
        *self.slot.lock().expect("poisoned") = Some(json);
        Ok(())
    }

    /// Forget the stored record.
    pub fn delete(&mut self) -> Result<()> {
        *self.slot.lock().expect("poisoned") = None;
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[derive(Serialize, serde::Deserialize, PartialEq, Debug)]
    struct Rec {
        n: u32,
    }

    #[test]
    fn store_load_delete_roundtrip() {
        let dir = StateDirectory::new_in_memory();
        let inst = dir.acquire_instance(&"svc").unwrap();
        let mut h = inst.storage_handle::<Rec>("a").unwrap();
        assert_eq!(h.load().unwrap(), None);
        h.store(&Rec { n: 7 }).unwrap();
        assert_eq!(h.load().unwrap(), Some(Rec { n: 7 }));
        h.delete().unwrap();
        assert_eq!(h.load().unwrap(), None);
    }

    #[test]
    fn handles_for_the_same_key_share_and_other_keys_do_not() {
        let dir = StateDirectory::new_in_memory();
        let inst = dir.acquire_instance(&"svc").unwrap();
        let mut a1 = inst.storage_handle::<Rec>("a").unwrap();
        let a2 = inst.storage_handle::<Rec>("a").unwrap();
        let b = inst.storage_handle::<Rec>("b").unwrap();
        a1.store(&Rec { n: 1 }).unwrap();
        assert_eq!(a2.load().unwrap(), Some(Rec { n: 1 }));
        assert_eq!(b.load().unwrap(), None);
    }
}
