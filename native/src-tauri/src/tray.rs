//! The tray icon.
//!
//! Closing the window hides the app (see `lib.rs`), so the tray is the only
//! way back in on a system with a dock-less menubar. A left click on it shows
//! and hides the window, like a menu bar app. It also carries the one action
//! worth a click: sync now. There is deliberately no "Mark all read":
//! Winnow marks a message read when it is opened, and mass-marking lets mail
//! look read that never was.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Emitted when the user picks an item from the tray.
pub const TRAY_ACTION_EVENT: &str = "winnow://tray-action";

/// The tray's icon id. Shared with [`crate::commands`] so the badge tooltip can
/// find the tray the menu was attached to.
pub const TRAY_ID: &str = "winnow-tray";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

    let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Winnow", true, None::<&str>)?;

    // No "Open Winnow" row. Revealing the window is what a *left click* on the
    // tray icon does, on every desktop OS, which is the convention — so the item
    // was a second way to do the thing the click already does, and it emitted no
    // event, which made it the one row the webview could not see. Kept as a click
    // rather than a menu entry.
    let menu = Menu::with_items(
        app,
        &[
            &sync,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Winnow")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            // `TRAY_ID` is the one string the command layer and this module both
            // need, and it is a constant rather than a literal in each place so a
            // rename cannot desync them.
            "sync" => {
                let _ = app.emit(TRAY_ACTION_EVENT, "sync");
            }
            "settings" => {
                let _ = app.emit(TRAY_ACTION_EVENT, "settings");
                reveal(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles visibility, which is the platform convention
            // for a window that hides rather than quits.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// How long after the window loses focus a tray click still counts as a click
/// on a focused window. On some desktops pressing the tray icon takes focus from
/// the window before the click arrives, so without this grace the window would
/// read as unfocused and the click would only ever reveal it.
const CLICK_BLUR_GRACE: Duration = Duration::from_millis(400);

/// When the main window last lost focus. Written by `note_focus`.
static LAST_BLUR: Mutex<Option<Instant>> = Mutex::new(None);

/// Record the main window gaining or losing focus (called from `lib.rs`).
pub fn note_focus(focused: bool) {
    if let Ok(mut last) = LAST_BLUR.lock() {
        *last = if focused { None } else { Some(Instant::now()) };
    }
}

/// Whether a tray click should hide the window rather than bring it forward.
///
/// Only a window you are looking at is hidden: shown, not minimised, and
/// focused (or focused until the click itself took focus away). A window that
/// is hidden, minimised or behind another app's window is brought forward
/// instead, because hiding something you can't see would look like the click
/// did nothing.
fn click_hides(
    visible: bool,
    minimized: bool,
    focused: bool,
    blurred_ago: Option<Duration>,
) -> bool {
    let just_blurred = blurred_ago.is_some_and(|ago| ago <= CLICK_BLUR_GRACE);
    visible && !minimized && (focused || just_blurred)
}

/// Show the window if it is out of sight, hide it if it is in front of you.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let blurred_ago = LAST_BLUR
        .lock()
        .ok()
        .and_then(|last| last.map(|at| at.elapsed()));
    let hide = click_hides(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
        window.is_focused().unwrap_or(false),
        blurred_ago,
    );
    if hide {
        let _ = window.hide();
    } else {
        reveal(app);
    }
}

/// Bring the main window back, restoring it from a minimised state if needed.
///
/// Each call is attempted independently. They are three separate steps — a window
/// that is *minimised* needs unminimising before showing does anything, and a
/// window that is *hidden* needs showing before focusing does anything — so a
/// failure in one should not cost the other two. `setFocus` in particular is a
/// request the window manager may decline for reasons that have nothing to do with
/// the other two, and it is the least important of them.
///
/// Nothing here is load-bearing enough to return an error for: this is called from
/// a tray click, a deep link and a second launch, and failing any of those loudly
/// would mean a notification or a link breaking over a window that is already
/// visible.
pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: Option<Duration> = None;

    #[test]
    fn a_window_in_front_of_you_is_hidden() {
        assert!(click_hides(true, false, true, NOW));
    }

    #[test]
    fn a_hidden_or_minimised_window_is_brought_back() {
        assert!(!click_hides(false, false, false, NOW));
        assert!(!click_hides(false, false, true, NOW));
        assert!(!click_hides(true, true, false, NOW));
        assert!(!click_hides(true, true, true, NOW));
    }

    #[test]
    fn a_window_behind_another_app_is_brought_forward() {
        assert!(!click_hides(true, false, false, NOW));
        assert!(!click_hides(
            true,
            false,
            false,
            Some(Duration::from_secs(5))
        ));
    }

    #[test]
    fn focus_taken_by_the_click_itself_still_counts_as_focused() {
        assert!(click_hides(
            true,
            false,
            false,
            Some(Duration::from_millis(50))
        ));
        assert!(click_hides(true, false, false, Some(CLICK_BLUR_GRACE)));
        assert!(!click_hides(
            true,
            false,
            false,
            Some(CLICK_BLUR_GRACE + Duration::from_millis(1))
        ));
    }
}
