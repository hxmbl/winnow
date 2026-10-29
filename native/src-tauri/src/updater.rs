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
//! **Stages.** Every install reports what it is doing over a `Channel` the web layer
//! passes in (`UpdateProgress`): `downloading` with bytes so far (and the size, when the
//! server says), then `verifying` while the download is checked (the updater's signature,
//! or `SHA256SUMS`), then `installing` while the app is swapped in or the installer opens.
//! The web layer turns those into the words on the Update button, the status pill and
//! Settings › About (`web/src/core/updates/stages.ts`). A report that can't be delivered
//! (the webview went away) is ignored; the install goes on.
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

/// What an install is doing, for the web layer (`parseProgress` in `stages.ts`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "stage")]
pub enum UpdateProgress {
    /// `received` bytes so far, of `total` when the server gave a size.
    Downloading { received: u64, total: Option<u64> },
    /// The download is being checked before anything opens it.
    Verifying,
    /// The app is being swapped in, or the checked file handed to the installer.
    Installing,
}

/// Download reports are spaced so a fast connection doesn't flood the webview: one per
/// whole percent when the size is known, one per `UNSIZED_STEP` bytes when it isn't,
/// and always the first and the last.
const UNSIZED_STEP: u64 = 512 * 1024;

/// Whether a download that has reached `received` (of `total`) is worth reporting, given
/// the last report was at `last` (None before the first).
pub fn worth_reporting(last: Option<u64>, received: u64, total: Option<u64>) -> bool {
    let Some(last) = last else {
        return true;
    };
    if received <= last {
        return false;
    }
    match total.filter(|t| *t > 0) {
        Some(total) => received >= total || received * 100 / total > last * 100 / total,
        None => received - last >= UNSIZED_STEP,
    }
}

/// Sends download reports through `send`, spaced by `worth_reporting`.
pub struct DownloadReporter<F: FnMut(UpdateProgress)> {
    send: F,
    received: u64,
    last: Option<u64>,
}

impl<F: FnMut(UpdateProgress)> DownloadReporter<F> {
    pub fn new(send: F) -> Self {
        Self {
            send,
            received: 0,
            last: None,
        }
    }

    /// `chunk` more bytes have arrived, of `total`.
    pub fn chunk(&mut self, chunk: u64, total: Option<u64>) {
        self.received = self.received.saturating_add(chunk);
        if worth_reporting(self.last, self.received, total) {
            self.last = Some(self.received);
            (self.send)(UpdateProgress::Downloading {
                received: self.received,
                total,
            });
        }
    }

    /// Any other stage, as it begins.
    pub fn stage(&mut self, progress: UpdateProgress) {
        (self.send)(progress);
    }
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
    on_progress: tauri::ipc::Channel<UpdateProgress>,
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
            // The channel goes on to the Kotlin plugin, which reports each stage on it
            // (`UpdatePlugin.installApk`), in the same shape as `UpdateProgress`.
            serde_json::json!({
                "url": url,
                "name": name,
                "beta": beta,
                "onProgress": on_progress,
            }),
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
    on_progress: tauri::ipc::Channel<UpdateProgress>,
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
    let channel = on_progress.clone();
    let mut reporter = DownloadReporter::new(move |progress| {
        let _ = channel.send(progress);
    });
    reporter.stage(UpdateProgress::Downloading {
        received: 0,
        total: None,
    });
    // `download` checks the updater's signature once the last byte is in, before it
    // hands the package back: that is the verifying stage.
    let verifying = on_progress.clone();
    let bytes = update
        .download(
            |chunk, total| reporter.chunk(chunk as u64, total),
            move || {
                let _ = verifying.send(UpdateProgress::Verifying);
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = on_progress.send(UpdateProgress::Installing);
    update.install(bytes).map_err(|e| e.to_string())?;
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
    on_progress: tauri::ipc::Channel<UpdateProgress>,
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
    let channel = on_progress.clone();
    let mut reporter = DownloadReporter::new(move |progress| {
        let _ = channel.send(progress);
    });
    reporter.stage(UpdateProgress::Downloading {
        received: 0,
        total: None,
    });
    let mut response = client
        .get(parsed.clone())
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("the download failed: {e}"))?;
    let total = response.content_length().filter(|len| *len > 0);
    if total.unwrap_or(0) > MAX_DOWNLOAD_BYTES {
        return Err("the file is too large".into());
    }
    // Read in chunks, so the web layer can show how far the download has got.
    let mut bytes: Vec<u8> = Vec::with_capacity(total.unwrap_or(0) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("the download failed: {e}"))?
    {
        if (bytes.len() + chunk.len()) as u64 > MAX_DOWNLOAD_BYTES {
            return Err("the file is too large".into());
        }
        bytes.extend_from_slice(&chunk);
        reporter.chunk(chunk.len() as u64, total);
    }
    // Checked before it is saved under its real name or opened: the release's own list.
    reporter.stage(UpdateProgress::Verifying);
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
    reporter.stage(UpdateProgress::Installing);
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
    fn progress_serialises_as_the_web_layer_reads() {
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading {
                received: 10,
                total: Some(100)
            })
            .unwrap(),
            serde_json::json!({ "stage": "downloading", "received": 10, "total": 100 })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading {
                received: 0,
                total: None
            })
            .unwrap(),
            serde_json::json!({ "stage": "downloading", "received": 0, "total": null })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Verifying).unwrap(),
            serde_json::json!({ "stage": "verifying" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Installing).unwrap(),
            serde_json::json!({ "stage": "installing" })
        );
    }

    #[test]
    fn download_reports_are_spaced_out() {
        // The first is always sent; then one per whole percent with a size.
        assert!(worth_reporting(None, 0, Some(1000)));
        assert!(!worth_reporting(Some(0), 5, Some(1000)));
        assert!(worth_reporting(Some(0), 10, Some(1000)));
        assert!(!worth_reporting(Some(10), 19, Some(1000)));
        assert!(worth_reporting(Some(19), 20, Some(1000)));
        // The last byte is always reported, and nothing goes backwards.
        assert!(worth_reporting(Some(995), 1000, Some(1000)));
        assert!(!worth_reporting(Some(1000), 1000, Some(1000)));
        assert!(!worth_reporting(Some(500), 400, Some(1000)));
        // Without a size: every half megabyte.
        assert!(!worth_reporting(Some(0), UNSIZED_STEP - 1, None));
        assert!(worth_reporting(Some(0), UNSIZED_STEP, None));
        assert!(!worth_reporting(Some(0), 10, Some(0)));

        let mut sent = Vec::new();
        {
            let mut reporter = DownloadReporter::new(|p| sent.push(p));
            reporter.stage(UpdateProgress::Downloading {
                received: 0,
                total: None,
            });
            for _ in 0..200 {
                reporter.chunk(5, Some(1000));
            }
            reporter.stage(UpdateProgress::Verifying);
            reporter.stage(UpdateProgress::Installing);
        }
        // The opening report, the first chunk, a report per percent, then the two stages.
        assert_eq!(sent.len(), 1 + 1 + 100 + 2);
        assert_eq!(
            sent[1],
            UpdateProgress::Downloading {
                received: 5,
                total: Some(1000)
            }
        );
        assert_eq!(
            sent[2],
            UpdateProgress::Downloading {
                received: 10,
                total: Some(1000)
            }
        );
        assert_eq!(
            sent[101],
            UpdateProgress::Downloading {
                received: 1000,
                total: Some(1000)
            }
        );
        assert_eq!(sent[102], UpdateProgress::Verifying);
        assert_eq!(sent[103], UpdateProgress::Installing);
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
