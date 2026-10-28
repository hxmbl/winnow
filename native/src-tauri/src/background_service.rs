//! Background sync on Android: the foreground service that keeps checking Gmail with
//! the app closed.
//!
//! All of the work is Kotlin (`gen/android/app/src/main/java/app/winnow/android/sync/`):
//! `MailSyncService` (a `specialUse` foreground service with a silent, low-importance
//! notification) polls each account's `history.list` (every 5 minutes, or every 10
//! while the Gmail-app listener, `GmailNotificationListener`, is connected and checks
//! the moment the Gmail app posts a notification) and posts the same new-mail
//! notifications the app does. It runs in Kotlin rather than here because
//! Android may start it with no activity at all (on boot, or after killing the app),
//! when neither the webview nor this crate's Tauri runtime exists. It reads the tokens
//! this crate's keychain wrote (`secrets.rs`, Android store) without writing them.
//!
//! What crosses from the web layer is a description, never a secret: which accounts are
//! signed in (id, address, their notification switch), which buttons notifications
//! offer, whether previews are hidden, which senders are muted or hidden, and whether
//! "Keep syncing while closed" and notifications are on, and whether "Instant mail via
//! the Gmail app" is ([`Config`]). This module
//! validates it and hands it to the Kotlin plugin, which saves it and starts or stops
//! the service. The plugin's own commands are not granted to the webview.
//!
//! Off Android every command answers `None` without doing anything: the desktop keeps
//! syncing with its tray ticker (`scheduler.rs`).

use serde::{Deserialize, Serialize};

pub const PLUGIN_NAME: &str = "winnow-bgsync";

/// Accounts a config may name (`MAX_ACCOUNTS` in `accounts.ts`).
pub const MAX_ACCOUNTS: usize = 5;
/// Muted and hidden senders passed on; more are dropped (the oldest first).
pub const MAX_QUIET: usize = 2_000;

/// One signed-in account.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigAccount {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "yes")]
    pub notify: bool,
    /// The account's address whatever the number of accounts (`label` is set only with
    /// several): what the Gmail-app listener matches a Gmail notification against.
    #[serde(default)]
    pub address: Option<String>,
}

fn yes() -> bool {
    true
}

/// What the background service needs to know (`BackgroundConfig.kt` reads the same shape).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    #[serde(default)]
    pub accounts: Vec<ConfigAccount>,
    #[serde(default)]
    pub active_account: Option<String>,
    /// 1 reply, 2 delete, 4 mark read.
    #[serde(default = "all_actions")]
    pub actions: u8,
    #[serde(default)]
    pub hide_preview: bool,
    #[serde(default)]
    pub quiet_senders: Vec<String>,
    /// "Instant mail via the Gmail app" (STRM-442): check as soon as the Gmail app posts a
    /// notification (`GmailNotificationListener.kt`). Never on while `enabled` is off.
    #[serde(default)]
    pub gmail_listener: bool,
}

fn all_actions() -> u8 {
    7
}

impl Config {
    /// Drop anything that is not what it claims to be: a malformed account id never
    /// reaches a keychain name, a label is an address of sane length, and a config with
    /// no account left is off.
    pub fn sanitised(mut self) -> Self {
        let mut seen = Vec::new();
        self.accounts.retain(|a| {
            let ok = crate::notify_actions::plan::valid_account_id(&a.id) && !seen.contains(&a.id);
            if ok {
                seen.push(a.id.clone());
            }
            ok
        });
        self.accounts.truncate(MAX_ACCOUNTS);
        for account in &mut self.accounts {
            account.label = account
                .label
                .take()
                .map(|l| l.trim().chars().take(320).collect::<String>())
                .filter(|l| !l.is_empty());
            account.address = account
                .address
                .take()
                .map(|a| a.trim().to_lowercase())
                .filter(|a| a.contains('@') && a.len() <= 320);
        }
        if let Some(active) = &self.active_account {
            if !self.accounts.iter().any(|a| &a.id == active) {
                self.active_account = None;
            }
        }
        self.actions &= 7;
        self.quiet_senders = self
            .quiet_senders
            .into_iter()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty() && s.len() <= 320)
            .collect();
        if self.quiet_senders.len() > MAX_QUIET {
            let excess = self.quiet_senders.len() - MAX_QUIET;
            self.quiet_senders.drain(..excess);
        }
        self.enabled = self.enabled && !self.accounts.is_empty();
        self.gmail_listener = self.gmail_listener && self.enabled;
        self
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::PLUGIN_NAME;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{Manager, Wry};

