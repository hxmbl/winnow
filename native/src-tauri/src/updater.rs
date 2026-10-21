//! Self-update: how this copy of Winnow is running, and the native half of installing
//! a newer release.
//!
//! Finding a newer release is the web layer's job (`web/src/core/updates/updates.ts`
//! asks GitHub's `releases/latest`, the same on every host). What differs per host is
//! how the new version gets installed, so that is what lives here:
//!
//! | Channel | Install |
//! | --- | --- |
//! | `macos` | `tauri-plugin-updater`: the signed `.app.tar.gz` from `latest.json`, swapped in, relaunch |
//! | `appimage` | `tauri-plugin-updater`: the signed AppImage replaces `$APPIMAGE`, relaunch |
//! | `deb` | download the release `.deb` to Downloads and open it with the system installer |
//! | `android` | the Kotlin plugin downloads the APK and opens Android's package installer |
//! | `manual` | nothing here; the web layer opens the release page |
//!
//! The updater verifies every download against the public key in `tauri.conf.json`
//! (`plugins.updater.pubkey`) before it touches the app; the matching private key signs
//! the release in CI (`.github/workflows/release.yml`, `TAURI_SIGNING_PRIVATE_KEY`).
//!
//! A `.deb` install is never replaced in place: the package manager owns `/usr/bin`,
//! and swapping files under it would leave dpkg's records wrong. It gets the package.

use serde::Serialize;

#[cfg(any(target_os = "linux", test))]
use std::path::Path;

/// Where every release file lives (`RELEASE_DOWNLOAD_PREFIX` in `updates.ts`).
pub const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/hxmbl/winnow/releases/download/";

/// No release `.deb` is anywhere near this; a larger answer is not ours.
#[cfg(any(target_os = "linux", test))]
const MAX_DOWNLOAD_BYTES: u64 = 400 * 1024 * 1024;

/// How this copy is running, for the web layer (`parseChannel`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRuntime {
    pub channel: &'static str,
    pub version: String,
    pub arch: String,
}

/// Linux: an AppImage (the runtime sets `$APPIMAGE` to the image's path), a package
/// install (the binary under `/usr`, where the `.deb` puts it), or neither (a `cargo`
/// build, or a binary copied somewhere by hand).
#[cfg(any(target_os = "linux", test))]
pub fn linux_channel(appimage: Option<&std::ffi::OsStr>, exe: Option<&Path>) -> &'static str {
    if appimage.is_some_and(|path| !path.is_empty()) {
        return "appimage";
    }
    match exe {
        Some(path) if path.starts_with("/usr/") => "deb",
        _ => "manual",
    }
}

/// This process's channel.
pub fn channel() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "android")]
    {
        "android"
    }
    #[cfg(target_os = "linux")]
    {
        let appimage = std::env::var_os("APPIMAGE");
        let exe = std::env::current_exe().ok();
        linux_channel(appimage.as_deref(), exe.as_deref())
    }
    #[cfg(not(any(target_os = "macos", target_os = "android", target_os = "linux")))]
    {
        "manual"
    }
}

/// Whether Tauri's updater may replace this copy.
pub fn self_updates(channel: &str) -> bool {
    matches!(channel, "macos" | "appimage")
}

/// Check a release download: https, this repository's releases, a plain file name with
/// the expected extension that is the URL's last segment, no `..` anywhere.
pub fn release_download(url: &str, name: &str, extension: &str) -> Result<url::Url, String> {
    if !url.starts_with(RELEASE_DOWNLOAD_PREFIX) || url.contains("..") {
        return Err("not a Winnow release download".into());
    }
    let plain = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !plain || !name.ends_with(extension) || name.starts_with('.') {
        return Err("unexpected file name".into());
    }
    let parsed = url::Url::parse(url).map_err(|_| "not a valid URL".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err("not a Winnow release download".into());
    }
    if parsed.path_segments().and_then(|mut s| s.next_back()) != Some(name) {
        return Err("the file name does not match the URL".into());
    }
    Ok(parsed)
}

/// What `update_install` did: `restarting` never reaches the webview (the app has
/// relaunched), `none` means the updater's manifest has nothing newer for this
/// platform (a release published without updater artifacts), and the web layer opens
/// the release page instead.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum InstallOutcome {
    Restarting,
    None,
    Opened { path: String },
}

// ── Android ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{Manager, Wry};

    pub const PLUGIN_NAME: &str = "winnow-update";
    const KOTLIN_PACKAGE: &str = "app.winnow.android.update";
    const KOTLIN_CLASS: &str = "UpdatePlugin";

    pub struct Native(pub PluginHandle<Wry>);

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new(PLUGIN_NAME)
            .setup(|app, api| {
                let handle = api.register_android_plugin(KOTLIN_PACKAGE, KOTLIN_CLASS)?;
                app.manage(Native(handle));
                Ok(())
            })
            .build()
    }
}

#[cfg(target_os = "android")]
pub use android::init;

/// Download a release APK and open the package installer (Android).
#[cfg(target_os = "android")]
pub async fn install_apk(
    app: &tauri::AppHandle,
    url: &str,
    name: &str,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    release_download(url, name, ".apk")?;
    let native = app
        .try_state::<android::Native>()
        .ok_or_else(|| "the update plugin is not registered".to_string())?;
    native
        .0
        .run_mobile_plugin_async::<serde_json::Value>(
            "installApk",
            serde_json::json!({ "url": url, "name": name }),
        )
        .await
        .map_err(|e| e.to_string())
}

