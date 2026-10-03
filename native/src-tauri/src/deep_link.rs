//! `winnow://` deep links.
//!
//! A message can carry a link back into the app — "open this thread in Winnow"
//! in a browser, or a notification click. The OS delivers those as a URL
//! scheme; the web layer decides what to do with it.
//!
//! Registration is explicit rather than config-driven because the schemes are
//! fixed: `winnow` plus the OAuth callback the web layer builds. Both are
//! registered at startup, so a link works whether the app was running or the
//! OS cold-launched it for the click.

use tauri::{AppHandle, Emitter};
use tauri_plugin_deep_link::DeepLinkExt;

/// Emitted to the webview with the raw URL as its payload.
pub const DEEP_LINK_EVENT: &str = "winnow://open-url";

/// The event [`crate::lib`] emits for a link that arrived on a second launch.
///
/// An alias rather than a second name: the webview subscribes to
/// `DEEP_LINK_EVENT` and must not have to know whether the link woke the app or
/// joined one that was already running. Both routes emit the same event, so
/// `desktop.ts` has one subscription and one handler.
pub const OPEN_URL_EVENT: &str = DEEP_LINK_EVENT;

/// The scheme a [`winnow://`](winnow) link is written with.
pub const SCHEME: &str = "winnow";

/// Schemes the app answers to.
///
/// Only `winnow` now. There was once a second scheme for the OAuth callback,
/// from when sign-in went through a custom URL scheme; it does any more, because
/// a redirect URI on a private-use scheme is not something Google will hand an
/// authorization code to for a desktop client — the loopback listener in
/// [`crate::oauth`] is what actually receives the redirect. Leaving the scheme
/// registered would mean claiming a name the app no longer answers for, and a
/// stale registration is a real security surface: another program could claim it
/// if we ever let it go.
pub const SCHEMES: [&str; 1] = [SCHEME];

/// Install the handler and register the schemes with the OS.
///
/// Safe to call more than once — `build()` runs again on every rebuild during
/// development and the registration API tolerates repeats.
pub fn register(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.plugin(tauri_plugin_deep_link::init())?;

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let _ = handle.emit(OPEN_URL_EVENT, url.to_string());
        }
    });

    for scheme in SCHEMES {
        // A registration failure is not fatal: the app still works, it just will
        // not be reachable from a link in another program.
        //
        // It is reported on stderr rather than through `log::warn!`, because no
        // logger is installed — the `log` crate's macros compile down to a no-op
        // when no backend is set, so this "surfaced as a log line" was in fact
        // surfaced nowhere at all. `eprintln!` reaches a terminal or a log file
        // regardless of what the app does about logging.
        if let Err(e) = app.deep_link().register(scheme) {
            eprintln!("winnow: could not register the {scheme}:// scheme: {e}");
        }
    }

    // If the OS cold-launched us for this link, the URL is waiting here.
    //
    // Emitted from `setup`, which runs *before* the webview has finished loading —
    // so this event very often arrives at a listener that does not exist yet. The
    // webview re-reads the launch arguments on mount for exactly this reason
    // (`main.tsx`), which is why the code here stays a best-effort emit rather
    // than becoming the only path by which a link can arrive.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            let _ = app.emit(OPEN_URL_EVENT, url.to_string());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_scheme_is_winnow_owned() {
        for scheme in SCHEMES {
            assert!(
                scheme.starts_with("winnow"),
                "{scheme} would let another app claim our links"
            );
        }
        assert!(SCHEMES.contains(&"winnow"));
    }

    #[test]
    fn the_oauth_callback_is_not_a_scheme() {
        // A guard against reintroducing the old `winnow-oauth` scheme. The
        // callback arrives on `http://127.0.0.1:<port>`, which `oauth.rs` owns;
        // registering a scheme for it would be dead registration that looks like
        // it works.
        assert!(!SCHEMES.contains(&"winnow-oauth"));
    }

    #[test]
    fn the_event_name_is_namespaced() {
        assert_eq!(DEEP_LINK_EVENT, "winnow://open-url");
    }

    #[test]
    fn the_second_launch_route_emits_the_same_event() {
        // If these were two names, the webview would need two subscriptions and
        // could silently handle a cold launch while missing a link that arrived on
        // an already-running app — which is the case a user hits every time they
        // click a message link twice.
        assert_eq!(OPEN_URL_EVENT, DEEP_LINK_EVENT);
    }
}
