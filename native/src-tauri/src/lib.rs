//! Winnow native shell: desktop (macOS, Windows, Linux) and Android.
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
//! | The native half of Dev Options → Debug log | [`debug_log`] |
//! | Native notifications, dock badge, tray | [`lib`] |
//! | Notification actions: Reply, Delete, Mark read | [`notify_actions`] |
//! | Background sync ticks while the window is hidden | [`scheduler`] |
//! | Background sync with the app closed (Android foreground service) | [`background_service`] |
//! | Writing attachments to disk | [`files`] |
//! | Deep links, autostart, window state | plugins, [`deep_link`] |
//! | Native Google sign-in and the sign-in Custom Tab (Android) | [`google_signin`] |
//! | Installing a newer release (updater, `.deb`, APK) | [`updater`] |
//!
//! On Android the tray, autostart, single-instance and window-state pieces are
//! compiled out (`#[cfg(desktop)]`); there is no tray and the OS owns the window.
//! Secrets go to the Android Keystore instead of `keyring` (see [`secrets`]).
//!
//! Nothing here re-implements product behaviour. If a command could be written
//! in TypeScript, it belongs in `web/`.

pub mod background_service;
pub mod commands;
pub mod debug_log;
pub mod deep_link;
pub mod files;
pub mod google_signin;
pub mod notify_actions;
pub mod oauth;
pub mod scheduler;
pub mod secrets;
#[cfg(desktop)]
pub mod tray;
pub mod updater;

#[cfg(desktop)]
use tauri::Emitter;
use tauri::Manager;

/// Build and run the Winnow application.
///
/// On Android this is the library's entry point, called by the generated
/// `MainActivity` through Tauri's mobile glue.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `single_instance` has to be registered *first*, before any other plugin.
    // Tauri requires it: it must be able to detect and forward a second launch
    // before any other plugin has a chance to initialise against a second app, so
    // putting it later means a `winnow://` click can briefly create a rival
    // process that fights over the same keychain item and the same tray id.
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // A second launch — or a `winnow://` click while already running — should
        // surface the existing window rather than open a rival one.
        tray::reveal(app);

        // …and it should carry the link that caused it. The callback receives the
        // second process's argv, and the deep link is in there; it used to be
        // discarded into `_argv`, so clicking a message link in a browser while
        // Winnow was already running did the only visible thing (show the window)
        // and then stopped. The webview's listener picks this up from the same
        // event the cold-launch path uses, so both routes end in one place.
        for arg in argv.iter().skip(1) {
            if arg.starts_with(deep_link::SCHEME) {
                let _ = app.emit(deep_link::OPEN_URL_EVENT, arg.as_str());
            }
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // Actionable new-mail notifications. Registered on every host: on Android it
        // is the Kotlin half, on Linux and Windows the table of shown notifications.
        .plugin(notify_actions::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    // Self-update for the macOS app and the AppImage (`updater.rs`). Only Rust calls
    // it, through `update_install`; no capability grants its JS API.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // Android only: hands a downloaded release APK to the package installer.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(updater::init());

    // Android only: `files.rs` needs it to write to the save picker's content URI.
    // No capability grants its JS API, so the webview cannot reach it directly.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_fs::init());

    // Android only: native Google sign-in and the sign-in Custom Tab, in Kotlin. The
    // webview reaches it through the `google_signin_*` / `open_sign_in_tab` commands.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(google_signin::init());

    // Android only: background sync, a foreground service in Kotlin that checks Gmail
    // with the app closed. Reached through the `background_service_*` commands.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(background_service::init());

    builder
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::secrets_set,
            commands::secrets_get,
            commands::secrets_delete,
            commands::oauth_begin,
            commands::oauth_await,
            commands::oauth_cancel,
            commands::debug_log_set_enabled,
            commands::debug_log_drain,
            commands::open_external,
            commands::google_signin_info,
            commands::google_signin_authorize,
            commands::open_sign_in_tab,
            commands::save_attachment,
            commands::open_attachment,
            commands::set_unread_badge,
            commands::set_background_sync,
            commands::background_service_configure,
            commands::background_service_status,
            commands::background_service_battery,
            commands::background_service_notification_settings,
            commands::background_service_listener_settings,
            commands::request_notification_permission,
            commands::update_runtime,
            commands::update_install,
            commands::update_download_deb,
            commands::update_install_apk,
            notify_actions::notify_messages,
            notify_actions::notify_action_result,
            notify_actions::notify_kept_replies,
            notify_actions::notify_release_kept,
            notify_actions::notify_withdraw,
            notify_actions::notify_clear_account,
            notify_actions::notify_active,
            deep_link::deep_link_launch,
        ])
        .on_page_load(|window, payload| {
            // The window is configured `visible: false` so the user never sees a
            // blank white rectangle while the webview boots, but nothing else
            // showed it — so a normal launch produced no window at all, only a
            // tray icon. Revealing it here, once the page has actually finished
            // loading, is the only point at which there is something to look at.
            //
            // Skipped when launched with `--minimized`, which is how the autostart
            // entry point starts it: a login item that opens a window over
            // whatever the user is doing is exactly the behaviour people disable.
            #[cfg(desktop)]
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && !std::env::args().any(|arg| arg == "--minimized")
            {
                tray::reveal(window.app_handle());
            }
            // On Android the activity owns the one window and shows it itself.
            #[cfg(not(desktop))]
            let _ = (window, payload);
        })
        .setup(|app| {
            // Autostart is *registered* here and *enabled* by the user from the
            // settings panel. The plugin's `init` only stores configuration; it does
            // not create a login item. Registering it and then never enabling it
            // used to leave three `autostart:allow-*` permissions granted for calls
            // that could never happen, and a `--minimized` code path that nothing
            // could ever reach.
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--minimized"]),
            ))?;

            app.manage(oauth::Sessions::default());

            // Native debug-log lines wait in `debug_log` until the webview drains them;
            // this nudges it when the first one of a batch arrives.
            let handle = app.handle().clone();
            debug_log::set_notifier(move || {
                let _ = tauri::Emitter::emit(&handle, debug_log::DEBUG_LOG_EVENT, ());
            });
            deep_link::register(app.handle())?;
            #[cfg(desktop)]
            tray::build(app.handle())?;
            scheduler::install(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                crate::dlog!("app", "window-focus", focused = focused);
                // The tray click reads this to tell "hide" from "show".
                #[cfg(desktop)]
                tray::note_focus(*focused);
            }
            // Closing the window hides to the tray rather than quitting: an
            // inbox client that syncs in the background should keep syncing.
            // Android has no close button to intercept, so nothing to do there.
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(desktop))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("failed to start the Winnow application")
        .run(|app, event| {
            // Clicking a macOS notification activates the app without any payload,
            // and `tauri-plugin-notification` offers no desktop click callback to
            // recover the ids from — so the useful response is the same one as a
            // dock click: bring the window back.
            //
            // `Reopen` is macOS's "the app was already running and got activated"
            // event. It fires for a dock click, a notification click, and a
            // `Reopen` Apple Event, and it does not fire for a cold launch, which is
            // handled by `on_page_load` instead. Revealing on it means the two do not
            // fight: the page-load path reveals a window that is about to be shown,
            // and this one reveals one that already exists.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                tray::reveal(app);
            }

            match &event {
                tauri::RunEvent::Ready => crate::dlog!("app", "ready"),
                tauri::RunEvent::ExitRequested { .. } => crate::dlog!("app", "exit-requested"),
                _ => {}
            }

            let _ = (app, &event);
        });
}
