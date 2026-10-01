//! OAuth secrets in the operating system keychain.
//!
//! A browser cannot keep a refresh token out of reach of a synced profile or an
//! XSS payload, so on the desktop Winnow stores Gmail tokens where the OS
//! protects them (Keychain / Credential Manager / Secret Service) and the
//! webview only ever sees the token it is actively using.
//!
//! On the web the same interface is served by `localStorage` — see
//! `web/src/platform/secrets.ts` — so the TypeScript side has one code path.

use keyring::Entry;
use parking_lot::Mutex;
use std::sync::Arc;

/// `keyring` needs a service + user pair. One service, one user per secret name.
const SERVICE: &str = "app.winnow.desktop";

/// Failures are returned to the webview as strings — the TypeScript side turns
/// them into a message, and the distinction that matters to the user is
/// "keychain locked" versus "no secret stored".
pub type Result<T> = std::result::Result<T, String>;

/// A keyring entry for `name`. Kept as a helper so every call site agrees on
/// the service string.
fn entry(name: &str) -> Result<Entry> {
    Entry::new(SERVICE, name).map_err(|e| format!("keychain unavailable: {e}"))
}

/// Store (or replace) a secret.
pub fn set(name: &str, value: &str) -> Result<()> {
    entry(name)?
        .set_password(value)
        .map_err(|e| format!("could not write to the keychain: {e}"))
}

/// Read a secret, or `None` when nothing is stored under that name.
pub fn get(name: &str) -> Result<Option<String>> {
    let entry = entry(name)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read from the keychain: {e}")),
    }
}

/// Remove a secret. Deleting something that was never stored is a success.
pub fn delete(name: &str) -> Result<()> {
    let entry = entry(name)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not delete from the keychain: {e}")),
    }
}

/// Shared handle so the async command layer can reuse one entry pool.
pub type Keychain = Arc<Mutex<()>>;

pub fn new_handle() -> Keychain {
    Arc::new(Mutex::new(()))
}
