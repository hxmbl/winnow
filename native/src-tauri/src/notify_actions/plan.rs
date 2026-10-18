//! What a notification action *does*, as pure functions.
//!
//! No Tauri, no JNI, no sockets: the Android path hands this module a
//! [`Transport`] that performs one HTTP exchange (the Kotlin plugin's
//! `HttpURLConnection`, because this crate has no TLS client), and the tests hand
//! it a fake. Everything that can be wrong about an action — which request, which
//! token, what a failure means, what the notification says afterwards, and the raw
//! reply itself — is decided here, where `cargo test` can see it on any host.
//!
//! **The reply is the composer's message.** The web layer builds the reply's header
//! block with the composer's own builder (`rawFor` → `buildMime` in `session.ts`,
//! with an empty body) at the moment it posts the notification, and passes it down
//! as `replyHead`. This module only swaps in the current `Date:` and appends the
//! typed text, encoded exactly as `buildMime` encodes a body (UTF-8, base64, CRLF
//! after every 76 characters). `From`, `To`, `Subject`, `Message-ID`, `In-Reply-To`
//! and `References` are never written here, so they cannot drift from the composer.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};

pub const GMAIL_API: &str = "https://gmail.googleapis.com/gmail/v1";
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// Keychain names, as the web layer writes them (`desktop.ts`, `credentials.ts`).
pub const TOKENS_SECRET: &str = "gmail.tokens";
pub const CLIENT_SECRET: &str = "google.oauth-client";

/// Refresh this long before the recorded expiry, as `tokens.ts` does.
const EXPIRY_SKEW_MS: i64 = 60_000;

/// Gmail ids are hex today; anything outside this set never reaches a URL.
pub fn valid_gmail_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

// ── Wire ────────────────────────────────────────────────────────────────────

/// One action, as the Kotlin receiver reports it.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub request_id: String,
    pub action: String,
    pub notification_id: i32,
    #[serde(default)]
    pub message_id: i64,
    pub gmail_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub reply_head: Option<String>,
    #[serde(default)]
    pub reply: Option<String>,
}

/// What to do, once the request has been validated.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Reply(String),
    Trash,
    Read,
    /// The Undo on a "Moved to Trash" confirmation.
    Untrash,
}

impl ActionRequest {
    pub fn parse_action(&self) -> Option<Action> {
        match self.action.as_str() {
            "reply" => Some(Action::Reply(self.reply.clone().unwrap_or_default())),
            "trash" => Some(Action::Trash),
            "read" => Some(Action::Read),
            "untrash" => Some(Action::Untrash),
            _ => None,
        }
    }
}

/// One HTTP exchange for the transport to perform.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// What came back. `status == 0` means no HTTP response at all (offline, DNS,
/// timeout), which is the one case a user can fix by finding a signal.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    #[serde(default)]
    pub body: String,
}

pub trait Transport {
    fn exchange(&mut self, request: &HttpRequest) -> HttpResponse;
}

impl<F: FnMut(&HttpRequest) -> HttpResponse> Transport for F {
    fn exchange(&mut self, request: &HttpRequest) -> HttpResponse {
        self(request)
    }
}

// ── Credentials ─────────────────────────────────────────────────────────────

/// The keychain's `gmail.tokens` (`TokenSet` in `dto.ts`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Epoch milliseconds. Read as a float: JSON numbers from JS can carry `.0`.
    #[serde(default)]
    pub expires_at: f64,
}

/// The keychain's `google.oauth-client` (`OAuthClientCredentials`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCredentials {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
}

/// The two raw secrets, as read. Parsed here so a malformed one is a failure
/// with a reason rather than a panic in the reader.
#[derive(Debug, Clone, Default)]
pub struct Secrets {
    pub tokens: Option<String>,
    pub client: Option<String>,
}

// ── Outcome ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// No HTTP response.
    Offline,
    /// Signed out, refresh refused, or 401/403 after a fresh token.
    Auth,
    /// Anything else Google said no to.
    Server(u16),
    /// The request itself was unusable (bad id, no reply head).
    Invalid,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Sent,
    /// The send failed, the reply is in Gmail's Drafts.
    SavedAsDraft(Failure),
    /// Neither send nor draft worked: the text stays on the device (the Kotlin
    /// side wrote it before asking) until Winnow opens and saves it.
    KeptOnDevice(Failure),
    /// An empty reply: nothing to send, the notification goes back as it was.
    EmptyReply,
    Trashed,
    MarkedRead,
    Restored,
    Failed(Failure),
}

