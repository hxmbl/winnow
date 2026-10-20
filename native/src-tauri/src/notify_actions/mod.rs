//! Actionable new-mail notifications: Reply, Delete, Mark read, and a tap that opens
//! the message.
//!
//! The web layer decides *what* to announce (unread, inbox, not muted or hidden, at
//! most [`MAX_CHILDREN`] messages, the user's action and preview settings) and hands
//! one [`NotificationBatch`] to [`notify_messages`]. What happens next depends on the
//! host, because what each OS can do differs:
//!
//! | Host | Shown by | Actions | Where an action runs |
//! | --- | --- | --- | --- |
//! | Android | `NotifyPlugin.kt` (MessagingStyle, group summary) | Reply inline (RemoteInput), Delete, Mark read; Undo after Delete | **Natively**: [`android`] runs [`plan::execute`] with the keychain tokens, the Kotlin plugin does the HTTPS. The webview may be paused or gone. |
//! | Linux, Windows | `notify-rust` (D-Bus / WinRT toast) | Open, Reply (opens the composer), Mark read, Delete | In the webview: [`ACTION_EVENT`] → the store, the same calls as the app's own buttons. The window is hidden, not paused. |
//! | macOS | `tauri-plugin-notification`, one grouped notification | None: a click activates the app (`RunEvent::Reopen`) | — |
//!
//! `MAP.md` §8.3 has the full matrix and why macOS is click-to-open.

pub mod plan;

#[cfg(target_os = "android")]
mod android;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod desktop;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// The webview's subscription (`desktop.ts`). One name, both directions of travel:
/// a desktop click asking the webview to act, and an Android action reporting that
/// it already has.
pub const ACTION_EVENT: &str = "winnow://notification-action";

/// Per-message notifications at most; the rest are counted in the summary.
pub const MAX_CHILDREN: usize = 5;

/// Display strings are cut here: a notification is not a reader.
const MAX_TEXT: usize = 240;

/// The longest picture data URL accepted, in characters (`NATIVE_PICTURE_MAX_CHARS` in
/// the web layer's `notificationActions.ts`).
pub const MAX_PICTURE_CHARS: usize = 200_000;

/// The plugin's name, as Tauri registers it.
pub const PLUGIN_NAME: &str = "winnow-notify";

type Result<T> = std::result::Result<T, String>;

/// Which buttons to offer (Settings → Notifications & sync).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionSet {
    #[serde(default = "yes")]
    pub reply: bool,
    #[serde(default = "yes")]
    pub trash: bool,
    #[serde(default = "yes")]
    pub read: bool,
}

fn yes() -> bool {
    true
}

impl Default for ActionSet {
    fn default() -> Self {
        Self {
            reply: true,
            trash: true,
            read: true,
        }
    }
}

/// One message's notification.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageNotice {
    /// The store's numeric id (`winnow://message/<id>` opens it).
    pub message_id: i64,
    pub gmail_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    /// Who it is from, as the list shows it.
    pub title: String,
    /// The subject.
    #[serde(default)]
    pub subject: String,
    /// The first line of the message, or empty.
    #[serde(default)]
    pub preview: String,
    /// Epoch milliseconds.
    #[serde(default)]
    pub received_at: i64,
    /// The composer's header block for a reply (see `plan.rs`). Absent: no inline reply.
    #[serde(default)]
    pub reply_head: Option<String>,
    /// The sender's picture, resolved by the web layer under the avatar settings
    /// (`resolveSenderPicture`) and rasterised there to a small PNG/JPEG data URL
    /// (`nativePictures`); absent or null: none. Drawn as the large icon on Android and
    /// the notification image on Linux/Windows; macOS's grouped notification has none.
    /// Never fetched here: anything but a valid data URL is dropped by [`sanitised`].
    #[serde(default)]
    pub picture: Option<String>,
}

/// Whose mail a batch is (1.4.0): every press and tap names the account, so it acts on
/// that account and opens its inbox. `label` (the address) is shown only when the web
/// layer sends it, which it does with more than one account signed in.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAccount {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// Everything one sync wants to announce.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationBatch {
    /// Absent from a 1.3.5 web layer; a malformed id is dropped by [`sanitised`].
    #[serde(default)]
    pub account: Option<NotificationAccount>,
    /// How many messages arrived, which may be more than `messages`.
    pub total: u32,
    pub summary_title: String,
    #[serde(default)]
    pub summary_body: String,
    pub messages: Vec<MessageNotice>,
    #[serde(default)]
    pub actions: ActionSet,
    /// Lock screen: show "New message" instead of sender and subject.
    #[serde(default)]
    pub hide_preview: bool,
}

