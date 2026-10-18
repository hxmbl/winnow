//! The tray icon.
//!
//! Closing the window hides the app (see `lib.rs`), so the tray is the only
//! way back in on a system with a dock-less menubar. It also carries the one
//! action worth a click: sync now. There is deliberately no "Mark all read":
//! Winnow marks a message read when it is opened, and mass-marking lets mail
//! look read that never was.

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
                reveal(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
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