// ── Desktop: Tauri's updater ────────────────────────────────────────────────

/// Install the newest release through `latest.json`, then relaunch. Only for the
/// channels Tauri's updater can replace (`self_updates`).
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub async fn install_self(app: &tauri::AppHandle) -> Result<InstallOutcome, String> {
    use tauri_plugin_updater::UpdaterExt;
    if !self_updates(channel()) {
        return Err("this copy of Winnow is not one the updater can replace".into());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(InstallOutcome::None);
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

// ── Linux: the .deb ─────────────────────────────────────────────────────────

/// Where a downloaded `.deb` goes: the user's Downloads folder, or the temp dir.
#[cfg(target_os = "linux")]
fn download_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    app.path()
        .download_dir()
        .ok()
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(std::env::temp_dir)
}

/// Download a release `.deb` and open it with the system's package installer
/// (`xdg-open`, through the opener plugin). Returns the saved path, so the web layer
/// can show `sudo apt install <path>` when no installer opens it.
#[cfg(target_os = "linux")]
pub async fn download_deb(
    app: &tauri::AppHandle,
    url: &str,
    name: &str,
) -> Result<InstallOutcome, String> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = release_download(url, name, ".deb")?;
    let dir = download_dir(app);
    let target = dir.join(name);
    let partial = dir.join(format!("{name}.part"));

    // The same provider the updater installs before its own requests.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .https_only(true)
        .build()
        .map_err(|e| e.to_string())?
        .get(parsed)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("the download failed: {e}"))?;
    if response.content_length().unwrap_or(0) > MAX_DOWNLOAD_BYTES {
        return Err("the file is too large".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("the download failed: {e}"))?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err("the file is too large".into());
    }
    std::fs::write(&partial, &bytes).map_err(|e| format!("could not save the download: {e}"))?;
    std::fs::rename(&partial, &target).map_err(|e| format!("could not save the download: {e}"))?;

    let path = target.to_string_lossy().into_owned();
    // Opening is best-effort: the file is saved either way, and the web layer shows the
    // apt command for it.
    let _ = app.opener().open_path(path.clone(), None::<&str>);
    Ok(InstallOutcome::Opened { path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn linux_channel_tells_appimage_deb_and_manual_apart() {
        assert_eq!(
            linux_channel(
                Some(OsStr::new("/home/a/Winnow.AppImage")),
                Some(Path::new("/tmp/.mount_x/usr/bin/winnow"))
            ),
            "appimage"
        );
        assert_eq!(
            linux_channel(None, Some(Path::new("/usr/bin/winnow"))),
            "deb"
        );
        assert_eq!(
            linux_channel(Some(OsStr::new("")), Some(Path::new("/usr/bin/winnow"))),
            "deb"
        );
        assert_eq!(
            linux_channel(
                None,
                Some(Path::new("/home/a/winnow/target/release/winnow"))
            ),
            "manual"
        );
        assert_eq!(linux_channel(None, None), "manual");
    }

    #[test]
    fn only_macos_and_appimage_self_update() {
        assert!(self_updates("macos"));
        assert!(self_updates("appimage"));
        for other in ["deb", "android", "manual", "web"] {
            assert!(!self_updates(other), "{other}");
        }
    }

    #[test]
    fn release_downloads_are_checked() {
        let base = "https://github.com/hxmbl/winnow/releases/download/v1.5.0/";
        let deb = "Winnow_1.5.0_amd64.deb";
        assert!(release_download(&format!("{base}{deb}"), deb, ".deb").is_ok());
        for (url, name) in [
            (
                format!("http://github.com/hxmbl/winnow/releases/download/v1.5.0/{deb}"),
                deb,
            ),
            (format!("https://evil.example/{deb}"), deb),
            (
                format!("https://github.com/other/repo/releases/download/v1/{deb}"),
                deb,
            ),
            (format!("{base}../../{deb}"), deb),
            (format!("{base}{deb}"), "other.deb"),
            (format!("{base}{deb}"), "../x.deb"),
            (format!("{base}Winnow.apk"), "Winnow.apk"),
            (format!("{base}.deb"), ".deb"),
        ] {
            assert!(
                release_download(&url, name, ".deb").is_err(),
                "{url} {name}"
            );
        }
        assert!(release_download(
            &format!("{base}Winnow_1.5.0_android-universal.apk"),
            "Winnow_1.5.0_android-universal.apk",
            ".apk"
        )
        .is_ok());
        assert!(MAX_DOWNLOAD_BYTES > 100 * 1024 * 1024);
    }

    #[test]
    fn runtime_and_outcome_serialise_as_the_web_layer_reads() {
        let runtime = serde_json::to_value(UpdateRuntime {
            channel: "appimage",
            version: "1.4.0".into(),
            arch: "x86_64".into(),
        })
        .unwrap();
        assert_eq!(
            runtime,
            serde_json::json!({ "channel": "appimage", "version": "1.4.0", "arch": "x86_64" })
        );
        assert_eq!(
            serde_json::to_value(InstallOutcome::None).unwrap(),
            serde_json::json!({ "kind": "none" })
        );
        assert_eq!(
            serde_json::to_value(InstallOutcome::Opened {
                path: "/tmp/a.deb".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "opened", "path": "/tmp/a.deb" })
        );
    }
}