impl NotificationBatch {
    /// Cap, drop what cannot be acted on safely, and cut long strings.
    pub fn sanitised(mut self) -> Self {
        self.account = self
            .account
            .take()
            .filter(|account| plan::valid_account_id(&account.id))
            .map(|NotificationAccount { id, label }| NotificationAccount {
                id,
                label: label.map(|l| clip(&l)).filter(|l| !l.is_empty()),
            });
        self.messages.retain(|m| plan::valid_gmail_id(&m.gmail_id));
        self.messages.truncate(MAX_CHILDREN);
        let hide_preview = self.hide_preview;
        for message in &mut self.messages {
            // A hidden preview hides who it is from; a picture would say it.
            if hide_preview {
                message.picture = None;
            }
            // Only bytes, never an address to fetch.
            message.picture = message
                .picture
                .take()
                .filter(|p| picture_bytes(p).is_some());
            message.title = clip(&message.title);
            message.subject = clip(&message.subject);
            message.preview = clip(&message.preview);
            message.thread_id = message
                .thread_id
                .take()
                .filter(|id| plan::valid_gmail_id(id));
            // A head with no reply to make is dropped rather than half-used.
            message.reply_head = message
                .reply_head
                .take()
                .filter(|head| plan::assemble_reply(head, "x", 0).is_ok());
        }
        self.summary_title = clip(&self.summary_title);
        self.summary_body = clip(&self.summary_body);
        self.total = self.total.max(self.messages.len() as u32);
        self
    }
}

/// The image bytes in a picture data URL (`data:image/png;base64,…` or JPEG), or `None`
/// for anything else: a URL, another type, bad base64, too long, or bytes that do not
/// start with the type's signature.
pub(crate) fn picture_bytes(picture: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    if picture.len() > MAX_PICTURE_CHARS {
        return None;
    }
    let (signature, data): (&[u8], &str) =
        if let Some(rest) = picture.strip_prefix("data:image/png;base64,") {
            (b"\x89PNG\r\n\x1a\n", rest)
        } else {
            let rest = picture.strip_prefix("data:image/jpeg;base64,")?;
            (b"\xff\xd8\xff", rest)
        };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    bytes.starts_with(signature).then_some(bytes)
}

fn clip(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_TEXT {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(MAX_TEXT - 1).collect();
    out.push('…');
    out
}

/// What the webview hears about an action.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionEvent {
    /// `open`, `reply`, `read`, `trash` (desktop: please do it) or the same names plus
    /// `untrash` from Android (already done).
    pub action: String,
    pub message_id: i64,
    pub gmail_id: String,
    /// `desktop` or `android`.
    pub origin: &'static str,
    /// Android only: `done` or `failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<&'static str>,
    /// The notification's account (1.4.0), when the batch named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// The confirmation the webview asks for after acting on a desktop click.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub message_id: i64,
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub failed: bool,
}

/// Show one batch of new-mail notifications.
#[tauri::command]
pub fn notify_messages(app: AppHandle, batch: NotificationBatch) -> Result<()> {
    let batch = batch.sanitised();
    if batch.messages.is_empty() && batch.total == 0 {
        return Ok(());
    }
    show(&app, batch)
}

