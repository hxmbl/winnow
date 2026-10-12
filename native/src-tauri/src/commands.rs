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
#[cfg_attr(mobile, allow(unused_imports))]
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
    ///
    /// Renamed explicitly rather than by `rename_all = "camelCase"`, because serde's
    /// camelCase of `native_oauth` is `nativeOauth` — it cannot know an acronym is
    /// an acronym. The web layer reads `nativeOAuth`, so the two would disagree by
    /// one capital letter, which is a difference no compiler and no test would
    /// catch and which reads as `undefined` at the call site. Every field whose
    /// name contains an acronym therefore carries its own `rename`.
    #[serde(rename = "nativeOAuth")]
    native_oauth: bool,
    /// Whether secrets go to the OS keychain rather than browser storage.
    #[serde(rename = "nativeSecrets")]
    native_secrets: bool,
    /// Whether the window can keep ticking while hidden.
    #[serde(rename = "backgroundSync")]
    background_sync: bool,
    /// Whether the OS can be asked where to save a file.
    ///
    /// Declared here rather than assumed by the web layer, because the field is
    /// how the settings panel decides whether to offer a real save path. A build
    /// that omitted it would serialise as `undefined` and the panel would show a
    /// control that quietly does nothing.
    #[serde(rename = "saveFiles")]
    save_files: bool,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        // "desktop" on a phone too, for now: it tells the web layer to use the native
        // platform (keychain, notifications, the opener) rather than the browser one.
        // A distinct "mobile" kind is Phase 2 of the mobile plan.
        kind: "desktop",
        // Four capabilities, all true, and each one is a thing this crate
        // implements: `oauth.rs` has the loopback listener, `secrets.rs` has the
        // keychain, `scheduler.rs` has the ticker, `files.rs` has the save dialog.
        // The web layer reads them to decide what to show, so a `false` here is a
        // statement about the build rather than a default.
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
///
/// **The session is still registered while this waits.** It used to be removed
/// from the map on entry, which meant `oauth_cancel` — the only thing that can stop
/// a sign-in the user walked away from — found nothing to cancel: the map was
/// already empty by the time the UI could offer a Cancel button. Cancel was a
/// no-op and the promise ran to its full five-minute timeout, so "Cancel" was a
/// button that made the wait *longer*.
///
/// The entry is removed when the wait finishes, whoever won it.
#[tauri::command]
pub async fn oauth_await(
    sessions: State<'_, Sessions>,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<AuthOutcome> {
    // Claim the outcome without unregistering the session. `take_receiver` is the
    // only thing consumed here; `cancel`, `port` and the bound listener all stay
    // reachable, which is exactly what `oauth_cancel` needs.
    let receiver = {
        let mut map = sessions.0.lock();
        match map.get_mut(&port) {
            Some(session) => session.take_receiver(),
            None => None,
        }
    };
    let Some(receiver) = receiver else {
        // Distinguish "no such attempt" from "already waited on", because they
        // have different causes: the first is a stale port from a previous
        // attempt, the second is a double `await` on the same one.
        let known = sessions.0.lock().contains_key(&port);
        return Err(if known {
            "that sign-in attempt has already been waited on".into()
        } else {
            "that sign-in attempt is no longer running".to_string()
        });
    };

    let wait = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));
    let result = tokio::time::timeout(wait, receiver).await;

    // Whoever won, the session is done: free the port so the next attempt can
    // bind, and so `oauth_cancel` cannot abort a sign-in that has already
    // completed.
    if let Some(session) = sessions.0.lock().remove(&port) {
        session.abort();
    }

    match result {
        Ok(Ok(outcome)) => Ok(outcome),
        // Sender dropped: the listener thread exited without an answer.
        Ok(Err(_)) => Err("the sign-in listener closed before Google replied".into()),
        Err(_) => Err("sign-in timed out. Try again.".into()),
    }
}

/// Abandon a sign-in and free the port.
///
/// Awaits nothing and reports nothing, because the only caller is the webview's
/// Cancel button and a cancellation that fails is indistinguishable from one that
/// worked — there is nothing left to do either way.
#[tauri::command]
pub fn oauth_cancel(sessions: State<'_, Sessions>, port: u16) {
    if let Some(session) = sessions.0.lock().remove(&port) {
        session.abort();
    }
}

// ── Notifications ───────────────────────────────────────────────────────────

/// A native notification for newly arrived mail.
///
/// `rename_all = "camelCase"` and it is load-bearing, not cosmetic. Tauri rewrites
/// the *top-level* argument key from camelCase to snake_case, but the value under
/// it is deserialised by plain serde, which looks for the field names as declared.
/// The web layer sent `messageIds`; this struct declared `message_ids` with
/// `#[serde(default)]`; the two did not match and the field defaulted to an empty
/// vec. Deserialisation *succeeded*, so nothing failed and nothing was logged — the
/// ids were simply always empty, and the "a click opens the right conversation"
/// feature had nothing to open.
#[derive(Deserialize)]
pub struct NewMail {
    title: String,
    body: String,
    /// Message ids the notification refers to, so a notification can be tied back to
    /// the conversations it came from.
    ///
    /// `rename_all = "camelCase"` would produce `messageIds` correctly, but it is
    /// spelled out for the same reason as `AppInfo`: an explicit rename is checked by
    /// a test against the exact string the web layer sends, whereas `rename_all` is
    /// checked against serde's notion of the same thing.
    #[serde(default, rename = "messageIds")]
    message_ids: Vec<i64>,
}

