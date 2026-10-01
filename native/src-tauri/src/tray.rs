//! The tray icon.
//!
//! Closing the window hides the app (see `lib.rs`), so the tray is the only
//! way back in on a system with a dock-less menubar. It also carries the two
//! actions worth one click: sync now, and read/unread toggle.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Emitted when the user picks an item from the tray.
pub const TRAY_ACTION_EVENT: &str = "winnow://tray-action";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| Image::new_owned(Vec::new(), 32, 32));

    let open = MenuItem::with_id(app, "open", "Open Winnow", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
    let unread = MenuItem::with_id(app, "unread", "Mark all read", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Winnow", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &sync,
            &unread,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("winnow-tray")
        .icon(icon)
        .tooltip("Winnow")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => reveal(app),
            "sync" => {
                let _ = app.emit(TRAY_ACTION_EVENT, "sync");
            }
            "unread" => {
                let _ = app.emit(TRAY_ACTION_EVENT, "mark_all_read");
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
pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