/// What the notification says afterwards. Mirrors `finish` in `NotifyPlugin.kt`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finish {
    pub request_id: String,
    pub notification_id: i32,
    /// `done` (dismiss shortly), `undo` (dismiss shortly, offer Undo), `restore`
    /// (put the original back) or `failed` (stay, tap opens Winnow).
    pub kind: &'static str,
    pub title: String,
    pub text: String,
    /// Whether the device copy of a typed reply can go: it has been sent or is
    /// safely in Gmail's Drafts.
    pub release_pending: bool,
}

pub const COULD_NOT_SEND: &str = "Couldn't send. Open Winnow";

pub fn finish_for(request: &ActionRequest, outcome: &Outcome) -> Finish {
    let (kind, title, text, release) = match outcome {
        Outcome::Sent => ("done", "Sent", "", true),
        Outcome::SavedAsDraft(failure) => (
            "failed",
            COULD_NOT_SEND,
            match failure {
                Failure::Offline => "You're offline. Your reply is saved in Drafts.",
                Failure::Auth => {
                    "Winnow needs you to sign in again. Your reply is saved in Drafts."
                }
                _ => "Gmail didn't accept it. Your reply is saved in Drafts.",
            },
            true,
        ),
        Outcome::KeptOnDevice(failure) => (
            "failed",
            COULD_NOT_SEND,
            match failure {
                Failure::Offline => {
                    "You're offline. Your reply is kept on this phone until Winnow opens."
                }
                Failure::Auth => {
                    "Winnow needs you to sign in again. Your reply is kept on this phone."
                }
                _ => "Your reply is kept on this phone until Winnow opens.",
            },
            false,
        ),
        Outcome::EmptyReply => ("restore", "", "", true),
        Outcome::Trashed => ("undo", "Moved to Trash", "", true),
        Outcome::MarkedRead => ("done", "Marked as read", "", true),
        Outcome::Restored => ("done", "Moved back to Inbox", "", true),
        Outcome::Failed(failure) => (
            "failed",
            "Couldn't do that. Open Winnow",
            match failure {
                Failure::Offline => "You're offline.",
                Failure::Auth => "Winnow needs you to sign in again.",
                _ => "Gmail didn't accept it.",
            },
            true,
        ),
    };
    Finish {
        request_id: request.request_id.clone(),
        notification_id: request.notification_id,
        kind,
        title: title.to_string(),
        text: text.to_string(),
        release_pending: release,
    }
}

// ── Execution ───────────────────────────────────────────────────────────────

/// Run one action to an outcome. Never panics and never retries a send.
pub fn execute(
    request: &ActionRequest,
    secrets: &Secrets,
    now_ms: i64,
    transport: &mut impl Transport,
) -> Outcome {
    let Some(action) = request.parse_action() else {
        return Outcome::Failed(Failure::Invalid);
    };
    let fail = |failure: Failure| match &action {
        Action::Reply(_) => Outcome::KeptOnDevice(failure),
        _ => Outcome::Failed(failure),
    };
    if let Action::Reply(text) = &action {
        if text.trim().is_empty() {
            return Outcome::EmptyReply;
        }
    }
    if !valid_gmail_id(&request.gmail_id) {
        return fail(Failure::Invalid);
    }
    let thread_id = request
        .thread_id
        .as_deref()
        .filter(|id| valid_gmail_id(id))
        .map(str::to_string);

    let mut session = match Session::open(secrets, now_ms) {
        Ok(session) => session,
        Err(failure) => return fail(failure),
    };

    match action {
        Action::Reply(text) => {
            let Some(head) = request.reply_head.as_deref() else {
                return Outcome::KeptOnDevice(Failure::Invalid);
            };
            let raw = match assemble_reply(head, &text, now_ms) {
                Ok(raw) => raw,
                Err(_) => return Outcome::KeptOnDevice(Failure::Invalid),
            };
            let send = session.call(
                transport,
                "POST",
                "/users/me/messages/send",
                Some(send_body(&raw, thread_id.as_deref())),
            );
            match send {
                Ok(_) => Outcome::Sent,
                Err(send_failure) => {
                    // Never resend: a send whose answer was lost may have gone. The
                    // draft is the safe second step either way.
                    let draft = session.call(
                        transport,
                        "POST",
                        "/users/me/drafts",
                        Some(draft_body(&raw, thread_id.as_deref())),
                    );
                    match draft {
                        Ok(_) => Outcome::SavedAsDraft(send_failure),
                        Err(_) => Outcome::KeptOnDevice(send_failure),
                    }
                }
            }
        }
        Action::Trash => modify(
            &mut session,
            transport,
            &request.gmail_id,
            &["TRASH"],
            &["INBOX"],
        )
        .map(|_| Outcome::Trashed)
        .unwrap_or_else(Outcome::Failed),
        Action::Read => modify(&mut session, transport, &request.gmail_id, &[], &["UNREAD"])
            .map(|_| Outcome::MarkedRead)
            .unwrap_or_else(Outcome::Failed),
        // The app's own restore: Trash off, Inbox back on (`client.ts` `restore`).
        Action::Untrash => modify(
            &mut session,
            transport,
            &request.gmail_id,
            &["INBOX"],
            &["TRASH"],
        )
        .map(|_| Outcome::Restored)
        .unwrap_or_else(Outcome::Failed),
    }
}