    const KOTLIN_PACKAGE: &str = "app.winnow.android.sync";
    const KOTLIN_CLASS: &str = "BackgroundSyncPlugin";

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

/// One call to the Kotlin plugin.
#[cfg(target_os = "android")]
pub async fn call(
    app: &tauri::AppHandle,
    command: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let native = app
        .try_state::<android::Native>()
        .ok_or_else(|| "the background sync plugin is not registered".to_string())?;
    native
        .0
        .run_mobile_plugin_async::<serde_json::Value>(command, payload)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str) -> ConfigAccount {
        ConfigAccount {
            id: id.into(),
            label: Some(format!(" {id}@example.com ")),
            notify: true,
            address: Some(format!(" {id}@Example.com ")),
        }
    }

    #[test]
    fn the_web_layer_payload_deserialises() {
        let config: Config = serde_json::from_str(
            r#"{"enabled":true,"accounts":[{"id":"abcd1234","label":"me@example.com","notify":false}],
                "activeAccount":"abcd1234","actions":6,"hidePreview":true,"quietSenders":["News@Example.com"]}"#,
        )
        .unwrap();
        assert!(config.enabled);
        assert!(!config.accounts[0].notify);
        assert_eq!(config.actions, 6);
        assert_eq!(config.active_account.as_deref(), Some("abcd1234"));
    }

    #[test]
    fn sanitising_drops_malformed_accounts_and_turns_an_empty_config_off() {
        let config = Config {
            enabled: true,
            accounts: vec![
                account("../etc"),
                account("abcd1234"),
                account("abcd1234"),
                account("AB"),
            ],
            active_account: Some("../etc".into()),
            actions: 0xff,
            hide_preview: false,
            quiet_senders: vec!["  A@B.C ".into(), "".into()],
            gmail_listener: true,
        }
        .sanitised();
        assert_eq!(config.accounts.len(), 1);
        assert_eq!(
            config.accounts[0].label.as_deref(),
            Some("abcd1234@example.com")
        );
        assert_eq!(config.active_account, None);
        assert_eq!(config.actions, 7);
        assert_eq!(config.quiet_senders, vec!["a@b.c".to_string()]);
        assert!(config.enabled);
        assert!(config.gmail_listener);
        assert_eq!(
            config.accounts[0].address.as_deref(),
            Some("abcd1234@example.com")
        );

        let none = Config {
            enabled: true,
            accounts: vec![account("x")],
            active_account: None,
            actions: 7,
            hide_preview: false,
            quiet_senders: vec![],
            gmail_listener: false,
        }
        .sanitised();
        assert!(!none.enabled);
    }

    #[test]
    fn the_gmail_listener_is_never_on_without_background_sync() {
        let config = serde_json::from_str::<Config>(
            r#"{"enabled":false,"accounts":[{"id":"abcd1234","address":"not an address"}],"gmailListener":true}"#,
        )
        .unwrap()
        .sanitised();
        assert!(!config.gmail_listener);
        assert_eq!(config.accounts[0].address, None);
        let old: Config = serde_json::from_str(r#"{"enabled":true,"accounts":[]}"#).unwrap();
        assert!(
            !old.gmail_listener,
            "an older web layer's config leaves it off"
        );
    }

    #[test]
    fn at_most_five_accounts() {
        let ids = [
            "aaaa1111", "bbbb2222", "cccc3333", "dddd4444", "eeee5555", "ffff6666",
        ];
        let config = Config {
            enabled: true,
            accounts: ids.iter().map(|id| account(id)).collect(),
            active_account: None,
            actions: 7,
            hide_preview: false,
            quiet_senders: vec![],
            gmail_listener: false,
        }
        .sanitised();
        assert_eq!(config.accounts.len(), MAX_ACCOUNTS);
    }

    #[test]
    fn it_serialises_the_camel_case_kotlin_reads() {
        let config = Config {
            enabled: true,
            accounts: vec![account("abcd1234")],
            active_account: Some("abcd1234".into()),
            actions: 7,
            hide_preview: true,
            quiet_senders: vec![],
            gmail_listener: false,
        };
        let json = serde_json::to_value(&config).unwrap();
        for key in [
            "enabled",
            "accounts",
            "activeAccount",
            "actions",
            "hidePreview",
            "quietSenders",
            "gmailListener",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }
}
