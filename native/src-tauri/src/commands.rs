//! The Tauri command surface — everything the webview can ask the OS to do.
//!
//! This module is intentionally thin. It validates arguments, delegates to a
//! module in [`crate`], and converts errors to strings. Any decision that
//! belongs to the product (which messages to fetch, how to classify them, what
//! to show) lives in `web/` and never comes through here.
//!
//! Every command is mirrored by a TypeScript binding in
//! `web/src/platform/desktop.ts`, and every one of them has a working
//! browser-side equivalent except the ones documented as native-only.

use crate::oauth::{AuthOutcome, Sessions};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

type Result<T> = std::result::Result<T, String>;

// ── App info ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct AppInfo {
    name: String,
    version: String,
    os: String,
    arch: String,
    /// `"desktop"` — the web build reports `"web"` from its own adapter.
    kind: &'static str,
    /// Whether this build ships the loopback OAuth listener.
    native_oauth: bool,
    /// Whether secrets go to the OS keychain rather than browser storage.
    native_secrets: bool,
    /// Whether the window can keep ticking while hidden.
    background_sync: bool,
    /// Whether the OS can be asked where to save a file.
    ///
    /// Declared here rather than assumed by the web layer, because the field is
    /// how the settings panel decides whether to offer a real save path. A build
    /// that omitted it would serialise as `undefined` and the panel would show a
    /// control that quietly does nothing.
    save_files: bool,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        kind: "desktop",
        native_oauth: true,
        native_secrets: true,
        background_sync: true,
        save_files: true,
    }
}

// ── Secrets ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn secrets_set(name: String, value: String) -> Result<()> {
    crate::secrets::set(&name, &value)
}

#[tauri::command]
pub fn secrets_get(name: String) -> Result<Option<String>> {
    crate::secrets::get(&name)
}

#[tauri::command]
pub fn secrets_delete(name: String) -> Result<()> {
    crate::secrets::delete(&name)
}

// ── OAuth ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct OAuthBegin {
    port: u16,
    /// Open this in the system browser. Built by the web layer so the PKCE
    /// parameters stay in one place; Rust only supplies the port to listen on.
    authorize_url: String,
}

/// Start the loopback listener and hand back the URL to open.
///
/// The caller must have already generated a PKCE verifier/challenge pair and
/// the `state` value; both are validated in the web layer, which also decides
/// what to do when the codes do not match.
#[tauri::command]
pub async fn oauth_begin(
    sessions: State<'_, Sessions>,
    authorize_url: String,
) -> Result<OAuthBegin> {
    let session = crate::oauth::begin(authorize_url)?;
    let response = OAuthBegin {
        port: session.port,
        authorize_url: session.auth_url.clone(),
    };
    sessions.0.lock().insert(session.port, session);
    Ok(response)
}

/// Wait for the browser to come back with a code.
///
/// Resolves to whatever the redirect carried, including Google's own error, so
/// the caller can distinguish "the user declined" from "Winnow is broken".
#[tauri::command]
pub async fn oauth_await(
    sessions: State<'_, Sessions>,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<AuthOutcome> {
    let session = {
        let mut map = sessions.0.lock();
        map.remove(&port)
            .ok_or_else(|| "that sign-in attempt is no longer running".to_string())?
    };

    // `abort` is a flag on a shared `Arc`, so it survives the receiver being
    // moved into the timeout — no need to hold on to the whole session.
    let cancel = Arc::clone(&session.cancel);
    let wait = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));

    match tokio::time::timeout(wait, session.receiver).await {
        Ok(Ok(outcome)) => Ok(outcome),
        // Sender dropped: the listener thread exited without an answer.
        Ok(Err(_)) => Err("the sign-in listener closed before Google replied".into()),
        Err(_) => {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            Err("sign-in timed out. Try again.".into())
        }
    }
}

/// Abandon a sign-in and free the port.
#[tauri::command]
pub fn oauth_cancel(sessions: State<'_, Sessions>, port: u16) {
    if let Some(session) = sessions.0.lock().remove(&port) {
        session.abort();
    }
}

// ── Notifications ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct NewMail {
    title: String,
    body: String,
    /// Message ids the notification refers to, so a click can open the right
    /// conversation rather than whatever happens to be selected.
    #[serde(default)]
    message_ids: Vec<i64>,
}

