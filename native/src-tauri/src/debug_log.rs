//! The native half of Dev Options → Debug log.
//!
//! The log the user reads lives in the web layer (`web/src/core/debug/debugLog.ts`).
//! Rust keeps its own lines here and the web layer drains them into that log
//! (`debug_log_drain`), merged by timestamp, so one Copy holds both sides. The web
//! layer drains when Rust nudges it (`DEBUG_LOG_EVENT`), when the app comes back to
//! the front and before Copy, which matters on Android: while the browser is in front
//! the WebView may be paused, and the lines Rust records then (the loopback listener's
//! requests, above all) wait here until it can take them.
//!
//! The same rules as the web log:
//!
//! - **Only while the switch is on.** `set_enabled(false)` (the default) makes
//!   [`record`] a no-op; the [`dlog!`](crate::dlog) macro does not even build its
//!   fields.
//! - **Memory only**, at most [`CAP`] lines waiting, oldest dropped first.
//! - **Redacted at the door.** Callers pass ports, paths, counts, kinds and timings,
//!   never query values; every value still goes through [`redact_value`], which drops
//!   anything shaped like an email address, a token or a key, and long free text.

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// The most lines kept waiting for the web layer, the same as its own cap.
pub const CAP: usize = 10_000;

/// Emitted (no payload) when lines start waiting, so the web layer drains them.
pub const DEBUG_LOG_EVENT: &str = "winnow://debug-log";

static ENABLED: AtomicBool = AtomicBool::new(false);
static PENDING: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static NOTIFY: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// Record one event, if the log is on. `area` and `event` are fixed words.
///
/// ```ignore
/// crate::dlog!("auth", "listener-bound", addr = "127.0.0.1", port = port);
/// ```
#[macro_export]
macro_rules! dlog {
    ($area:expr, $event:expr $(, $key:ident = $value:expr)* $(,)?) => {
        if $crate::debug_log::enabled() {
            $crate::debug_log::record(
                $area,
                $event,
                &[$((stringify!($key), ::std::string::ToString::to_string(&$value))),*],
            );
        }
    };
}

/// Turn recording on or off. Turning it off keeps the lines already waiting.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::SeqCst);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// Install the nudge (`lib.rs` emits [`DEBUG_LOG_EVENT`]). The first one wins.
pub fn set_notifier(notify: impl Fn() + Send + Sync + 'static) {
    let _ = NOTIFY.set(Box::new(notify));
}

/// Field names whose values are content or secrets: only their length is kept.
const CONTENT_FIELD: [&str; 16] = [
    "subject", "body", "snippet", "text", "content", "html", "preview", "name", "from", "to",
    "address", "email", "token", "secret", "password", "code",
];

/// Free text longer than this is treated as content.
const MAX_TEXT: usize = 80;

/// Whether `value` has something in it shaped like a token or a key.
fn looks_like_token(value: &str) -> bool {
    if value.contains("ya29.") || value.contains("1//") || value.contains("Bearer ") {
        return true;
    }
    if value.contains("eyJ") && value.matches('.').count() >= 2 {
        return true;
    }
    // Any run of 32 or more key-ish characters.
    let mut run = 0usize;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            run += 1;
            if run >= 32 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// Whether `value` has something in it shaped like an email address.
fn looks_like_email(value: &str) -> bool {
    value
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '"')
        .any(|word| {
            let Some((local, domain)) = word.split_once('@') else {
                return false;
            };
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.')
        })
}

/// One value, made safe to keep. Stricter than the web's: a value with a token or an
/// address anywhere in it is replaced whole.
pub fn redact_value(key: &str, value: &str) -> String {
    if CONTENT_FIELD
        .iter()
        .any(|field| field.eq_ignore_ascii_case(key))
    {
        return format!("[{key}: {} chars]", value.chars().count());
    }
    if looks_like_token(value) {
        return "[token]".into();
    }
    if looks_like_email(value) {
        return "[email]".into();
    }
    let length = value.chars().count();
    if length > MAX_TEXT {
        return format!("[text: {length} chars]");
    }
    if value.chars().any(char::is_whitespace) || value.contains('"') {
        serde_json::to_string(value).unwrap_or_else(|_| "[text]".into())
    } else {
        value.to_string()
    }
}

/// One line, in the web log's shape: `<ISO time> <area> rust:<event> k=v …`.
pub fn format_line(now: SystemTime, area: &str, event: &str, fields: &[(&str, String)]) -> String {
    let mut line = format!(
        "{} {} rust:{}",
        iso8601(now),
        redact_value("area", area),
        redact_value("event", event)
    );
    for (key, value) in fields {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(&redact_value(key, value));
    }
    line
}