fn modify(
    session: &mut Session,
    transport: &mut impl Transport,
    gmail_id: &str,
    add: &[&str],
    remove: &[&str],
) -> Result<(), Failure> {
    let body = serde_json::json!({ "addLabelIds": add, "removeLabelIds": remove }).to_string();
    session
        .call(
            transport,
            "POST",
            &format!("/users/me/messages/{gmail_id}/modify"),
            Some(body),
        )
        .map(|_| ())
}

fn send_body(raw: &str, thread_id: Option<&str>) -> String {
    let mut body = serde_json::json!({ "raw": URL_SAFE_NO_PAD.encode(raw.as_bytes()) });
    if let Some(thread) = thread_id {
        body["threadId"] = thread.into();
    }
    body.to_string()
}

fn draft_body(raw: &str, thread_id: Option<&str>) -> String {
    let mut message = serde_json::json!({ "raw": URL_SAFE_NO_PAD.encode(raw.as_bytes()) });
    if let Some(thread) = thread_id {
        message["threadId"] = thread.into();
    }
    serde_json::json!({ "message": message }).to_string()
}

/// A token and the means to replace it, for the length of one action.
struct Session {
    access: Option<String>,
    refresh: Option<String>,
    client: Option<ClientCredentials>,
    refreshed: bool,
    /// A refresh that failed is not tried again in the same action.
    refusal: Option<Failure>,
}