#[cfg(target_os = "android")]
fn show(app: &AppHandle, batch: NotificationBatch) -> Result<()> {
    android::show(app, &batch)
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn show(app: &AppHandle, batch: NotificationBatch) -> Result<()> {
    desktop::show(app, batch)
}

/// macOS: `tauri-plugin-notification` exposes no click payload or actions there, and
/// `notify-rust`'s action path is `NSUserNotificationCenter` blocking a thread per
/// notification, which this project cannot test. So the batch becomes the one grouped
/// notification it always was, and a click reveals the window (`lib.rs`, `Reopen`).
#[cfg(not(any(target_os = "android", target_os = "linux", target_os = "windows")))]
fn show(app: &AppHandle, batch: NotificationBatch) -> Result<()> {
    use tauri_plugin_notification::NotificationExt;
    let (title, body) = summary_text(&batch);
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .group("winnow.new-mail")
        .show()
        .map_err(|e| format!("could not show a notification: {e}"))
}

/// The one-line form of a batch: a single message names its sender and subject.
#[allow(dead_code)]
pub(crate) fn summary_text(batch: &NotificationBatch) -> (String, String) {
    match batch.messages.as_slice() {
        [only] if batch.total <= 1 => {
            if batch.hide_preview {
                (only.title.clone(), "New message".into())
            } else {
                (only.title.clone(), only.subject.clone())
            }
        }
        _ => (
            batch.summary_title.clone(),
            if batch.hide_preview {
                String::new()
            } else {
                batch.summary_body.clone()
            },
        ),
    }
}

/// After the webview acted on a desktop click: say so on the notification.
#[tauri::command]
pub fn notify_action_result(app: AppHandle, result: ActionResult) -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        desktop::confirm(&app, &result);
    }
    let _ = (app, result);
    Ok(())
}