/// Record one event, if the log is on. Prefer [`dlog!`](crate::dlog).
pub fn record(area: &str, event: &str, fields: &[(&str, String)]) {
    if !enabled() {
        return;
    }
    let line = format_line(SystemTime::now(), area, event, fields);
    let was_empty = {
        let mut pending = PENDING.lock();
        let was_empty = pending.is_empty();
        if pending.len() >= CAP {
            pending.pop_front();
        }
        pending.push_back(line);
        was_empty
    };
    // One nudge per batch: the web layer drains everything waiting when it answers.
    if was_empty {
        if let Some(notify) = NOTIFY.get() {
            notify();
        }
    }
}

/// Everything waiting, oldest first, leaving nothing behind.
pub fn drain() -> Vec<String> {
    PENDING.lock().drain(..).collect()
}

/// `2026-10-27T15:42:07.123Z`, the shape `Date.prototype.toISOString` writes, so the
/// web layer can merge both sides by sorting on the text.
pub fn iso8601(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let millis = since.subsec_millis();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::time::Duration;

    /// The switch and the queue are process-wide, and tests run in parallel: every
    /// test that turns the log on holds this.
    pub(crate) static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn timestamps_match_javascript_iso_strings() {
        // Date.UTC(2026, 9, 27, 15, 42, 7, 123)
        let t = UNIX_EPOCH + Duration::from_millis(1_793_115_727_123);
        assert_eq!(iso8601(t), "2026-10-27T15:42:07.123Z");
        assert_eq!(iso8601(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        // A leap day.
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(iso8601(leap), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn secrets_addresses_and_content_never_survive() {
        assert_eq!(
            redact_value("code", "4/0AVMBsJh-whatever"),
            "[code: 19 chars]"
        );
        assert_eq!(redact_value("token", "abc"), "[token: 3 chars]");
        assert_eq!(redact_value("error", "401 for ya29.a0AfH6SMBx"), "[token]");
        assert_eq!(redact_value("x", "Bearer abc.def"), "[token]");
        assert_eq!(redact_value("x", "1//0gLongRefresh"), "[token]");
        assert_eq!(
            redact_value("x", "AIzaSyD-very-long-api-key-1234567890abcdef"),
            "[token]"
        );
        assert_eq!(redact_value("x", "eyJhbGciOi.eyJzdWIiOi.c2ln"), "[token]");
        assert_eq!(
            redact_value("account", "sam.lee+x@example.co.uk"),
            "[email]"
        );
        assert_eq!(
            redact_value("reason", "failed for dana@acme.example today"),
            "[email]"
        );
        assert_eq!(
            redact_value("reason", &"word ".repeat(30)),
            "[text: 150 chars]"
        );
        // Ports, paths, kinds and counts survive.
        assert_eq!(redact_value("port", "43817"), "43817");
        assert_eq!(redact_value("path", "/winnow-oauth"), "/winnow-oauth");
        assert_eq!(redact_value("addr", "127.0.0.1:43817"), "127.0.0.1:43817");
        assert_eq!(redact_value("reason", "timed out"), "\"timed out\"");
    }

    #[test]
    fn lines_are_recorded_only_while_on_and_drained_once() {
        let _serial = SERIAL.lock();
        drain();
        set_enabled(false);
        crate::dlog!("auth", "ignored", port = 1);
        assert!(drain().is_empty());

        set_enabled(true);
        crate::dlog!(
            "auth",
            "listener-bound",
            addr = "127.0.0.1",
            port = 43817u16
        );
        set_enabled(false);
        // Listener tests elsewhere may log while the switch is on: look for this line.
        let lines: Vec<String> = drain()
            .into_iter()
            .filter(|line| line.contains("rust:listener-bound addr=127.0.0.1 port=43817"))
            .collect();
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].ends_with(" auth rust:listener-bound addr=127.0.0.1 port=43817"),
            "{}",
            lines[0]
        );
        assert!(drain().is_empty(), "a drain leaves nothing behind");
    }

    #[test]
    fn the_queue_keeps_at_most_the_cap() {
        let _serial = SERIAL.lock();
        drain();
        set_enabled(true);
        for n in 0..CAP + 5 {
            crate::dlog!("sync", "tick", n = n);
        }
        set_enabled(false);
        let lines = drain();
        assert_eq!(lines.len(), CAP);
        let last = lines
            .iter()
            .rev()
            .find(|line| line.contains("rust:tick"))
            .unwrap();
        assert!(last.ends_with(&format!(" n={}", CAP + 4)), "{last}");
        // The oldest five were dropped.
        assert!(!lines.iter().any(|line| line.ends_with("rust:tick n=4")));
    }
}
