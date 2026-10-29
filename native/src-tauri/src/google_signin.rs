//! Native Google sign-in on Android, and the Custom Tab the browser sign-in opens in.
//!
//! A Tauri mobile plugin whose work is all Kotlin
//! (`gen/android/app/src/main/java/app/winnow/android/signin/GoogleSignInPlugin.kt`):
//! Google Play services' `AuthorizationClient` for the account sheet and the Gmail
//! grant, the package's signing certificate for the setup guide, and an AndroidX Custom
//! Tab for the loopback sign-in. The plugin is registered in the app crate rather than
//! as its own crate, so it rides in the app's Gradle module and needs no Gradle wiring.
//!
//! The webview reaches it only through three app commands (`commands.rs`), which
//! validate their arguments here and pass the plugin's JSON back untouched; there is no
//! `plugin:google-signin|…` permission, so the plugin's own commands are not callable
//! from the page. Off Android the commands answer "unsupported" without touching
//! anything, which is the web layer's cue to use the loopback flow it always used.

use serde_json::{json, Value};

/// The plugin's name, as Tauri registers it.
pub const PLUGIN_NAME: &str = "google-signin";

/// The only host a sign-in tab may open: Google's consent page.
const SIGN_IN_HOST: &str = "accounts.google.com";

/// Every scope a native sign-in may ask for. Winnow asks for Gmail and the basic profile
/// (`userinfo.profile`, the account's own picture) and, opted in, contacts; a request for
/// anything else did not come from the web layer as written.
const SCOPE_PREFIX: &str = "https://www.googleapis.com/auth/";
const MAX_SCOPES: usize = 12;

/// The suffix every Google OAuth client id carries (`credentials.ts` checks the same).
const CLIENT_ID_SUFFIX: &str = ".apps.googleusercontent.com";

/// A native sign-in's arguments, checked before anything reaches Play services.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizeRequest {
    pub server_client_id: String,
    pub scopes: Vec<String>,
}

impl AuthorizeRequest {
    /// Validate and normalise (trimmed id, scopes deduplicated in order).
    pub fn new(server_client_id: &str, scopes: &[String]) -> Result<Self, String> {
        let id = server_client_id.trim();
        let prefix = id.strip_suffix(CLIENT_ID_SUFFIX).unwrap_or("");
        if prefix.is_empty()
            || !prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err("that is not a Google OAuth client id".into());
        }
        let mut unique: Vec<String> = Vec::new();
        for scope in scopes {
            let scope = scope.trim();
            let tail = scope.strip_prefix(SCOPE_PREFIX).unwrap_or("");
            if tail.is_empty()
                || !tail
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            {
                return Err(format!("unexpected scope {scope:?}"));
            }
            if !unique.iter().any(|seen| seen == scope) {
                unique.push(scope.to_string());
            }
        }
        if unique.is_empty() {
            return Err("no scopes requested".into());
        }
        if unique.len() > MAX_SCOPES {
            return Err("too many scopes requested".into());
        }
        Ok(Self {
            server_client_id: id.to_string(),
            scopes: unique,
        })
    }

    /// The payload the Kotlin plugin parses (`AuthorizeArgs`).
    pub fn payload(&self) -> Value {
        json!({ "serverClientId": self.server_client_id, "scopes": self.scopes })
    }
}

/// Check a sign-in tab's URL: https, Google's consent host, nothing else.
pub fn sign_in_tab_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|_| "that is not a valid URL".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some(SIGN_IN_HOST) {
        return Err("a sign-in tab opens Google's consent page only".into());
    }
    Ok(parsed)
}

/// The answer the web layer reads as "use the browser" (`nativeGoogle.ts`).
pub fn unavailable(reason: &str, detail: impl Into<String>) -> Value {
    json!({ "kind": "unavailable", "reason": reason, "detail": detail.into() })
}

#[cfg(target_os = "android")]
mod android {
    use super::PLUGIN_NAME;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{Manager, Wry};

