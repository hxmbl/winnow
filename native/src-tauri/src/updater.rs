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
//! The two downloads the updater's signature doesn't cover, the `.deb` and the APK, are
//! checked against the release's `SHA256SUMS` before anything opens them; a release
//! without one, or a file that doesn't match, is refused and deleted. The APK's check is
//! in the Kotlin plugin (`UpdateLogic.expectedSha256`), the `.deb`'s here.
//!
//! **Pre-releases.** Any release whose tag has a `-` (`v1.6.0-beta.1`) is a pre-release.
//! Every install here refuses one unless the web layer says the offer came from the Beta
//! channel (Dev Options → Beta updates): `release_download` checks the tag segment of the
//! URL, and the stable self-update refuses a manifest whose version or download carries a
//! pre-release. GitHub's own flags already keep a pre-release out of `releases/latest`;
//! this is the backstop if one is ever marked latest by mistake. A Beta self-update reads
//! the offered release's own `latest.json` (`manifest_url`), never `releases/latest`.
//!
//! A `.deb` install is never replaced in place: the package manager owns `/usr/bin`,
//! and swapping files under it would leave dpkg's records wrong. It gets the package.

use serde::Serialize;

#[cfg(any(target_os = "linux", test))]
use std::path::Path;

/// Where every release file lives (`RELEASE_DOWNLOAD_PREFIX` in `updates.ts`).
pub const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/hxmbl/winnow/releases/download/";

/// No release `.deb` is anywhere near this; a larger answer is not ours.
#[cfg(target_os = "linux")]
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

/// The Beta channel's updater manifest: the offered release's own `latest.json`.
pub fn manifest_url(url: &str) -> Result<url::Url, String> {
    release_download(url, "latest.json", ".json", true)
}

/// Whether the stable channel may install what an updater manifest offers: a version and
/// a download tag with no pre-release in either. The Beta channel takes either.
pub fn self_update_allowed(version: &str, download_url: &str, beta: bool) -> bool {
    beta || (!is_prerelease(version)
        && release_tag(download_url).is_some_and(|tag| !is_prerelease(tag)))
}

/// Whether Tauri's updater may replace this copy.
pub fn self_updates(channel: &str) -> bool {
    matches!(channel, "macos" | "appimage")
}

/// The tag a release download belongs to: the path segment after `/releases/download/`.
pub fn release_tag(url: &str) -> Option<&str> {
    let tag = url
        .strip_prefix(RELEASE_DOWNLOAD_PREFIX)?
        .split('/')
        .next()?;
    (!tag.is_empty()).then_some(tag)
}

/// A pre-release tag or version: anything with a `-` in it.
pub fn is_prerelease(tag_or_version: &str) -> bool {
    tag_or_version.contains('-')
}

/// What `release_download` says to a pre-release's file without Beta updates.
const PRERELEASE_REFUSED: &str =
    "that release is a pre-release; it is offered only with Beta updates on (Dev Options)";