impl Session {
    fn open(secrets: &Secrets, now_ms: i64) -> Result<Self, Failure> {
        let tokens: TokenSet = secrets
            .tokens
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .ok_or(Failure::Auth)?;
        let client: Option<ClientCredentials> = secrets
            .client
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok());
        let fresh =
            !tokens.access_token.is_empty() && (tokens.expires_at as i64) - EXPIRY_SKEW_MS > now_ms;
        Ok(Self {
            access: fresh.then_some(tokens.access_token),
            refresh: tokens.refresh_token.filter(|token| !token.is_empty()),
            client,
            refreshed: false,
            refusal: None,
        })
    }

    fn refresh(&mut self, transport: &mut impl Transport) -> Result<String, Failure> {
        if let Some(failure) = self.refusal {
            return Err(failure);
        }
        let result = self.refresh_once(transport);
        if let Err(failure) = result {
            self.refusal = Some(failure);
        }
        result
    }

    fn refresh_once(&mut self, transport: &mut impl Transport) -> Result<String, Failure> {
        let (Some(refresh), Some(client)) = (self.refresh.as_ref(), self.client.as_ref()) else {
            return Err(Failure::Auth);
        };
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("client_id", &client.client_id);
        form.append_pair("refresh_token", refresh);
        form.append_pair("grant_type", "refresh_token");
        if let Some(secret) = client.client_secret.as_deref().filter(|s| !s.is_empty()) {
            form.append_pair("client_secret", secret);
        }
        let response = transport.exchange(&HttpRequest {
            method: "POST".into(),
            url: GOOGLE_TOKEN_URL.into(),
            headers: vec![(
                "Content-Type".into(),
                "application/x-www-form-urlencoded".into(),
            )],
            body: Some(form.finish()),
        });
        self.refreshed = true;
        match response.status {
            0 => Err(Failure::Offline),
            200..=299 => {
                #[derive(Deserialize)]
                struct Refreshed {
                    access_token: String,
                }
                let token = serde_json::from_str::<Refreshed>(&response.body)
                    .map_err(|_| Failure::Server(response.status))?
                    .access_token;
                self.access = Some(token.clone());
                Ok(token)
            }
            // `invalid_grant` and friends: the grant is gone; a person has to sign in.
            400 | 401 | 403 => Err(Failure::Auth),
            status => Err(Failure::Server(status)),
        }
    }

    fn token(&mut self, transport: &mut impl Transport) -> Result<String, Failure> {
        match self.access.clone() {
            Some(token) => Ok(token),
            None => self.refresh(transport),
        }
    }

    /// One Gmail call. A 401 gets exactly one refresh and one replay, as in `client.ts`.
    fn call(
        &mut self,
        transport: &mut impl Transport,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<String, Failure> {
        let mut replayed = false;
        loop {
            let token = self.token(transport)?;
            let mut headers = vec![("Authorization".to_string(), format!("Bearer {token}"))];
            if body.is_some() {
                headers.push(("Content-Type".into(), "application/json".into()));
            }
            let response = transport.exchange(&HttpRequest {
                method: method.into(),
                url: format!("{GMAIL_API}{path}"),
                headers,
                body: body.clone(),
            });
            match response.status {
                0 => return Err(Failure::Offline),
                200..=299 => return Ok(response.body),
                401 if !replayed && !self.refreshed => {
                    replayed = true;
                    self.access = None;
                    self.refresh(transport)?;
                }
                401 | 403 => return Err(Failure::Auth),
                status => return Err(Failure::Server(status)),
            }
        }
    }
}

// ── The raw reply ───────────────────────────────────────────────────────────

/// The composer's header block plus the typed text, as one RFC 822 message.
///
/// `head` is `buildMime`'s output for an empty body: headers, a blank line, and
/// nothing after it. Refused unless it looks like exactly that, and unless it is a
/// reply (`In-Reply-To`) with a base64 text body, which is all this ever appends.
pub fn assemble_reply(head: &str, text: &str, now_ms: i64) -> Result<String, &'static str> {
    let Some(block) = head.strip_suffix("\r\n\r\n") else {
        return Err("the reply head does not end its header block");
    };
    if block.contains("\r\n\r\n") {
        return Err("the reply head carries a body");
    }
    let lines: Vec<&str> = block.split("\r\n").collect();
    if !lines.iter().any(|line| line.starts_with("In-Reply-To: ")) {
        return Err("the reply head is not a reply");
    }
    if !lines.contains(&"Content-Transfer-Encoding: base64") {
        return Err("the reply head is not a base64 text body");
    }
    let date = format!("Date: {}", http_date(now_ms));
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut dated = false;
    for line in lines {
        if line.starts_with("Date: ") {
            out.push(date.clone());
            dated = true;
        } else {
            out.push(line.to_string());
        }
    }
    if !dated {
        out.insert(0, date);
    }
    Ok(format!(
        "{}\r\n\r\n{}",
        out.join("\r\n"),
        wrapped_base64(text)
    ))
}

/// `buildMime`'s body encoding: base64 of the UTF-8, with CRLF after every full
/// 76-character line (the regex `(.{76})` → `$1\r\n`, trailing one included).
pub fn wrapped_base64(text: &str) -> String {
    let encoded = STANDARD.encode(text.as_bytes());
    let mut out = String::with_capacity(encoded.len() + encoded.len() / 76 * 2);
    let bytes = encoded.as_bytes();
    let mut index = 0;
    while index + 76 <= bytes.len() {
        out.push_str(&encoded[index..index + 76]);
        out.push_str("\r\n");
        index += 76;
    }
    out.push_str(&encoded[index..]);
    out
}