/// Replies (and their context) the Android side kept because they could not be sent
/// or saved, for the web layer to save to Drafts now that it is running. Listing does
/// not remove them: [`notify_release_kept`] does, once each is saved. Empty elsewhere.
#[tauri::command]
pub fn notify_kept_replies(app: AppHandle) -> Result<Vec<serde_json::Value>> {
    #[cfg(target_os = "android")]
    {
        android::kept_replies(&app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

/// Forget kept replies that are now safely in Gmail's Drafts.
#[tauri::command]
pub fn notify_release_kept(app: AppHandle, ids: Vec<String>) -> Result<()> {
    #[cfg(target_os = "android")]
    {
        android::release_kept(&app, ids)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, ids);
        Ok(())
    }
}

/// Register the plugin: the Kotlin half on Android, the shown-notification table on
/// the desktop.
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry>::new(PLUGIN_NAME)
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            android::register(app, api)?;
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri::Manager;
                app.manage(desktop::Shown::default());
                let _ = api;
            }
            #[cfg(not(any(target_os = "android", target_os = "linux", target_os = "windows")))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head() -> String {
        "To: a@b.co\r\nSubject: Re: x\r\nDate: Thu, 01 Jan 1970 00:00:00 GMT\r\nIn-Reply-To: <p@q.r>\r\nReferences: <p@q.r>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n".into()
    }

    fn notice(id: &str) -> MessageNotice {
        MessageNotice {
            message_id: 1,
            gmail_id: id.into(),
            thread_id: Some("t1".into()),
            title: "Ada".into(),
            subject: "Plan".into(),
            preview: "x".repeat(500),
            received_at: 0,
            reply_head: Some(head()),
            picture: None,
        }
    }

    #[test]
    fn the_web_layer_payload_deserialises() {
        let json = r#"{"total":7,"summaryTitle":"7 new messages","summaryBody":"Ada, Bob",
            "messages":[{"messageId":3,"gmailId":"abc","threadId":"def","title":"Ada","subject":"Hi",
            "preview":"Hello","receivedAt":1,"replyHead":null}],
            "actions":{"reply":false,"trash":true,"read":true},"hidePreview":true}"#;
        let batch: NotificationBatch = serde_json::from_str(json).unwrap();
        assert_eq!(batch.total, 7);
        assert!(!batch.actions.reply);
        assert!(batch.hide_preview);
        assert_eq!(batch.account, None);
        assert_eq!(batch.messages[0].thread_id.as_deref(), Some("def"));
        let tagged: NotificationBatch = serde_json::from_str::<NotificationBatch>(
            r#"{"account":{"id":"acct2","label":"two@x.co"},"total":1,"summaryTitle":"x","messages":[]}"#,
        )
        .unwrap()
        .sanitised();
        assert_eq!(
            tagged.account,
            Some(NotificationAccount {
                id: "acct2".into(),
                label: Some("two@x.co".into())
            })
        );
        // Missing settings mean everything on, not everything off.
        let bare: NotificationBatch =
            serde_json::from_str(r#"{"total":1,"summaryTitle":"x","messages":[]}"#).unwrap();
        assert_eq!(bare.actions, ActionSet::default());
        assert!(!bare.hide_preview);
    }

    #[test]
    fn the_picture_is_carried_as_bytes_and_dropped_when_previews_are_hidden() {
        const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let with = |picture: &str| {
            let mut n = notice("p1");
            n.picture = Some(picture.into());
            n
        };
        let batch = |picture: &str, hide_preview: bool| NotificationBatch {
            account: None,
            total: 1,
            summary_title: "Ada".into(),
            summary_body: String::new(),
            messages: vec![with(picture)],
            actions: ActionSet::default(),
            hide_preview,
        };
        assert_eq!(
            batch(PNG, false).sanitised().messages[0].picture.as_deref(),
            Some(PNG)
        );
        assert_eq!(batch(PNG, true).sanitised().messages[0].picture, None);
        // A URL is never fetched natively: dropped, so the app icon shows.
        assert_eq!(
            batch("https://example.test/a.png", false)
                .sanitised()
                .messages[0]
                .picture,
            None
        );
        // An older web layer sends no picture at all.
        let old: MessageNotice =
            serde_json::from_str(r#"{"messageId":1,"gmailId":"a","title":"Ada"}"#).unwrap();
        assert_eq!(old.picture, None);
    }

    #[test]
    fn only_png_or_jpeg_bytes_with_their_signature_are_pictures() {
        assert!(picture_bytes("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==").is_some());
        assert!(picture_bytes("data:image/jpeg;base64,/9j/4AAQSkZJRg==").is_some());
        // Declared PNG, but the bytes are not one.
        assert!(picture_bytes("data:image/png;base64,aGVsbG8=").is_none());
        assert!(picture_bytes("data:image/svg+xml;base64,PHN2Zz4=").is_none());
        assert!(picture_bytes("data:image/png;base64,!!!").is_none());
        assert!(picture_bytes("https://gravatar.com/avatar/x").is_none());
        let long = format!("data:image/png;base64,{}", "A".repeat(MAX_PICTURE_CHARS));
        assert!(picture_bytes(&long).is_none());
    }

    #[test]
    fn sanitising_caps_children_and_drops_unsafe_ids() {
        let mut messages: Vec<MessageNotice> = (0..8).map(|i| notice(&format!("m{i}"))).collect();
        messages.insert(0, notice("../evil"));
        let mut broken = notice("ok1");
        broken.reply_head = Some("To: x\r\n".into());
        broken.thread_id = Some("bad id".into());
        messages.insert(1, broken);
        let batch = NotificationBatch {
            account: Some(NotificationAccount {
                id: "../evil".into(),
                label: Some("x".into()),
            }),
            total: 9,
            summary_title: "9 new messages".into(),
            summary_body: String::new(),
            messages,
            actions: ActionSet::default(),
            hide_preview: false,
        }
        .sanitised();
        assert_eq!(batch.messages.len(), MAX_CHILDREN);
        // An account id that is not one never reaches a keychain name or a link.
        assert_eq!(batch.account, None);
        assert_eq!(batch.messages[0].gmail_id, "ok1");
        assert_eq!(batch.messages[0].reply_head, None);
        assert_eq!(batch.messages[0].thread_id, None);
        assert!(batch.messages[1].reply_head.is_some());
        assert!(batch.messages[1].preview.chars().count() <= MAX_TEXT);
        assert_eq!(batch.total, 9);
    }

    #[test]
    fn hidden_previews_never_name_the_subject() {
        let batch = NotificationBatch {
            account: None,
            total: 1,
            summary_title: "1 new message".into(),
            summary_body: "Ada".into(),
            messages: vec![notice("abc")],
            actions: ActionSet::default(),
            hide_preview: true,
        };
        let (title, body) = summary_text(&batch);
        assert_eq!(title, "Ada");
        assert_eq!(body, "New message");
    }

    #[test]
    fn the_event_serialises_camel_case() {
        let event = ActionEvent {
            action: "trash".into(),
            message_id: 9,
            gmail_id: "abc".into(),
            origin: "android",
            outcome: Some("done"),
            account: Some("acct2".into()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["account"], "acct2");
        assert_eq!(json["messageId"], 9);
        assert_eq!(json["gmailId"], "abc");
        assert_eq!(json["outcome"], "done");
        let desktop = ActionEvent {
            outcome: None,
            origin: "desktop",
            account: None,
            ..event
        };
        assert!(serde_json::to_value(&desktop)
            .unwrap()
            .get("outcome")
            .is_none());
    }
}