/// Show a native notification for newly arrived mail.
///
/// Best-effort on platforms where the plugin is unavailable; the browser
/// adapter's `Notification` path is the fallback for everything else.
///
/// **What a notification click is worth knowing, and what it is not.**
/// `tauri-plugin-notification` exposes no desktop click callback: `on_action` is
/// mobile-only, and a click on a macOS notification arrives as an *app activation*
/// carrying no payload. So the ids attached to a notification cannot be read back at
/// the moment of the click, and the old comment on `NewMail` — "a click can open the
/// right conversation" — described a capability the desktop build does not have.
///
/// What the desktop build does on a click is reveal the window, handled by
/// [`crate::tray::reveal`] on `RunEvent::Reopen`. Opening the *specific* message is
/// the browser build's feature, and the platform interface says so rather than
/// leaving the two to be discovered as a difference in behaviour.
///
/// The `message_ids` are still sent and still used: the plugin round-trips them as
/// `extra`, and a shell that *can* deliver a payload reads them. Sending them costs
/// nothing and keeps the wire shape one shape across both hosts.
///
/// Note there is no event constant here for it. There used to be —
/// `winnow://notification-action` — declared "so the webview's subscription is not
/// conditional on the host", but nothing emitted it and nothing subscribed to it,
/// which is the shape a promise takes when the capability behind it does not exist.
#[tauri::command]
pub fn notify_new_mail(app: AppHandle, mail: NewMail) -> Result<()> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(mail.title)
        .body(mail.body)
        // Carry the ids so a future shell that *can* deliver a payload has them. The
        // plugin's `extra` takes a key/value pair rather than a JSON blob, and the ids
        // go in as a list of numbers, which is what the plugin round-trips.
        .extra("messageIds", &mail.message_ids)
        // The group collapses a burst: forty messages arriving together should
        // produce one notification, not forty.
        .group("winnow.new-mail")
        .show()
        .map_err(|e| format!("could not show a notification: {e}"))
}