    const KOTLIN_PACKAGE: &str = "app.winnow.android.signin";
    const KOTLIN_CLASS: &str = "GoogleSignInPlugin";

    /// The registered Kotlin plugin, kept as app state for the commands.
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
pub use android::{init, Native};

/// Ask the Kotlin plugin; `Err` when it is not registered or did not answer.
#[cfg(target_os = "android")]
pub async fn call(app: &tauri::AppHandle, command: &str, payload: Value) -> Result<Value, String> {
    use tauri::Manager;
    let native = app
        .try_state::<Native>()
        .ok_or_else(|| "the sign-in plugin is not registered".to_string())?;
    native
        .0
        .run_mobile_plugin_async::<Value>(command, payload)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "1234567890-abc123def.apps.googleusercontent.com";
    const GMAIL: &str = "https://www.googleapis.com/auth/gmail.modify";

    fn scopes(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_well_formed_request_is_normalised() {
        let request = AuthorizeRequest::new(
            &format!("  {ID} "),
            &scopes(&[
                GMAIL,
                GMAIL,
                "https://www.googleapis.com/auth/contacts.readonly",
            ]),
        )
        .unwrap();
        assert_eq!(request.server_client_id, ID);
        assert_eq!(request.scopes.len(), 2);
        assert_eq!(
            request.payload(),
            json!({ "serverClientId": ID, "scopes": [GMAIL, "https://www.googleapis.com/auth/contacts.readonly"] })
        );
    }

    #[test]
    fn the_sign_in_scopes_are_accepted() {
        // Gmail and the basic profile, as the web layer's SIGN_IN_SCOPES sends them: the
        // full URL form, since the short `profile` would be refused like `openid`.
        let profile = "https://www.googleapis.com/auth/userinfo.profile";
        let request = AuthorizeRequest::new(ID, &scopes(&[GMAIL, profile])).unwrap();
        assert_eq!(request.scopes, scopes(&[GMAIL, profile]));
        assert!(AuthorizeRequest::new(ID, &scopes(&["profile"])).is_err());
    }

    #[test]
    fn a_client_id_must_be_one() {
        for bad in [
            "",
            ".apps.googleusercontent.com",
            "abc",
            "secret-not-an-id",
            "a b.apps.googleusercontent.com",
        ] {
            assert!(
                AuthorizeRequest::new(bad, &scopes(&[GMAIL])).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn scopes_are_google_api_scopes_only() {
        assert!(AuthorizeRequest::new(ID, &[]).is_err());
        assert!(AuthorizeRequest::new(ID, &scopes(&["openid"])).is_err());
        assert!(AuthorizeRequest::new(ID, &scopes(&["https://evil.example/auth/gmail"])).is_err());
        assert!(AuthorizeRequest::new(ID, &scopes(&["https://www.googleapis.com/auth/"])).is_err());
        assert!(AuthorizeRequest::new(
            ID,
            &scopes(&["https://www.googleapis.com/auth/gmail modify"])
        )
        .is_err());
        let many: Vec<String> = (0..13).map(|i| format!("{SCOPE_PREFIX}s{i}")).collect();
        assert!(AuthorizeRequest::new(ID, &many).is_err());
    }

    #[test]
    fn a_sign_in_tab_opens_google_consent_only() {
        assert!(
            sign_in_tab_url("https://accounts.google.com/o/oauth2/v2/auth?client_id=x").is_ok()
        );
        for bad in [
            "http://accounts.google.com/o/oauth2/v2/auth",
            "https://accounts.google.com.evil.example/",
            "https://example.com/",
            "winnow://signed-in",
            "not a url",
        ] {
            assert!(sign_in_tab_url(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn unavailable_is_the_shape_the_web_layer_reads() {
        assert_eq!(
            unavailable("unsupported", "desktop"),
            json!({ "kind": "unavailable", "reason": "unsupported", "detail": "desktop" })
        );
    }
}
