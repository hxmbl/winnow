//! Linux and Windows: one `notify-rust` notification per message, with buttons.
//!
//! Linux sends them over D-Bus (`org.freedesktop.Notifications`, actions are part
//! of the spec; whether the buttons are drawn is up to the notification server —
//! GNOME, KDE, dunst and mako all draw them). Windows sends a WinRT toast with
//! buttons. Neither has an inline reply `notify-rust` can reach (KDE's
//! `inline-reply` is a vendor extension it does not expose; WinRT toast inputs are
//! not in `tauri-winrt-notification`), so Reply opens the composer.
//!
//! The click is handed to the webview ([`ACTION_EVENT`]): the window is only
//! hidden, its JavaScript keeps running (the scheduler relies on that too), and the
//! store's own `setRead` / `moveWithUndo` are the same calls the app's buttons make.
//!
//! Each notification waits for its click on its own thread (`wait_for_action`
//! blocks until the notification closes). There are at most [`MAX_CHILDREN`] + 1.

use super::{
    shown, summary_text, ActionEvent, ActionResult, Books, NotificationBatch, ACTION_EVENT,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

/// Linux notification ids by message id, so a confirmation replaces the notification
/// it is about instead of adding another.
#[derive(Default)]
pub struct Shown(Mutex<HashMap<i64, u32>>);

/// Map a `notify-rust` action id to the webview's action name.
pub(crate) fn action_name(id: &str) -> Option<&'static str> {
    match id {
        "default" | "open" => Some("open"),
        "reply" => Some("reply"),
        "read" => Some("read"),
        "trash" => Some("trash"),
        // "__closed" and anything a server invents.
        _ => None,
    }
}

pub fn show(app: &AppHandle, batch: NotificationBatch) -> Result<(), String> {
    let actions = batch.actions;
    // Whose mail (1.4.0): every press names the account; with several signed in, the
    // body says which.
    let account = batch.account.as_ref().map(|a| a.id.clone());
    let whose = batch
        .account
        .as_ref()
        .and_then(|a| a.label.clone())
        .map(|label| format!("\n{label}"))
        .unwrap_or_default();
    for message in batch.messages.iter().cloned() {
        let app = app.clone();
        let hide = batch.hide_preview;
        let account = account.clone();
        let ledger_account = account.clone();
        let whose = whose.clone();
        std::thread::spawn(move || {
            let mut n = base();
            n.summary(&message.title);
            if hide {
                n.body(&format!("New message{whose}"));
            } else if message.preview.is_empty() {
                n.body(&format!("{}{whose}", message.subject));
            } else {
                n.body(&format!("{}\n{}{whose}", message.subject, message.preview));
            }
            // The sender's picture: Linux's `image-path` hint (drawn as the notification's
            // image by GNOME, KDE, dunst and mako), Windows's toast image. A picture that
            // cannot be written leaves the app icon.
            let picture = message.picture.as_deref().and_then(write_picture);
            if let Some(path) = picture.as_deref() {
                n.image_path(&path.to_string_lossy());
            }
            n.action("default", "Open");
            if actions.reply {
                n.action("reply", "Reply");
            }
            if actions.read {
                n.action("read", "Mark read");
            }
            if actions.trash {
                n.action("trash", "Delete");
            }
            let Ok(handle) = n.show() else { return };
            #[cfg(target_os = "linux")]
            if let Some(shown) = app.try_state::<Shown>() {
                shown.0.lock().insert(message.message_id, handle.id());
            }
            // The books, so the notification can take itself down when its mail no longer
            // needs attention (`notify_withdraw`). Windows has no id to close by; a number
            // of our own stands in, for the books only.
            #[cfg(target_os = "linux")]
            let os_id = handle.id();
            #[cfg(not(target_os = "linux"))]
            let os_id = next_pseudo_id();
            if let Some(books) = app.try_state::<Books>() {
                books.0.lock().record_message(
                    ledger_account.clone(),
                    message.gmail_id.clone(),
                    os_id,
                );
            }
            let id = message.message_id;
            let gmail = message.gmail_id.clone();
            handle.wait_for_action(|action| {
                if let Some(name) = action_name(action) {
                    if name == "open" || name == "reply" {
                        crate::tray::reveal(&app);
                    }
                    let _ = app.emit(
                        ACTION_EVENT,
                        ActionEvent {
                            action: name.into(),
                            message_id: id,
                            gmail_id: gmail.clone(),
                            origin: "desktop",
                            outcome: None,
                            account: account.clone(),
                        },
                    );
                }
            });
            #[cfg(target_os = "linux")]
            if let Some(shown) = app.try_state::<Shown>() {
                shown.0.lock().remove(&id);
            }
            // Closed: clicked, dismissed, expired, or taken down by `apply`.
            if let Some(books) = app.try_state::<Books>() {
                books.0.lock().closed(os_id);
            }
            // The notification has closed; its picture is not needed any more.
            if let Some(path) = picture {
                let _ = std::fs::remove_file(path);
            }
        });
    }

    // More arrived than were shown: one summary for the rest, which opens the account's
    // inbox (`inbox` names no message).
    if batch.total as usize > batch.messages.len() {
        let (title, body) = summary_text(&batch);
        let app = app.clone();
        let shown_ids: Vec<String> = batch.messages.iter().map(|m| m.gmail_id.clone()).collect();
        let rest_ids = batch.rest_ids.clone();
        std::thread::spawn(move || {
            let mut n = base();
            n.summary(&title)
                .body(&format!("{body}{whose}"))
                .action("default", "Open");
            if let Ok(handle) = n.show() {
                #[cfg(target_os = "linux")]
                let os_id = handle.id();
                #[cfg(not(target_os = "linux"))]
                let os_id = next_pseudo_id();
                if let Some(books) = app.try_state::<Books>() {
                    books
                        .0
                        .lock()
                        .record_summary(account.clone(), os_id, &shown_ids, &rest_ids);
                }
                handle.wait_for_action(|action| {
                    if action_name(action) == Some("open") {
                        crate::tray::reveal(&app);
                        let _ = app.emit(
                            ACTION_EVENT,
                            ActionEvent {
                                action: "inbox".into(),
                                message_id: 0,
                                gmail_id: String::new(),
                                origin: "desktop",
                                outcome: None,
                                account: account.clone(),
                            },
                        );
                    }
                });
                if let Some(books) = app.try_state::<Books>() {
                    books.0.lock().closed(os_id);
                }
            }
        });
    }
    Ok(())
}