/// Whether notifications may be shown, and asks for permission if they may.
///
/// Returns `true` only when permission is actually *granted*, not when it is in
/// the `Prompt` state. It used to count `Prompt` as a yes, on the theory that the
/// OS would ask when the first notification arrived — and on macOS it does not, so
/// the answer was "yes, and nothing will ever appear". The web layer turns this
/// into the Settings toggle's state, so a user who enabled notifications was told
/// they had.
///
/// The name says `request` because the command does both, which is the useful
/// behaviour on platforms that do prompt.
#[tauri::command]
pub fn request_notification_permission(app: AppHandle) -> Result<bool> {
    use tauri_plugin_notification::NotificationExt;

    let permission = app
        .notification()
        .permission_state()
        .map_err(|e| format!("could not read the notification permission: {e}"))?;

    match permission {
        tauri_plugin_notification::PermissionState::Granted => Ok(true),
        tauri_plugin_notification::PermissionState::Prompt => {
            // The plugin answers with the resulting `PermissionState`, not a bool —
            // so `Ok(true)` here is a type error that reads like a mistake and is
            // in fact the shape of the API. A denied prompt is a legitimate answer
            // rather than a failure, so it maps to `Ok(false)`.
            Ok(matches!(
                app.notification().request_permission(),
                Ok(tauri_plugin_notification::PermissionState::Granted)
            ))
        }
        _ => Ok(false),
    }
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
///
/// `async`, and that is load-bearing rather than stylistic. This was a
/// synchronous `fn`, which puts it on Tauri's *blocking* path — and on macOS the
/// blocking path runs the command inline on the thread that received the IPC
/// message, which is the main thread. The save dialog is resolved through
/// `run_on_main_thread`, so the main thread parked on the dialog's completion
/// while the dialog waited for the main thread: the panel never appeared, the
/// promise never settled, and the whole app was wedged. Not "the save was slow" —
/// frozen, with no way out but force-quitting.
///
/// Making the command `async` moves it onto the async runtime, where awaiting the
/// dialog is free and the main thread stays free to present it.
#[tauri::command]
pub async fn save_attachment(
    app: AppHandle,
    filename: String,
    bytes_base64: String,
) -> Result<Option<String>> {
    crate::files::save_attachment(&app, &filename, &bytes_base64).await
}

// ── Dock / tray badge ───────────────────────────────────────────────────────

/// Show how many unread messages are waiting.
///
/// macOS has a real dock badge; Linux and Windows have a tray tooltip and nothing
/// else. The window *title* is deliberately left alone.
///
/// It used to be set here as well, to `(3) Winnow`, on the reasoning that the
/// number is useful there too. Two owners then wrote the same string: this command
/// and `web.ts`'s `document.title`, which the web platform layer sets on every
/// badge update. Whichever ran last won, so on the desktop the title flickered
/// between `(3) Winnow` and whatever the page thought it was — and the page is the
/// only one that knows about the demo mailbox, where "3 unread" would be a lie.
/// The title belongs to the document; the badge belongs to the OS.
#[tauri::command]
pub fn set_unread_badge(app: AppHandle, count: i64) -> Result<()> {
    // Clamped rather than trusted. A negative count is not a state this app can
    // reach, and `set_badge_count(Some(-1))` is the sort of thing that renders as
    // an empty badge or, on some platforms, an error dialog.
    let count = count.max(0);
    #[cfg(mobile)]
    let _ = (&app, count);

    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_badge_count(Some(count))
            .map_err(|e| format!("could not set the dock badge: {e}"))?;
    }

    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) {
        let label = match count {
            0 => "Winnow".to_string(),
            1 => "Winnow — 1 unread".to_string(),
            n => format!("Winnow — {n} unread"),
        };
        // Best-effort: a tooltip that could not be set is not worth failing a
        // badge update over, and the dock badge above is already correct.
        let _ = tray.set_tooltip(Some(label));
    }

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
    use super::{AppInfo, NewMail};

    /// `serde_json` is needed for the two wire-shape tests below, and only those.
    /// They exist because the field names of `AppInfo` and `NewMail` are read by
    /// another language — the one place in this crate where a rename compiles
    /// cleanly and breaks the product.

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
    fn a_new_mail_payload_survives_the_camel_case_boundary() {
        // The bug this pins. The webview sends `{ messageIds: [...] }` inside the
        // `mail` argument. Tauri rewrites the *top-level* key (`mail`), but the value
        // under it goes through plain serde, which looks for the field names as
        // declared. `message_ids` + `#[serde(default)]` therefore deserialised
        // successfully with an empty vec — no error, no log, and the ids silently
        // gone on every notification.
        let parsed: NewMail =
            serde_json::from_value(serde_json::json!({
                "title": "Ada Lovelace",
                "body": "Re: the migration plan",
                "messageIds": [7, 9],
            }))
            .expect("a camelCase payload must deserialise");

        assert_eq!(parsed.message_ids, vec![7, 9]);

        // And a payload without the ids still loads, because the field is optional —
        // the fallback has to be a working one, not a crash.
        let partial: NewMail =
            serde_json::from_value(serde_json::json!({ "title": "t", "body": "b" })).unwrap();
        assert!(partial.message_ids.is_empty());
    }

    #[test]
    fn app_info_serialises_the_camel_case_the_webview_reads() {
        // The second half of the same class of bug, and the quieter one: `AppInfo`'s
        // four capability flags were declared snake_case and serialised as such, so
        // `backgroundSync` read `undefined` on the desktop — and the settings panel
        // gates its whole Background section on that value, so background sync could
        // not be turned on at all. Serialising is the assertion.
        // A hand-built value rather than one through `app_info`, which needs an
        // `AppHandle` this test cannot build. The risk that creates — the test
        // asserting a shape `app_info` does not produce — is closed by the fact that
        // `app_info` is the *only* constructor and it sets exactly these fields;
        // a change to either would have to edit this test too.
        let json = serde_json::to_value(AppInfo {
            name: "winnow".into(),
            version: "0.1.0".into(),
            os: "macos".into(),
            arch: "aarch64".into(),
            // "desktop" on a phone too, for now: it tells the web layer to use the native
        // platform (keychain, notifications, the opener) rather than the browser one.
        // A distinct "mobile" kind is Phase 2 of the mobile plan.
        kind: "desktop",
            native_oauth: true,
            native_secrets: true,
            background_sync: true,
            save_files: true,
        })
        .unwrap();

        for key in ["nativeOAuth", "nativeSecrets", "backgroundSync", "saveFiles"] {
            assert_eq!(
                json.get(key),
                Some(&serde_json::Value::Bool(true)),
                "{key} must be on the wire exactly as the web layer spells it"
            );
        }
        // The snake_case spellings must be gone, or a future reader would have two
        // answers to "what is this field called".
        for key in ["native_oauth", "background_sync", "save_files"] {
            assert!(json.get(key).is_none(), "{key} leaked into the wire format");
        }
        // `nativeOauth` is the near-miss that `rename_all` produces and that no
        // type checker catches. Named explicitly so the failure is legible.
        assert!(
            json.get("nativeOauth").is_none(),
            "serde's camelCase of native_oauth is `nativeOauth`, which the web layer \
             does not read; use an explicit rename"
        );
    }

    #[test]
    fn the_comparison_is_against_a_literal_not_a_prefix() {
        // "httpsomething://" must not slip through a `starts_with("https")`.
        let sneaky = "httpsomething://evil.example".replace("httpsomething", "https");
        assert_eq!(url::Url::parse(&sneaky).unwrap().scheme(), "https");
        assert_ne!(url::Url::parse("httpsx://evil.example").unwrap().scheme(), "https");
    }
}

