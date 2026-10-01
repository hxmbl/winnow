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
pub fn save_attachment(
    app: &AppHandle,
    suggested_name: &str,
    bytes_base64: &str,
) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| format!("attachment payload was not valid base64: {e}"))?;

    let safe_name = sanitise_name(suggested_name);

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(&safe_name)
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let chosen = rx
        .recv()
        .map_err(|e| format!("the save dialog failed: {e}"))?;

    let Some(path) = chosen else {
        return Ok(None);
    };

    let target = path
        .into_path()
        .map_err(|e| format!("could not resolve the chosen location: {e}"))?;

    std::fs::write(&target, &bytes)
        .map_err(|e| format!("could not write {}: {e}", target.display()))?;

    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Strip path separators and NULs from a sender-supplied file name.
///
/// A message body controls this string, so `../../.ssh/authorized_keys` must
/// not survive into the save panel: the OS dialog still starts in a directory
/// the user picked, and a separator in the *name* would silently redirect it.
fn sanitise_name(suggested_name: &str) -> String {
    let cleaned: String = suggested_name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .collect();
    if cleaned.trim().is_empty() {
        "attachment".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::sanitise_name;

    #[test]
    fn traversal_segments_lose_their_separators() {
        assert_eq!(
            sanitise_name("../../.ssh/authorized_keys"),
            "....sshauthorized_keys"
        );
    }

    #[test]
    fn a_backslash_is_just_as_dangerous() {
        assert_eq!(sanitise_name(r"..\..\windows\system32\evil.dll"), "....windowssystem32evil.dll");
    }

    #[test]
    fn ordinary_names_are_left_alone() {
        assert_eq!(sanitise_name("Q3 report.pdf"), "Q3 report.pdf");
    }

    #[test]
    fn empty_and_blank_names_fall_back() {
        assert_eq!(sanitise_name(""), "attachment");
        assert_eq!(sanitise_name("   "), "attachment");
    }
}
