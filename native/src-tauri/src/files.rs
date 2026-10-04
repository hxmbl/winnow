//! Writing bytes to a place the user chose.
//!
//! The web build can offer a download, but it cannot ask the OS *where* to put
//! a file, cannot write next to the user's other documents, and cannot report
//! a real path back so the message can link to it later. That is a native
//! job, so it lives here.

use base64::Engine;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Ask the user where to save `suggested_name`, then write the bytes there.
///
/// Returns the chosen absolute path, or `None` if the dialog was dismissed.
/// Bytes arrive base64-encoded because `invoke` moves JSON, not binary.
///
/// **Asynchronous, and it has to be.** The dialog's completion is delivered on the
/// main thread — `run_on_main_thread` is how the plugin presents it at all — so
/// blocking the calling thread until the callback fires deadlocks whenever the
/// calling thread *is* the main thread, which is what Tauri does for a
/// synchronous `#[tauri::command]`. The symptom was not an error: the panel never
/// appeared, the promise never settled, and the app froze.
///
/// Awaiting a `oneshot` instead parks this task on the async runtime, leaving the
/// main thread free to present the panel and free to deliver the answer. The
/// `recv()` error is also handled rather than discarded: `send_user_message` can
/// fail, and a dropped callback would otherwise leave this awaiting a value that
/// is never coming.
pub async fn save_attachment(
    app: &AppHandle,
    suggested_name: &str,
    bytes_base64: &str,
) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| format!("attachment payload was not valid base64: {e}"))?;

    let safe_name = sanitise_name(suggested_name);

    let (tx, rx) = tokio::sync::oneshot::channel();
    let app = app.clone();
    app.dialog()
        .file()
        .set_file_name(&safe_name)
        .save_file(move |path| {
            // A send failure means the caller went away — the window closed, or
            // the user navigated back — which is not an error worth reporting.
            let _ = tx.send(path);
        });

    let chosen = rx
        .await
        .map_err(|_| "the save dialog was closed before a location was chosen".to_string())?;

    let Some(path) = chosen else {
        return Ok(None);
    };

    let target = path
        .into_path()
        .map_err(|e| format!("could not resolve the chosen location: {e}"))?;

    // The write itself is blocking I/O on a file the size of an email attachment.
    // Cheap, but off the async runtime's threads it is not, so it is pushed onto
    // the blocking pool where a slow disk cannot stall another command.
    //
    // The two `?`s are the point of the expression — a failed write is reported,
    // not swallowed, and the path is only returned once the bytes are down. Binding
    // the result and then discarding it said the same thing and tripped clippy's
    // `let_unit_value`, which is the correct complaint.
    let target_for_task = target.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::write(&target_for_task, &bytes).map_err(|e| {
            format!("could not write {}: {e}", target_for_task.display())
        })
    })
    .await
    .map_err(|e| format!("the write task failed: {e}"))??;

    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Strip path separators and NULs from a sender-supplied file name.
///
/// A message body controls this string, so `../../.ssh/authorized_keys` must
/// not survive into the save panel: the OS dialog still starts in a directory the
/// user picked, and a separator in the *name* would silently redirect it.
///
/// `.` and `..` are rejected too, and the check runs on the *separated* name.
/// Separators alone are not enough: `../../etc/passwd` becomes `....etcpasswd`
/// once they are stripped, which contains no separator at all and so looks safe —
/// but a name consisting only of dots is not a filename, it is a request to mean
/// "the parent directory". Any name that is empty, blank, or nothing but dots has
/// no user-meaningful content, so it falls back to `attachment`.
///
/// A *leading* dot is left alone: `.env` and `.gitignore` are ordinary filenames,
/// and a sender-supplied `.bashrc` is inert because the dialog never writes
/// outside a directory the user chose.
fn sanitise_name(suggested_name: &str) -> String {
    let cleaned: String = suggested_name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .collect();

    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '.') {
        "attachment".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::sanitise_name;

    #[test]
    fn traversal_segments_lose_their_separators() {
        // Five dots, not four: `../` and `../` leave two each, and the segment
        // `.ssh` starts with a fifth. The point being asserted is that no
        // separator survives, not the dot count.
        assert_eq!(
            sanitise_name("../../.ssh/authorized_keys"),
            ".....sshauthorized_keys"
        );
        assert!(!sanitise_name("../../.ssh/authorized_keys").contains('/'));
    }

    #[test]
    fn a_backslash_is_just_as_dangerous() {
        assert_eq!(
            sanitise_name(r"..\..\windows\system32\evil.dll"),
            "....windowssystem32evil.dll"
        );
    }

    #[test]
    fn a_name_of_only_dots_is_not_a_filename() {
        // Stripping the separators out of `../..` leaves four dots, which contains
        // no separator and so passed the traversal check — while still being a
        // request to mean "the parent directory". There is nothing to salvage, so
        // it becomes the default.
        for input in [".", "..", "....", "../..", r"..\..", "./."] {
            assert_eq!(
                sanitise_name(input),
                "attachment",
                "dot-only name {input:?} was not rejected"
            );
        }
    }

    #[test]
    fn ordinary_names_are_left_alone() {
        assert_eq!(sanitise_name("Q3 report.pdf"), "Q3 report.pdf");
    }

    #[test]
    fn a_leading_dot_is_a_real_filename() {
        // `.env` is not traversal, and stripping the dot would silently rename the
        // user's file on save.
        assert_eq!(sanitise_name(".env"), ".env");
        assert_eq!(sanitise_name(".gitignore"), ".gitignore");
    }

    #[test]
    fn empty_and_blank_names_fall_back() {
        assert_eq!(sanitise_name(""), "attachment");
        assert_eq!(sanitise_name("   "), "attachment");
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        // A trailing newline in a `Content-Disposition` filename is common, and it
        // would otherwise become part of the suggested name.
        assert_eq!(sanitise_name("report.pdf\n"), "report.pdf");
    }
}
