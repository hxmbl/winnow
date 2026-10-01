//! Winnow desktop shell.
//!
//! The product lives in `web/` — every screen, every piece of classification
//! logic and the whole Gmail client are TypeScript, and the same bundle runs in
//! a browser. This crate exists only for the things a browser genuinely cannot
//! do:
//!
//! | Capability | Module |
//! | --- | --- |
//! | OS keychain for OAuth tokens | [`secrets`] |
//! | Loopback HTTP listener for the OAuth redirect | [`oauth`] |
//! | Native notifications, dock badge, tray | [`lib`] |
//! | Background sync ticks while the window is hidden | [`scheduler`] |
//! | Writing attachments to disk | [`files`] |
//! | Deep links, autostart, window state | plugins, [`deep_link`] |
//!
//! Nothing here re-implements product behaviour. If a command could be written
//! in TypeScript, it belongs in `web/`.

pub mod commands;
pub mod deep_link;
pub mod files;
pub mod oauth;
pub mod scheduler;
pub mod secrets;
pub mod tray;

use tauri::Manager;

/// Build and run the Winnow desktop application.
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch (or a `winnow://` click while already running)
            // should surface the existing window rather than open a rival one.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build());

    builder
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::secrets_set,
            commands::secrets_get,
            commands::secrets_delete,
            commands::oauth_begin,
            commands::oauth_await,
            commands::oauth_cancel,
            commands::notify_new_mail,
            commands::open_external,
            commands::save_attachment,
            commands::set_unread_badge,
            commands::set_background_sync,
            commands::request_notification_permission,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--minimized"]),
            ))?;

            app.manage(oauth::Sessions::default());
            deep_link::register(app.handle())?;
            tray::build(app.handle())?;
            scheduler::install(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides to the tray rather than quitting: an
            // inbox client that syncs in the background should keep syncing.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(desktop)]
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                #[cfg(not(desktop))]
                let _ = api;
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start the Winnow desktop application");
}