/// `Date.prototype.toUTCString()`: `Sun, 18 Oct 2026 13:53:00 GMT`.
pub fn http_date(now_ms: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let secs = now_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        DAYS[days.rem_euclid(7) as usize],
        day,
        MONTHS[(month - 1) as usize],
        year,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 → (y, m, d).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_792_331_580_000; // 2026-10-18T13:53:00Z

    fn head() -> String {
        [
            "From: me <me@example.com>",
            "To: ada@example.com",
            "Subject: Re: The plan",
            "Date: Sat, 17 Oct 2026 09:00:00 GMT",
            "Message-ID: <winnow-abc@winnow.app>",
            "In-Reply-To: <orig@mail.example.com>",
            "References: <first@mail.example.com> <orig@mail.example.com>",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: base64",
        ]
        .join("\r\n")
            + "\r\n\r\n"
    }

    fn request(action: &str, reply: Option<&str>) -> ActionRequest {
        ActionRequest {
            request_id: "r1".into(),
            action: action.into(),
            notification_id: 7,
            message_id: 42,
            gmail_id: "18c0ffee".into(),
            thread_id: Some("18c0ff00".into()),
            reply_head: Some(head()),
            reply: reply.map(str::to_string),
        }
    }

    fn secrets(expires_at: i64) -> Secrets {
        Secrets {
            tokens: Some(format!(
                r#"{{"accessToken":"old","refreshToken":"rt","expiresAt":{expires_at}}}"#
            )),
            client: Some(
                r#"{"clientId":"id.apps.googleusercontent.com","clientSecret":"sec"}"#.into(),
            ),
        }
    }

    /// A transport that answers from a script and records what it was asked.
    struct Script {
        answers: Vec<HttpResponse>,
        seen: Vec<HttpRequest>,
    }

    impl Script {
        fn new(answers: &[(u16, &str)]) -> Self {
            Self {
                answers: answers
                    .iter()
                    .map(|(status, body)| HttpResponse {
                        status: *status,
                        body: body.to_string(),
                    })
                    .collect(),
                seen: Vec::new(),
            }
        }
    }

    impl Transport for Script {
        fn exchange(&mut self, request: &HttpRequest) -> HttpResponse {
            self.seen.push(request.clone());
            if self.answers.is_empty() {
                panic!("unexpected request: {} {}", request.method, request.url);
            }
            self.answers.remove(0)
        }
    }

    fn bearer(request: &HttpRequest) -> &str {
        &request
            .headers
            .iter()
            .find(|(k, _)| k == "Authorization")
            .unwrap()
            .1
    }

    #[test]
    fn http_date_matches_to_utc_string() {
        assert_eq!(http_date(NOW), "Sun, 18 Oct 2026 13:53:00 GMT");
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(951_782_400_000), "Tue, 29 Feb 2000 00:00:00 GMT");
    }

    #[test]
    fn base64_wraps_like_build_mime() {
        assert_eq!(wrapped_base64("hi"), "aGk=");
        // 57 bytes → exactly 76 characters → one CRLF after it, as the JS regex does.
        let exact = "a".repeat(57);
        let out = wrapped_base64(&exact);
        assert!(out.ends_with("\r\n"));
        assert_eq!(out.len(), 78);
        let long = wrapped_base64(&"é".repeat(100));
        assert!(long.split("\r\n").all(|line| line.len() <= 76));
        let joined: String = long.split("\r\n").collect();
        assert_eq!(
            String::from_utf8(STANDARD.decode(joined).unwrap()).unwrap(),
            "é".repeat(100)
        );
    }

    #[test]
    fn assemble_keeps_threading_headers_and_dates_now() {
        let raw = assemble_reply(&head(), "Sounds good — Thursday?", NOW).unwrap();
        let (headers, body) = raw.split_once("\r\n\r\n").unwrap();
        assert!(headers.contains("In-Reply-To: <orig@mail.example.com>"));
        assert!(headers.contains("References: <first@mail.example.com> <orig@mail.example.com>"));
        assert!(headers.contains("Message-ID: <winnow-abc@winnow.app>"));
        assert!(headers.contains("Date: Sun, 18 Oct 2026 13:53:00 GMT"));
        assert!(!headers.contains("Sat, 17 Oct"));
        assert_eq!(headers.matches("Date: ").count(), 1);
        let decoded = STANDARD.decode(body.replace("\r\n", "")).unwrap();
        assert_eq!(
            String::from_utf8(decoded).unwrap(),
            "Sounds good — Thursday?"
        );
    }

    #[test]
    fn assemble_refuses_what_is_not_a_reply_head() {
        assert!(assemble_reply("To: a@b.c\r\n", "x", NOW).is_err());
        assert!(assemble_reply(&head().replace("In-Reply-To", "X-Not"), "x", NOW).is_err());
        assert!(assemble_reply(&(head() + "Ym9keQ==\r\n\r\n"), "x", NOW).is_err());
        assert!(assemble_reply(&head().replace("base64", "7bit"), "x", NOW).is_err());
    }

    #[test]
    fn reply_sends_on_the_thread_with_a_fresh_token() {
        let mut t = Script::new(&[(200, r#"{"id":"m2"}"#)]);
        let outcome = execute(
            &request("reply", Some("On my way")),
            &secrets(NOW + 3_600_000),
            NOW,
            &mut t,
        );
        assert_eq!(outcome, Outcome::Sent);
        assert_eq!(t.seen.len(), 1);
        let send = &t.seen[0];
        assert_eq!(send.url, format!("{GMAIL_API}/users/me/messages/send"));
        assert_eq!(bearer(send), "Bearer old");
        let body: serde_json::Value = serde_json::from_str(send.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["threadId"], "18c0ff00");
        let raw = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(body["raw"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert!(raw.contains("In-Reply-To: <orig@mail.example.com>"));
        let finish = finish_for(&request("reply", Some("x")), &outcome);
        assert_eq!(
            (finish.kind, finish.title.as_str(), finish.release_pending),
            ("done", "Sent", true)
        );
    }

    #[test]
    fn expired_token_is_refreshed_once_with_the_client() {
        let mut t = Script::new(&[
            (200, r#"{"access_token":"new","expires_in":3599}"#),
            (200, "{}"),
        ]);
        let outcome = execute(&request("read", None), &secrets(NOW - 1), NOW, &mut t);
        assert_eq!(outcome, Outcome::MarkedRead);
        assert_eq!(t.seen[0].url, GOOGLE_TOKEN_URL);
        let form = t.seen[0].body.as_deref().unwrap();
        assert!(form.contains("grant_type=refresh_token"));
        assert!(form.contains("refresh_token=rt"));
        assert!(form.contains("client_secret=sec"));
        assert_eq!(bearer(&t.seen[1]), "Bearer new");
        let body: serde_json::Value =
            serde_json::from_str(t.seen[1].body.as_deref().unwrap()).unwrap();
        assert_eq!(body["removeLabelIds"], serde_json::json!(["UNREAD"]));
        assert!(t.seen[1]
            .url
            .ends_with("/users/me/messages/18c0ffee/modify"));
    }

    #[test]
    fn a_401_gets_one_refresh_and_one_replay() {
        let mut t = Script::new(&[(401, ""), (200, r#"{"access_token":"new"}"#), (200, "{}")]);
        assert_eq!(
            execute(
                &request("trash", None),
                &secrets(NOW + 3_600_000),
                NOW,
                &mut t
            ),
            Outcome::Trashed
        );
        assert_eq!(t.seen.len(), 3);
        let body: serde_json::Value =
            serde_json::from_str(t.seen[2].body.as_deref().unwrap()).unwrap();
        assert_eq!(body["addLabelIds"], serde_json::json!(["TRASH"]));
        assert_eq!(body["removeLabelIds"], serde_json::json!(["INBOX"]));

        let mut again = Script::new(&[(401, ""), (200, r#"{"access_token":"new"}"#), (401, "")]);
        assert_eq!(
            execute(
                &request("trash", None),
                &secrets(NOW + 3_600_000),
                NOW,
                &mut again
            ),
            Outcome::Failed(Failure::Auth)
        );
    }

    #[test]
    fn trash_is_never_permanent_and_undo_restores_the_inbox() {
        let mut t = Script::new(&[(200, "{}")]);
        execute(
            &request("trash", None),
            &secrets(NOW + 3_600_000),
            NOW,
            &mut t,
        );
        assert!(t
            .seen
            .iter()
            .all(|r| r.method != "DELETE" && !r.url.ends_with("/delete")));
        let finish = finish_for(&request("trash", None), &Outcome::Trashed);
        assert_eq!(finish.kind, "undo");

        let mut u = Script::new(&[(200, "{}")]);
        assert_eq!(
            execute(
                &request("untrash", None),
                &secrets(NOW + 3_600_000),
                NOW,
                &mut u
            ),
            Outcome::Restored
        );
        let body: serde_json::Value =
            serde_json::from_str(u.seen[0].body.as_deref().unwrap()).unwrap();
        assert_eq!(body["addLabelIds"], serde_json::json!(["INBOX"]));
        assert_eq!(body["removeLabelIds"], serde_json::json!(["TRASH"]));
    }

    #[test]
    fn a_failed_send_becomes_a_draft_on_the_same_thread_and_is_never_resent() {
        let mut t = Script::new(&[(0, ""), (200, r#"{"id":"d1"}"#)]);
        let outcome = execute(
            &request("reply", Some("hello")),
            &secrets(NOW + 3_600_000),
            NOW,
            &mut t,
        );
        assert_eq!(outcome, Outcome::SavedAsDraft(Failure::Offline));
        assert_eq!(t.seen.len(), 2);
        assert!(t.seen[1].url.ends_with("/users/me/drafts"));
        let body: serde_json::Value =
            serde_json::from_str(t.seen[1].body.as_deref().unwrap()).unwrap();
        assert_eq!(body["message"]["threadId"], "18c0ff00");
        let finish = finish_for(&request("reply", Some("hello")), &outcome);
        assert_eq!(finish.title, COULD_NOT_SEND);
        assert!(
            finish.release_pending,
            "a reply in Drafts can leave the device"
        );
    }

    #[test]
    fn a_reply_that_cannot_reach_gmail_at_all_stays_on_the_device() {
        let mut t = Script::new(&[(0, ""), (0, "")]);
        let outcome = execute(
            &request("reply", Some("hello")),
            &secrets(NOW + 3_600_000),
            NOW,
            &mut t,
        );
        assert_eq!(outcome, Outcome::KeptOnDevice(Failure::Offline));
        let finish = finish_for(&request("reply", Some("hello")), &outcome);
        assert_eq!(finish.title, COULD_NOT_SEND);
        assert!(!finish.release_pending);
    }

    #[test]
    fn signed_out_or_revoked_keeps_the_reply() {
        let mut none = Script::new(&[]);
        let outcome = execute(
            &request("reply", Some("hi")),
            &Secrets::default(),
            NOW,
            &mut none,
        );
        assert_eq!(outcome, Outcome::KeptOnDevice(Failure::Auth));
        assert!(none.seen.is_empty());

        let mut revoked = Script::new(&[(400, r#"{"error":"invalid_grant"}"#)]);
        let outcome = execute(
            &request("reply", Some("hi")),
            &secrets(NOW - 1),
            NOW,
            &mut revoked,
        );
        assert_eq!(outcome, Outcome::KeptOnDevice(Failure::Auth));
    }

    #[test]
    fn empty_replies_and_bad_ids_send_nothing() {
        let mut t = Script::new(&[]);
        assert_eq!(
            execute(
                &request("reply", Some("  \n")),
                &secrets(NOW + 1_000_000),
                NOW,
                &mut t
            ),
            Outcome::EmptyReply
        );
        let mut bad = request("trash", None);
        bad.gmail_id = "../../drafts".into();
        assert_eq!(
            execute(&bad, &secrets(NOW + 1_000_000), NOW, &mut t),
            Outcome::Failed(Failure::Invalid)
        );
        assert_eq!(
            execute(
                &request("archive", None),
                &secrets(NOW + 1_000_000),
                NOW,
                &mut t
            ),
            Outcome::Failed(Failure::Invalid)
        );
        assert!(t.seen.is_empty());
    }

    #[test]
    fn request_parses_the_kotlin_payload() {
        let json = r#"{"requestId":"a","action":"reply","notificationId":-5,"messageId":9007199254740991,
            "gmailId":"abc","threadId":"def","replyHead":"h","reply":"yo"}"#;
        let parsed: ActionRequest = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.notification_id, -5);
        assert_eq!(parsed.parse_action(), Some(Action::Reply("yo".into())));
    }
}