/// Stand-in ids for the books where the desktop gives none (Windows), never 0.
#[cfg(not(target_os = "linux"))]
fn next_pseudo_id() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Take notifications down as a dismissal asks (`notify_withdraw`, `notify_clear_account`).
///
/// - **Linux**: `CloseNotification` for each over the session bus (the spec's own call,
///   which every server implements); the summary is re-shown under its id with the new
///   count (servers replace it in place) or closed. Off the calling thread: a D-Bus
///   round trip should not hold up the webview's command.
/// - **Windows**: `notify-rust` builds toasts with no tag or group, and those are what
///   `ToastNotificationHistory` removes single toasts by, so one cannot be picked out.
///   Once none of Winnow's toasts needs attention, its Action Center entries are cleared
///   (`ClearWithId`). Until then they stay.
pub fn apply(app: &AppHandle, change: shown::Change, account: &Option<String>) {
    #[cfg(target_os = "linux")]
    {
        let _ = (app, account);
        let shown::Change {
            close,
            close_summary,
            update_summary,
            ..
        } = change;
        if close.is_empty() && close_summary.is_none() && update_summary.is_none() {
            return;
        }
        std::thread::spawn(move || {
            let Ok(bus) = zbus::blocking::Connection::session() else {
                return;
            };
            for id in close.into_iter().chain(close_summary) {
                let _ = bus.call_method(
                    Some("org.freedesktop.Notifications"),
                    "/org/freedesktop/Notifications",
                    Some("org.freedesktop.Notifications"),
                    "CloseNotification",
                    &id,
                );
            }
            if let Some((id, counted, rest)) = update_summary {
                let (title, body) = shown::summary_text(counted, rest);
                let mut n = base();
                n.summary(&title)
                    .body(&body)
                    .action("default", "Open")
                    .id(id);
                // No new sound or banner for a smaller number: it replaces what is there.
                n.hint(notify_rust::Hint::SuppressSound(true));
                n.hint(notify_rust::Hint::Transient(false));
                let _ = n.show();
            }
        });
    }
    #[cfg(target_os = "windows")]
    {
        let _ = account;
        if change.nothing_left {
            clear_windows(app);
        }
    }
}

