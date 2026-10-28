//! Android: the Kotlin half (`app/winnow/android/notify/`) shows the notifications and
//! receives the button presses; this half decides and runs the action.
//!
//! **Why natively, not in the webview.** A notification action arrives while Winnow
//! is in the background, where Android pauses the WebView (the same pause that made
//! sign-in need `waitForForeground`): a `fetch` started then does not reach Google.
//! So the receiver (`NotifyActionReceiver.kt`) reports the press over a channel to
//! [`run`], which reads the tokens from the Keystore-backed keychain, runs
//! [`plan::execute`], and asks Kotlin to perform each HTTPS exchange
//! (`HttpURLConnection`; this crate has no TLS client). Kotlin then updates the
//! notification with the [`plan::Finish`], and the webview, if it is alive, is told
//! with [`ACTION_EVENT`] so it can refresh.
//!
//! The tokens cross JNI in this process only, for one action; Kotlin never stores
//! them. A refreshed access token is not written back: the web layer's
//! `TokenManager` owns the keychain entry, and one extra refresh is cheaper than two
//! writers.
//!
//! **When the process is gone** (Android killed it since the notification went up),
//! there is no Rust to report to. The receiver has already written a typed reply to
//! its own store before doing anything else, so it says "Couldn't send. Open Winnow"
//! and the web layer saves the reply to Drafts once it is signed in
//! ([`kept_replies`], then [`release_kept`] for each one saved).

use super::plan::{self, ActionRequest, HttpRequest, HttpResponse, Secrets};
use super::{ActionEvent, NotificationBatch, ACTION_EVENT};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::{PluginApi, PluginHandle};
use tauri::{AppHandle, Emitter, Manager, Wry};

const KOTLIN_PACKAGE: &str = "app.winnow.android.notify";
const KOTLIN_CLASS: &str = "NotifyPlugin";

/// The registered Kotlin plugin.
pub struct Native(pub PluginHandle<Wry>);

#[derive(Serialize)]
struct EventHandler {
    handler: Channel,
}

pub fn register(
    app: &AppHandle,
    api: PluginApi<Wry, ()>,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle = api.register_android_plugin(KOTLIN_PACKAGE, KOTLIN_CLASS)?;
    let for_events = handle.clone();
    let events_app = app.clone();
    handle.run_mobile_plugin::<()>(
        "setEventHandler",
        EventHandler {
            handler: Channel::new(move |body| {
                let request = match body {
                    InvokeResponseBody::Json(json) => {
                        serde_json::from_str::<ActionRequest>(&json).ok()
                    }
                    _ => None,
                };
                if let Some(request) = request {
                    let handle = for_events.clone();
                    let app = events_app.clone();
                    // Off the channel's thread: every exchange below waits on Kotlin.
                    std::thread::spawn(move || run(&app, &handle, request));
                }
                Ok(())
            }),
        },
    )?;
    app.manage(Native(handle));
    Ok(())
}

fn native(app: &AppHandle) -> Result<PluginHandle<Wry>, String> {
    app.try_state::<Native>()
        .map(|native| native.0.clone())
        .ok_or_else(|| "the notification plugin is not registered".to_string())
}

pub fn show(app: &AppHandle, batch: &NotificationBatch) -> Result<(), String> {
    native(app)?
        .run_mobile_plugin::<()>("show", batch)
        .map_err(|e| format!("could not show a notification: {e}"))
}

pub fn kept_replies(app: &AppHandle) -> Result<Vec<serde_json::Value>, String> {
    #[derive(serde::Deserialize)]
    struct Kept {
        #[serde(default)]
        items: Vec<serde_json::Value>,
    }
    native(app)?
        .run_mobile_plugin::<Kept>("keptReplies", ())
        .map(|kept| kept.items)
        .map_err(|e| format!("could not read kept replies: {e}"))
}

pub fn release_kept(app: &AppHandle, ids: Vec<String>) -> Result<(), String> {
    #[derive(Serialize)]
    struct Release {
        ids: Vec<String>,
    }
    native(app)?
        .run_mobile_plugin::<()>("releaseKept", Release { ids })
        .map_err(|e| format!("could not release kept replies: {e}"))
}

/// The `winnow://` link a notification's tap opened the app with, at most once
/// (`LaunchLinks.kt`): what [`crate::deep_link::deep_link_launch`] answers on Android.
pub fn launch_links(app: &AppHandle) -> Result<Vec<String>, String> {
    #[derive(serde::Deserialize)]
    struct Links {
        #[serde(default)]
        items: Vec<String>,
    }
    native(app)?
        .run_mobile_plugin::<Links>("launchLinks", ())
        .map(|links| links.items)
        .map_err(|e| format!("could not read the launch link: {e}"))
}

pub fn withdraw(
    app: &AppHandle,
    gmail_ids: Vec<String>,
    account: Option<String>,
) -> Result<(), String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Withdraw {
        gmail_ids: Vec<String>,
        account: Option<String>,
    }
    native(app)?
        .run_mobile_plugin::<()>("withdraw", Withdraw { gmail_ids, account })
        .map_err(|e| format!("could not withdraw notifications: {e}"))
}

pub fn clear_account(app: &AppHandle, account: Option<String>) -> Result<(), String> {
    #[derive(Serialize)]
    struct Clear {
        account: Option<String>,
    }
    native(app)?
        .run_mobile_plugin::<()>("clearAccount", Clear { account })
        .map_err(|e| format!("could not clear notifications: {e}"))
}

pub fn active(app: &AppHandle) -> Result<Vec<super::ActiveNotice>, String> {
    #[derive(serde::Deserialize)]
    struct Item {
        #[serde(default)]
        account: Option<String>,
        #[serde(rename = "gmailId")]
        gmail_id: String,
    }
    #[derive(serde::Deserialize)]
    struct Active {
        #[serde(default)]
        items: Vec<Item>,
    }
    native(app)?
        .run_mobile_plugin::<Active>("active", ())
        .map(|active| {
            active
                .items
                .into_iter()
                .map(|item| super::ActiveNotice {
                    account: item.account,
                    gmail_id: item.gmail_id,
                })
                .collect()
        })
        .map_err(|e| format!("could not list notifications: {e}"))
}

fn run(app: &AppHandle, handle: &PluginHandle<Wry>, request: ActionRequest) {
    // The notification's own account (1.4.0): its tokens, never another account's.
    let tokens = plan::tokens_secret_for(request.account.as_deref())
        .and_then(|name| crate::secrets::get(&name).ok().flatten());
    let secrets = Secrets {
        tokens,
        client: crate::secrets::get(plan::CLIENT_SECRET).ok().flatten(),
    };
    let mut transport = |exchange: &HttpRequest| -> HttpResponse {
        handle
            .run_mobile_plugin::<HttpResponse>("http", exchange)
            .unwrap_or(HttpResponse {
                status: 0,
                body: String::new(),
            })
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let outcome = plan::execute(&request, &secrets, now, &mut transport);
    let finish = plan::finish_for(&request, &outcome);
    let failed = finish.kind == "failed";
    let _ = handle.run_mobile_plugin::<()>("finish", &finish);
    if finish.kind != "restore" {
        let _ = app.emit(
            ACTION_EVENT,
            ActionEvent {
                action: request.action.clone(),
                message_id: request.message_id,
                gmail_id: request.gmail_id.clone(),
                origin: "android",
                outcome: Some(if failed { "failed" } else { "done" }),
                account: request.account.clone(),
            },
        );
    }
}