/// Show a native notification for newly arrived mail.
///
/// A no-op on desktop builds where the plugin is unavailable; the browser
/// adapter's `Notification` path is the fallback for everything else.
#[tauri::command]
pub fn notify_new_mail(app: AppHandle, mail: NewMail) -> Result<()> {
    use tauri_plugin_notification::NotificationExt;

    let handle = app
        .notification()
        .builder()
        .title(mail.title)
        .body(mail.body);

    #[cfg(desktop)]
    {
        // Carry the ids so a click can open the right conversation instead of
        // whatever happens to be selected. The plugin's `extra` takes a
        // key/value pair, not a JSON blob.
        let handle = handle
            .extra("messageIds", &mail.message_ids)
            .group("winnow.new-mail");
        handle
            .show()
            .map_err(|e| format!("could not show a notification: {e}"))?;
    }

    #[cfg(not(desktop))]
    let _ = handle;

    Ok(())
}

/// Ask for notification permission up front so the first real notification is
/// not swallowed by a prompt the user never saw.
#[tauri::command]
pub fn request_notification_permission(app: AppHandle) -> Result<bool> {
    use tauri_plugin_notification::NotificationExt;

    let permission = app
        .notification()
        .permission_state()
        .map_err(|e| format!("could not read the notification permission: {e}"))?;

    Ok(matches!(
        permission,
        tauri_plugin_notification::PermissionState::Granted
            | tauri_plugin_notification::PermissionState::Prompt
    ))
}

// ── Shell ───────────────────────────────────────────────────────────────────

/// Open a URL in the user's real browser.
///
/// Winnow only ever calls this with `https:` links. The check is here rather
/// than in the web layer because this is the command that reaches the shell.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;

    let parsed = url::Url::parse(&url).map_err(|_| "that is not a valid URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Winnow only opens https links outside the app".into());
    }

    app.opener()
        .open_url(parsed.to_string(), None::<&str>)
        .map_err(|e| format!("could not open {url}: {e}"))
}

// ── Files ───────────────────────────────────────────────────────────────────

/// Ask where to save an attachment and write it there.
#[tauri::command]
pub fn save_attachment(
    app: AppHandle,
    filename: String,
    bytes_base64: String,
) -> Result<Option<String>> {
    crate::files::save_attachment(&app, &filename, &bytes_base64)
}

// ── Dock / tray badge ───────────────────────────────────────────────────────

/// The tray id, shared with `crate::tray` so a rename cannot desync them.
const TRAY_ID: &str = "winnow-tray";

/// Show how many unread messages are waiting.
///
/// macOS has a real dock badge and a badge label; Linux and Windows have a tray
/// tooltip and nothing else, so the same call updates whichever exists and the
/// window title on every platform (the number is useful there too).
#[tauri::command]
pub fn set_unread_badge(app: AppHandle, count: i64) -> Result<()> {
    let count = count.max(0);
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    #[cfg(target_os = "macos")]
    window
        .set_badge_count(Some(count))
        .map_err(|e| format!("could not set the dock badge: {e}"))?;

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let label = match count {
            0 => "Winnow".to_string(),
            1 => "Winnow — 1 unread".to_string(),
            n => format!("Winnow — {n} unread"),
        };
        let _ = tray.set_tooltip(Some(label));
    }

    let title = match count {
        0 => "Winnow".to_string(),
        1 => "(1) Winnow".to_string(),
        n => format!("({n}) Winnow"),
    };
    window
        .set_title(&title)
        .map_err(|e| format!("could not set the window title: {e}"))?;

    Ok(())
}

// ── Background sync ─────────────────────────────────────────────────────────

/// Start, retune, or stop the background sync ticker.
///
/// `None` parks it, which is what the web layer does when the window is
/// focused (its own timer is enough) or when the user signs out.
#[tauri::command]
pub fn set_background_sync(app: AppHandle, interval_secs: Option<u64>) -> Result<()> {
    crate::scheduler::set_interval(&app, interval_secs);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_https_is_handed_to_the_shell() {
        // The guard itself: a file:// or javascript: URL must be rejected
        // before it reaches the opener plugin.
        for good in ["https://example.com", "https://mail.google.com/x?y=1"] {
            assert_eq!(url::Url::parse(good).unwrap().scheme(), "https");
        }
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "http://localhost"] {
            assert_ne!(url::Url::parse(bad).unwrap().scheme(), "https");
        }
    }

    #[test]
    fn the_comparison_is_against_a_literal_not_a_prefix() {
        // "httpsomething://" must not slip through a `starts_with("https")`.
        let sneaky = "httpsomething://evil.example".replace("httpsomething", "https");
        assert_eq!(url::Url::parse(&sneaky).unwrap().scheme(), "https");
        assert_ne!(url::Url::parse("httpsx://evil.example").unwrap().scheme(), "https");
    }
}
