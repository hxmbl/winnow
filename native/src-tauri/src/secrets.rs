//! OAuth secrets in the operating system's credential store.
//!
//! A browser cannot keep a refresh token out of reach of a synced profile or an
//! XSS payload, so in the native shell Winnow stores Gmail tokens where the OS
//! protects them and the webview only ever sees the token it is actively using:
//!
//! * **Desktop** — Keychain / Credential Manager / Secret Service, through `keyring`.
//! * **Android** — `keyring` has no Android backend, so the keyring project's own
//!   [`android_native_keyring_store`] is used instead: each value is encrypted with
//!   AES-GCM under a key held in the Android Keystore (it never leaves it) and the
//!   ciphertext is kept in the app's private `SharedPreferences`.
//!
//! Both sides expose the same three functions with the same "no entry is
//! `None`" contract, so `commands.rs` and the web layer do not know which one
//! they are talking to.
//!
//! On the web the same interface is served by `localStorage` — see
//! `web/src/platform/secrets.ts` — so the TypeScript side has one code path.

use parking_lot::Mutex;
use std::sync::Arc;

/// `keyring` needs a service + user pair. One service, one user per secret name.
///
/// Deliberately not the bundle identifier: the Android build has its own package
/// id, and the desktop keychain items must keep the name they were written under.
const SERVICE: &str = "app.winnow.desktop";

/// Failures are returned to the webview as strings — the TypeScript side turns
/// them into a message, and the distinction that matters to the user is
/// "keychain locked" versus "no secret stored".
pub type Result<T> = std::result::Result<T, String>;

#[cfg(not(target_os = "android"))]
mod backend {
    use super::{Result, SERVICE};
    use keyring::Entry;

    /// A keyring entry for `name`. Kept as a helper so every call site agrees on
    /// the service string.
    fn entry(name: &str) -> Result<Entry> {
        Entry::new(SERVICE, name).map_err(|e| format!("keychain unavailable: {e}"))
    }

    pub fn set(name: &str, value: &str) -> Result<()> {
        entry(name)?
            .set_password(value)
            .map_err(|e| format!("could not write to the keychain: {e}"))
    }

    pub fn get(name: &str) -> Result<Option<String>> {
        let entry = entry(name)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("could not read from the keychain: {e}")),
        }
    }

    pub fn delete(name: &str) -> Result<()> {
        let entry = entry(name)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not delete from the keychain: {e}")),
        }
    }
}

#[cfg(target_os = "android")]
mod backend {
    use super::{Result, SERVICE};
    use keyring_core::{Entry, Error};
    use std::sync::OnceLock;

    /// Install the Android store as `keyring-core`'s default, once.
    ///
    /// Lazily, on first use, rather than in `setup`: the store reads the
    /// application context that tao puts into `ndk-context` during the activity's
    /// `onCreate`, and the first secret is only ever asked for by the webview,
    /// which is long after that. A failure is remembered and reported on every
    /// call, so a broken Keystore reads as "unavailable" rather than as "signed out".
    fn ready() -> Result<()> {
        static STORE: OnceLock<std::result::Result<(), String>> = OnceLock::new();
        STORE
            .get_or_init(|| {
                let store = android_native_keyring_store::Store::new()
                    .map_err(|e| format!("Android Keystore unavailable: {e}"))?;
                keyring_core::set_default_store(store);
                Ok(())
            })
            .clone()
    }

    fn entry(name: &str) -> Result<Entry> {
        ready()?;
        Entry::new(SERVICE, name).map_err(|e| format!("keystore unavailable: {e}"))
    }

    pub fn set(name: &str, value: &str) -> Result<()> {
        entry(name)?
            .set_password(value)
            .map_err(|e| format!("could not write to the keystore: {e}"))
    }

    pub fn get(name: &str) -> Result<Option<String>> {
        match entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("could not read from the keystore: {e}")),
        }
    }

    pub fn delete(name: &str) -> Result<()> {
        match entry(name)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not delete from the keystore: {e}")),
        }
    }
}

/// Store (or replace) a secret.
pub fn set(name: &str, value: &str) -> Result<()> {
    backend::set(name, value)
}

/// Read a secret, or `None` when nothing is stored under that name.
pub fn get(name: &str) -> Result<Option<String>> {
    backend::get(name)
}

/// Remove a secret. Deleting something that was never stored is a success.
pub fn delete(name: &str) -> Result<()> {
    backend::delete(name)
}

/// Shared handle so the async command layer can reuse one entry pool.
pub type Keychain = Arc<Mutex<()>>;

pub fn new_handle() -> Keychain {
    Arc::new(Mutex::new(()))
}