#[cfg(target_os = "windows")]
fn clear_windows(app: &AppHandle) {
    let _ = app;
    // Only the installed app has this AppUserModelID; a dev build under `target/` posts
    // as PowerShell (see `base`), whose history is not Winnow's to clear.
    let installed = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.display().to_string()))
        .map(|dir| {
            let sep = std::path::MAIN_SEPARATOR;
            !(dir.ends_with(&format!("{sep}target{sep}debug"))
                || dir.ends_with(&format!("{sep}target{sep}release")))
        })
        .unwrap_or(false);
    if !installed {
        return;
    }
    if let Ok(history) = windows::UI::Notifications::ToastNotificationManager::History() {
        let _ = history.ClearWithId(&windows::core::HSTRING::from("app.winnow.desktop"));
    }
}

/// Linux: replace the notification with a short confirmation that expires. Windows:
/// the toast has already gone when its button was pressed, so only a failure, which
/// the user has to know about, gets a toast of its own.
pub fn confirm(app: &AppHandle, result: &ActionResult) {
    #[cfg(target_os = "linux")]
    {
        let id = app
            .try_state::<Shown>()
            .and_then(|shown| shown.0.lock().get(&result.message_id).copied());
        let mut n = base();
        n.summary(&result.title).body(&result.text);
        n.timeout(notify_rust::Timeout::Milliseconds(if result.failed {
            8000
        } else {
            3000
        }));
        if let Some(id) = id {
            n.id(id);
        }
        let _ = n.show();
    }
    #[cfg(target_os = "windows")]
    if result.failed {
        let mut n = base();
        n.summary(&result.title).body(&result.text);
        let _ = n.show();
    }
    let _ = app;
}

/// Where notification pictures are written: a private folder under the temp dir.
fn picture_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("winnow-notify")
}

/// Write a picture data URL's bytes to a file the notification server can read, named
/// by a hash of the bytes. `None` for anything [`super::picture_bytes`] rejects, or when
/// the file cannot be written.
pub(crate) fn write_picture(picture: &str) -> Option<std::path::PathBuf> {
    write_picture_in(&picture_dir(), picture)
}

pub(crate) fn write_picture_in(dir: &std::path::Path, picture: &str) -> Option<std::path::PathBuf> {
    use std::hash::{Hash, Hasher};
    let bytes = super::picture_bytes(picture)?;
    let extension = if bytes.starts_with(b"\x89PNG") {
        "png"
    } else {
        "jpg"
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join(format!("{:016x}.{extension}", hasher.finish()));
    std::fs::write(&path, &bytes).ok()?;
    Some(path)
}

fn base() -> notify_rust::Notification {
    let mut n = notify_rust::Notification::new();
    n.appname("Winnow");
    n.auto_icon();
    #[cfg(target_os = "linux")]
    {
        n.hint(notify_rust::Hint::Category("email.arrived".into()));
        n.hint(notify_rust::Hint::DesktopEntry("winnow".into()));
    }
    // The installed app's AppUserModelID, as `tauri-plugin-notification` sets it; a
    // dev build under `target/` has none registered and would show nothing with it.
    #[cfg(target_os = "windows")]
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let sep = std::path::MAIN_SEPARATOR;
        if !(dir.ends_with(&format!("{sep}target{sep}debug"))
            || dir.ends_with(&format!("{sep}target{sep}release")))
        {
            n.app_id("app.winnow.desktop");
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::{action_name, write_picture_in};

    #[test]
    fn a_picture_is_written_as_its_bytes_and_a_url_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let path = write_picture_in(dir.path(), png).expect("written");
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
        assert!(std::fs::read(&path).unwrap().starts_with(b"\x89PNG"));
        assert!(write_picture_in(dir.path(), "https://example.test/a.png").is_none());
        assert!(write_picture_in(dir.path(), "data:image/png;base64,aGVsbG8=").is_none());
    }

    #[test]
    fn only_known_actions_reach_the_webview() {
        assert_eq!(action_name("default"), Some("open"));
        assert_eq!(action_name("reply"), Some("reply"));
        assert_eq!(action_name("read"), Some("read"));
        assert_eq!(action_name("trash"), Some("trash"));
        assert_eq!(action_name("__closed"), None);
        assert_eq!(action_name("delete-forever"), None);
    }
}