/// Check a release download: https, this repository's releases, a plain file name with
/// the expected extension that is the URL's last segment, no `..` anywhere, and, unless
/// `allow_prerelease` (an offer from the Beta channel), a tag with no `-`.
pub fn release_download(
    url: &str,
    name: &str,
    extension: &str,
    allow_prerelease: bool,
) -> Result<url::Url, String> {
    if !url.starts_with(RELEASE_DOWNLOAD_PREFIX) || url.contains("..") {
        return Err("not a Winnow release download".into());
    }
    let Some(tag) = release_tag(url) else {
        return Err("not a Winnow release download".into());
    };
    if is_prerelease(tag) && !allow_prerelease {
        return Err(PRERELEASE_REFUSED.into());
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

/// The checksum list every release carries (`.github/workflows/release.yml`).
#[cfg(any(target_os = "linux", test))]
const SUMS_NAME: &str = "SHA256SUMS";

/// The release's `SHA256SUMS`, beside the file at `url` (already `release_download`ed).
#[cfg(any(target_os = "linux", test))]
fn sums_url(url: &url::Url) -> url::Url {
    let mut sums = url.clone();
    if let Ok(mut segments) = sums.path_segments_mut() {
        segments.pop().push(SUMS_NAME);
    }
    sums
}

/// The SHA-256 `sums` (in `sha256sum`'s format) gives for `name`, lower-case; None when
/// it lists no such file, or lists it twice, which no honest list does.
#[cfg(any(target_os = "linux", test))]
fn expected_sha256(sums: &str, name: &str) -> Option<String> {
    let mut found = sums.lines().filter_map(|line| {
        let line = line.trim_end_matches('\r');
        let (hash, rest) = (line.get(..64)?, line.get(64..)?);
        let file = rest
            .strip_prefix("  ")
            .or_else(|| rest.strip_prefix(" *"))?;
        (file == name && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    });
    let first = found.next()?;
    found.next().is_none().then_some(first)
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
    beta: bool,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    release_download(url, name, ".apk", beta)?;
    let native = app
        .try_state::<android::Native>()
        .ok_or_else(|| "the update plugin is not registered".to_string())?;
    native
        .0
        .run_mobile_plugin_async::<serde_json::Value>(
            "installApk",
            serde_json::json!({ "url": url, "name": name, "beta": beta }),
        )
        .await
        .map_err(|e| e.to_string())
}

// ── Desktop: Tauri's updater ────────────────────────────────────────────────

/// Install the newest release through `latest.json`, then relaunch. Only for the
/// channels Tauri's updater can replace (`self_updates`).
///
/// `manifest`: the Beta channel's `latest.json`, from the release it offered. Without
/// one, the configured `releases/latest/download/latest.json`, and nothing whose version
/// or download is a pre-release is installed from it.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub async fn install_self(
    app: &tauri::AppHandle,
    manifest: Option<String>,
) -> Result<InstallOutcome, String> {
    use tauri_plugin_updater::UpdaterExt;
    if !self_updates(channel()) {
        return Err("this copy of Winnow is not one the updater can replace".into());
    }
    let beta = manifest.is_some();
    let builder = match manifest {
        Some(url) => app
            .updater_builder()
            .endpoints(vec![manifest_url(&url)?])
            .map_err(|e| e.to_string())?,
        // Stable: a newer version with no pre-release part, never anything else.
        None => app.updater_builder().version_comparator(|current, remote| {
            remote.version > current && remote.version.pre.is_empty()
        }),
    };
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(InstallOutcome::None);
    };
    if !self_update_allowed(&update.version, update.download_url.as_str(), beta) {
        return Err(PRERELEASE_REFUSED.into());
    }
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
    beta: bool,
) -> Result<InstallOutcome, String> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = release_download(url, name, ".deb", beta)?;
    let dir = download_dir(app);
    let target = dir.join(name);
    let partial = dir.join(format!("{name}.part"));

    // The same provider the updater installs before its own requests.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .https_only(true)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(parsed.clone())
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
    // Checked before it is saved under its real name or opened: the release's own list.
    let sums = client
        .get(sums_url(&parsed))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("couldn't check the download: this release has no checksums ({e})"))?
        .text()
        .await
        .map_err(|e| format!("couldn't check the download: {e}"))?;
    let expected = expected_sha256(&sums, name).ok_or_else(|| {
        format!("couldn't check the download: the release lists no checksum for {name}")
    })?;
    let actual: String = {
        use sha2::{Digest, Sha256};
        Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    };
    if actual != expected {
        return Err(
            "the download doesn't match the release's checksum, so it wasn't installed".into(),
        );
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
        assert!(release_download(&format!("{base}{deb}"), deb, ".deb", false).is_ok());
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
                release_download(&url, name, ".deb", false).is_err(),
                "{url} {name}"
            );
        }
        assert!(release_download(
            &format!("{base}Winnow_1.5.0_android-universal.apk"),
            "Winnow_1.5.0_android-universal.apk",
            ".apk",
            false
        )
        .is_ok());
    }

    #[test]
    fn a_prerelease_download_needs_beta_updates() {
        let beta = "https://github.com/hxmbl/winnow/releases/download/v1.6.0-beta.1/";
        let deb = "Winnow_1.6.0-beta.1_amd64.deb";
        let apk = "Winnow_1.6.0-beta.1_android-universal.apk";
        // Stable: refused by the tag, whatever the file is called.
        let err = release_download(&format!("{beta}{deb}"), deb, ".deb", false).unwrap_err();
        assert!(err.contains("pre-release"), "{err}");
        assert!(release_download(&format!("{beta}{apk}"), apk, ".apk", false).is_err());
        let sneaky = "Winnow_1.6.0_amd64.deb";
        assert!(release_download(&format!("{beta}{sneaky}"), sneaky, ".deb", false).is_err());
        // Beta: the same files, with every other check still applied.
        assert!(release_download(&format!("{beta}{deb}"), deb, ".deb", true).is_ok());
        assert!(release_download(&format!("{beta}{apk}"), apk, ".apk", true).is_ok());
        assert!(release_download(&format!("{beta}../x/{deb}"), deb, ".deb", true).is_err());
        assert!(release_download(
            &format!("https://evil.example/v1.6.0-beta.1/{deb}"),
            deb,
            ".deb",
            true
        )
        .is_err());
        // A stable tag is fine either way.
        let stable =
            "https://github.com/hxmbl/winnow/releases/download/v1.6.0/Winnow_1.6.0_amd64.deb";
        assert!(release_download(stable, "Winnow_1.6.0_amd64.deb", ".deb", false).is_ok());
        assert!(release_download(stable, "Winnow_1.6.0_amd64.deb", ".deb", true).is_ok());
        assert_eq!(release_tag(stable), Some("v1.6.0"));
        assert_eq!(
            release_tag("https://github.com/hxmbl/winnow/releases/download//x"),
            None
        );
    }

    #[test]
    fn self_update_takes_a_prerelease_only_on_beta() {
        let pre = "https://github.com/hxmbl/winnow/releases/download/v1.6.0-beta.1/Winnow_1.6.0-beta.1_universal.app.tar.gz";
        let stable = "https://github.com/hxmbl/winnow/releases/download/v1.6.0/Winnow_1.6.0_universal.app.tar.gz";
        assert!(self_update_allowed("1.6.0", stable, false));
        assert!(!self_update_allowed("1.6.0-beta.1", pre, false));
        assert!(!self_update_allowed("1.6.0", pre, false));
        assert!(!self_update_allowed("1.6.0-beta.1", stable, false));
        assert!(!self_update_allowed(
            "1.6.0",
            "https://evil.example/x.tar.gz",
            false
        ));
        assert!(self_update_allowed("1.6.0-beta.1", pre, true));
        // The Beta manifest is only ever a release's own latest.json.
        let manifest =
            "https://github.com/hxmbl/winnow/releases/download/v1.6.0-beta.1/latest.json";
        assert!(manifest_url(manifest).is_ok());
        // Never `releases/latest`: that is the stable channel's.
        assert!(manifest_url(
            "https://github.com/hxmbl/winnow/releases/latest/download/latest.json"
        )
        .is_err());
        assert!(manifest_url("https://evil.example/latest.json").is_err());
        assert!(manifest_url(
            "https://github.com/hxmbl/winnow/releases/download/v1.6.0-beta.1/other.json"
        )
        .is_err());
    }

    #[test]
    fn the_checksum_comes_from_the_release_beside_the_file() {
        let base = "https://github.com/hxmbl/winnow/releases/download/v1.5.0/";
        let deb = "Winnow_1.5.0_amd64.deb";
        let url = release_download(&format!("{base}{deb}"), deb, ".deb", false).unwrap();
        assert_eq!(sums_url(&url).as_str(), format!("{base}SHA256SUMS"));

        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let sums = format!(
            "{b}  Winnow_1.5.0_android-universal.apk\n{}  {deb}\r\n",
            a.to_uppercase()
        );
        assert_eq!(expected_sha256(&sums, deb), Some(a.clone()));
        assert_eq!(
            expected_sha256(&format!("{a} *{deb}"), deb),
            Some(a.clone())
        );
        // No checksum, no install.
        assert_eq!(expected_sha256("", deb), None);
        assert_eq!(expected_sha256(&format!("{b}  other.deb"), deb), None);
        assert_eq!(
            expected_sha256(&format!("{a}  {deb}\n{b}  {deb}"), deb),
            None
        );
        assert_eq!(
            expected_sha256(&format!("{}  {deb}", "a".repeat(63)), deb),
            None
        );
        assert_eq!(
            expected_sha256(&format!("{}  {deb}", "g".repeat(64)), deb),
            None
        );
        assert_eq!(expected_sha256(&format!("{a}  x{deb}"), deb), None);
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
