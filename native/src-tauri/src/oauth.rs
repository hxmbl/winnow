//! The OAuth loopback listener.
//!
//! Google only hands a desktop-style authorization code back to a redirect URI
//! it can reach. On the desktop the only address the OS will let us bind is
//! `127.0.0.1`, so Winnow spins up a throwaway HTTP server on an ephemeral
//! port, points the browser at it, and waits for the redirect to arrive.
//!
//! This is the one part of sign-in that a *browser-hosted* Winnow cannot
//! replicate, which is why the authorization step has two shapes:
//!
//! * **Desktop** — this module. Full installed-app PKCE, no client secret.
//! * **Web** — `web/src/platform/oauth.ts` sends the user to the same authorize
//!   URL with a redirect URI the developer registered for the site, and the
//!   code comes back through a normal page load.
//!
//! PKCE itself is shared: `web/src/core/gmail/pkce.ts` generates the verifier
//! and challenge, and only the challenge ever leaves this machine until the
//! token exchange.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// The token the TypeScript layer puts where the loopback port belongs.
///
/// The authorize URL is built in `web/src/core/gmail/pkce.ts` so all the OAuth
/// URL logic stays in one place, but the *port* is not knowable there — the OS
/// picks it when the listener binds. So the web layer writes this placeholder
/// and Rust substitutes the port it actually got.
///
/// Two properties come from that arrangement, and both matter more than saving
/// a round trip:
///
///   - The two cannot disagree. There is no window in which the URL names one
///     port and the listener is on another — the failure that would otherwise
///     send Google to a dead port and hang until the five-minute timeout.
///   - A missing placeholder is a loud error, because [`begin`] refuses a URL
///     that does not contain it.
pub const PORT_PLACEHOLDER: &str = "__WINNOW_LOOPBACK_PORT__";

/// What the redirect carried. `Err` is Google's own error parameter, which the
/// user-facing layer renders verbatim ("access_denied" reads as "you said no").
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthOutcome {
    Code {
        code: String,
        state: String,
    },
    Error {
        error: String,
        description: String,
        state: String,
    },
}

/// State shared between the command layer and the listener thread.
///
/// `receiver` is an `Option` because exactly one waiter may take it, and "taken
/// already" has to be representable: the session stays registered while the wait
/// is in flight — otherwise `oauth_cancel` has nothing to find and Cancel cannot
/// work — but the outcome can only be delivered once. See `take_receiver`.
pub struct AuthSession {
    pub port: u16,
    /// The authorize URL with the real port already substituted.
    pub auth_url: String,
    pub cancel: Arc<AtomicBool>,
    receiver: Option<oneshot::Receiver<AuthOutcome>>,
}

impl AuthSession {
    pub fn abort(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Take the one-shot receiver, or `None` if a waiter already has it.
    ///
    /// Public so the command layer can claim the outcome while leaving the session
    /// itself registered. The alternative — removing the whole session from the map
    /// to get at the receiver — is what made `oauth_cancel` a no-op, because by the
    /// time the UI could offer a Cancel button the entry was already gone.
    pub fn take_receiver(&mut self) -> Option<oneshot::Receiver<AuthOutcome>> {
        self.receiver.take()
    }
}

/// Live sessions, keyed by loopback port so a stale `await` cannot be matched
/// against a sign-in that has since been restarted.
#[derive(Default)]
pub struct Sessions(pub Mutex<HashMap<u16, AuthSession>>);

/// How long a listener lives with nobody collecting its outcome.
///
/// `oauth_await` has its own (shorter) timeout and stops the listener when it ends;
/// this is only the backstop for a listener whose waiter never came, so a crashed
/// page cannot leave a thread holding a port for the life of the app.
pub const MAX_LISTENER_LIFETIME: Duration = Duration::from_secs(15 * 60);

/// How often the listener notes in the debug log that it is still waiting.
const HEARTBEAT: Duration = Duration::from_secs(15);

/// A gap between two polls longer than this means the thread did not run at all —
/// on Android, the process was frozen behind the browser. Logged, because it is the
/// one piece of evidence that explains "127.0.0.1 took too long to respond".
const STALL: Duration = Duration::from_secs(3);

/// Where Google will send the browser back to, read from the authorize URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedirectTarget {
    /// `127.0.0.1`, `localhost` or `[::1]`, as written in the URI.
    pub host: String,
    /// The path the callback arrives on (`/winnow-oauth`).
    pub path: String,
}

/// Read `redirect_uri` out of an authorize URL that still has [`PORT_PLACEHOLDER`]
/// in it. `None` when there is no readable loopback redirect URI.
pub fn redirect_target(authorize_url: &str) -> Option<RedirectTarget> {
    let url = url::Url::parse(authorize_url).ok()?;
    let redirect = url
        .query_pairs()
        .find(|(key, _)| key == "redirect_uri")
        .map(|(_, value)| value.into_owned())?;
    // The placeholder is not a port `Url` will parse; any number stands in for it.
    let redirect = url::Url::parse(&redirect.replace(PORT_PLACEHOLDER, "1")).ok()?;
    if redirect.scheme() != "http" {
        return None;
    }
    let host = match redirect.host()? {
        url::Host::Ipv6(ip) => format!("[{ip}]"),
        other => other.to_string(),
    };
    Some(RedirectTarget {
        host,
        path: redirect.path().to_string(),
    })
}

/// The address to listen on for a redirect host.
///
/// It has to be the address the browser will connect to. `127.0.0.1` and `[::1]` are
/// literal; `localhost` is resolved by the browser, usually to `127.0.0.1` but on some
/// systems to `::1` first, which is why Winnow's own redirect URI names `127.0.0.1`
/// (and why Google recommends the literal for desktop clients). A `localhost` redirect
/// still gets `127.0.0.1`, which is what every browser falls back to.
fn bind_addr(host: &str) -> std::net::IpAddr {
    if host == "[::1]" {
        std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
    } else {
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
    }
}

/// Start a listener, and return the session the webview will drive.
///
/// `authorize_url` comes from the TypeScript layer with [`PORT_PLACEHOLDER`] in
/// place of the loopback port; it is substituted here, once the port is known.
pub fn begin(authorize_url: String) -> Result<AuthSession, String> {
    begin_with(authorize_url, MAX_LISTENER_LIFETIME)
}

/// [`begin`] with the listener's lifetime as a parameter, for tests.
pub fn begin_with(authorize_url: String, lifetime: Duration) -> Result<AuthSession, String> {
    if !authorize_url.contains(PORT_PLACEHOLDER) {
        // Refusing is the point. Substituting nothing would produce a URL whose
        // `redirect_uri` names a port we are not listening on, and the sign-in
        // would then hang until the timeout and blame the user's network.
        crate::dlog!("auth", "listener-refused", reason = "no-port-placeholder");
        return Err(format!(
            "the authorize URL must contain {PORT_PLACEHOLDER} where the loopback port goes"
        ));
    }

    let target = redirect_target(&authorize_url);
    let host = target
        .as_ref()
        .map_or_else(|| "127.0.0.1".to_string(), |t| t.host.clone());
    // `None` only for a URL whose redirect could not be read; then any path may carry
    // the callback, which is how the listener behaved before it knew the path.
    let callback_path = target.as_ref().map(|t| t.path.clone());

    let ip = bind_addr(&host);
    let listener = std::net::TcpListener::bind((ip, 0)).map_err(|e| {
        crate::dlog!("auth", "listener-bind-failed", ip = ip, error = e.kind());
        format!("could not open a loopback port: {e}")
    })?;
    let local = listener
        .local_addr()
        .map_err(|e| format!("could not read the loopback address: {e}"))?;
    let port = local.port();

    let authorize_url = authorize_url.replace(PORT_PLACEHOLDER, &port.to_string());
    crate::dlog!(
        "auth",
        "listener-bound",
        addr = local,
        redirect_host = host,
        redirect_path = callback_path.as_deref().unwrap_or("(any)"),
        lifetime_s = lifetime.as_secs(),
    );
    if host == "localhost" {
        crate::dlog!(
            "auth",
            "listener-warning",
            reason = "redirect-names-localhost"
        );
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = oneshot::channel::<AuthOutcome>();

    let thread_cancel = Arc::clone(&cancel);
    let config = ServeConfig {
        base: format!("http://127.0.0.1:{port}/"),
        callback_path,
        lifetime,
    };
    std::thread::Builder::new()
        .name("winnow-oauth".into())
        .spawn(move || serve(listener, config, tx, thread_cancel))
        .map_err(|e| format!("could not start the loopback listener: {e}"))?;

    Ok(AuthSession {
        port,
        auth_url: authorize_url,
        cancel,
        receiver: Some(rx),
    })
}

/// The page shown in the browser once the code has been captured. It has to be
/// self-contained: the loopback server has no access to the app's assets.
const SUCCESS_PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Signed in to Winnow</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
         background:#EFF3F3; color:#15181D; }
  .card { background:#fff; border-radius:14px; padding:32px 36px; max-width:26rem;
          box-shadow:0 12px 32px rgba(15,23,42,.10), 0 2px 6px rgba(15,23,42,.04); }
  h1 { margin:0 0 8px; font-size:20px; font-weight:600; }
  p  { margin:0; color:#3C434C; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size:13px; }
  .back { display:inline-block; margin-top:20px; padding:10px 18px; border-radius:6px;
          background:#5028E2; color:#fff; font-weight:600; text-decoration:none; }
  /* The colours above are Winnow's light palette, hardcoded, so `color-scheme`
     alone left a white card on a dark browser — which is what this tab looks like
     for the second or two the user spends reading it. These are the dark palette's
     own values, so the page matches the app it just signed you in to. */
  @media (prefers-color-scheme: dark) {
    body { background:#0F1317; color:#E8EDF2; }
    .card { background:#1B2027;
            box-shadow:0 12px 32px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.30); }
    p { color:#9FA8B1; }
    .back { background:#B9A5FF; color:#070612; }
  }
</style></head>
<body><div class="card">
  <h1>Signed in to Winnow</h1>
  {RETURN}
</div></body></html>"#;

/// Where the success page points the user next.
///
/// On Android the browser is in front and Winnow's WebView is paused behind it, so
/// the page offers a button back into the app: a `winnow://` link, which the
/// manifest's `VIEW` intent filter routes to the (single-task) activity, bringing it
/// forward. The web layer waits for that before it exchanges the code. Elsewhere
/// the app's window was never paused, and the tab can simply be closed.
const RETURN_DESKTOP: &str = "<p>You can close this tab and go back to the app.</p>";
const RETURN_ANDROID: &str = "<p>Go back to Winnow to finish signing in.</p>\n  \
    <a class=\"back\" href=\"winnow://signed-in\">Back to Winnow</a>";

/// The success page for this platform (see [`RETURN_ANDROID`]).
fn success_page(android: bool) -> String {
    let next = if android {
        RETURN_ANDROID
    } else {
        RETURN_DESKTOP
    };
    SUCCESS_PAGE.replace("{RETURN}", next)
}

const ERROR_PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Winnow could not sign you in</title>
<style>
  :root { color-scheme: light dark; }
  /* `display:grid; place-items:center` — the grid was missing here, so
     `display-items` was a no-op and the card sat in the top-left corner of the
     page while the success page beside it was centred. */
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
         background:#EFF3F3; color:#15181D; }
  .card { background:#fff; border-radius:14px; padding:32px 36px; max-width:30rem;
          box-shadow:0 12px 32px rgba(15,23,42,.10), 0 2px 6px rgba(15,23,42,.04); }
  h1 { margin:0 0 8px; font-size:20px; font-weight:600; }
  p  { margin:0 0 8px; color:#3C434C; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size:13px;
         color:#C2410C; }
  /* As on the success page: the palette above is Winnow's light one, so without
     this the failure page was the one bright surface in a dark browser — which is
     the page a user is most likely to be staring at, because they are stuck. */
  @media (prefers-color-scheme: dark) {
    body { background:#0F1317; color:#E8EDF2; }
    .card { background:#1B2027;
            box-shadow:0 12px 32px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.30); }
    p { color:#9FA8B1; }
    code { color:#FACC15; }
  }
</style></head>
<body><div class="card">
  <h1>Winnow could not sign you in</h1>
  <p>Google said: <code>{ERROR}</code></p>
  <p>{DETAIL}</p>
</div></body></html>"#;

/// Answer a request the listener could not understand, then keep waiting.
///
/// The point is that it answers. Every other path in `serve` either completes the
/// sign-in or answers 204 and loops; a request whose target would not parse used
/// to `continue` with the `Request` dropped un-answered, leaving the browser
/// waiting on a socket that had accepted the connection and then said nothing.
/// That presents as a tab that hangs on Google's "Completing sign-in" spinner,
/// which is indistinguishable from the network being down.
fn answer_bad_request(request: tiny_http::Request) {
    let _ = request.respond(
        tiny_http::Response::from_string("Bad request")
            .with_status_code(400)
            .with_header(
                tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"text/plain; charset=utf-8"[..],
                )
                .unwrap(),
            ),
    );
}

/// Escape text for interpolation into the loopback error page.
///
/// The value is Google's `error_description`, which arrives as a query parameter
/// on a request anyone on the machine could have made. It is rendered into a page
/// served from `127.0.0.1`, so without this a crafted redirect could inject markup
/// — or, more usefully to an attacker, a convincing fake of this page. The length
/// cap keeps it from filling the viewport either.
fn escape_html(value: &str) -> String {
    const MAX: usize = 300;

    let mut out = String::with_capacity(value.len().min(MAX));
    for ch in value.chars().take(MAX) {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    if value.chars().count() > MAX {
        out.push('…');
    }
    out
}

/// What `serve` needs besides the socket.
struct ServeConfig {
    /// `http://127.0.0.1:<port>/`, for resolving origin-form request targets.
    base: String,
    /// The path the callback arrives on; `None` accepts it on any path.
    callback_path: Option<String>,
    /// Stop after this long even if nobody cancelled (see [`MAX_LISTENER_LIFETIME`]).
    lifetime: Duration,
}

/// Resolve a request target against the listener's base URL. `None` when it will
/// not parse.
fn parse_target(target: &str, base: &str) -> Option<url::Url> {
    // Split the request target into path and query *before* handing anything to
    // `Url`. An earlier version folded the whole target — query string and all —
    // into `set_path`, so `query_pairs()` was always empty and the listener never
    // once read a `code`: it answered 204s until the timeout blamed the network.
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target, None),
    };
    if path.starts_with("http://") || path.starts_with("https://") {
        // Absolute-form request target (RFC 7230 §5.3.2): parse it whole rather than
        // grafting it onto the base.
        return url::Url::parse(target).ok();
    }
    let normalised = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let mut url = url::Url::parse(base).ok()?;
    url.set_path(&normalised);
    url.set_query(query);
    Some(url)
}

/// The names of the query parameters, for the debug log: never their values. Names
/// outside the OAuth set are counted, not listed, since a stray request can put
/// anything there.
fn query_keys(url: &url::Url) -> String {
    const KNOWN: [&str; 8] = [
        "code",
        "state",
        "error",
        "error_description",
        "scope",
        "authuser",
        "prompt",
        "hd",
    ];
    let mut known = Vec::new();
    let mut other = 0usize;
    for (key, _) in url.query_pairs() {
        match KNOWN.iter().find(|k| **k == key) {
            Some(k) if !known.contains(k) => known.push(*k),
            Some(_) => {}
            None => other += 1,
        }
    }
    let mut out = known.join(",");
    if other > 0 {
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(&format!("+{other}"));
    }
    if out.is_empty() {
        out.push_str("(none)");
    }
    out
}

/// A path as the debug log may show it: at most 64 characters.
fn path_for_log(path: &str) -> String {
    if path.chars().count() > 64 {
        let mut short: String = path.chars().take(64).collect();
        short.push('…');
        short
    } else {
        path.to_string()
    }
}

/// What the redirect carried, or `None` when the request has neither a code nor an
/// error (a prefetch, a reload of the bare path).
fn read_outcome(url: &url::Url) -> Option<AuthOutcome> {
    // Read the query *once*: a second walk is a second chance to disagree.
    let mut code = None;
    let mut error = None;
    let mut description = None;
    let mut state = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = value.into_owned(),
            "error" => error = Some(value.into_owned()),
            "error_description" => description = Some(value.into_owned()),
            _ => {}
        }
    }
    match (code, error) {
        (Some(code), _) => Some(AuthOutcome::Code { code, state }),
        (None, Some(error)) => Some(AuthOutcome::Error {
            description: description.unwrap_or_else(|| error.clone()),
            error,
            state,
        }),
        _ => None,
    }
}

/// Answer with a short plain-text body. Every request gets an answer: a socket that
/// accepts and then says nothing is what a browser reports as "took too long".
fn answer_text(request: tiny_http::Request, status: u16, body: &str) -> std::io::Result<()> {
    request.respond(
        tiny_http::Response::from_string(body)
            .with_status_code(status)
            .with_header(
                tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"text/plain; charset=utf-8"[..],
                )
                .unwrap(),
            )
            .with_header(
                tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap(),
            ),
    )
}

/// The body for a callback-path request that carries no answer yet.
const WAITING_TEXT: &str =
    "Winnow is waiting for Google to send you back here. Finish signing in at Google.";

/// Serve until the redirect arrives, the user cancels, or the lifetime runs out.
///
/// The listener stays up and answering the whole time: every request gets a reply,
/// and only a GET on the callback path that carries a `code` or an `error` ends it.
/// A favicon probe, a prefetch of the bare callback path, a HEAD, or a request on any
/// other path is answered and the wait goes on, so nothing can use up "the" request
/// before Google's redirect arrives.
fn serve(
    listener: std::net::TcpListener,
    config: ServeConfig,
    tx: oneshot::Sender<AuthOutcome>,
    cancel: Arc<AtomicBool>,
) {
    let server = match tiny_http::Server::from_listener(listener, None) {
        Ok(server) => server,
        Err(_) => {
            crate::dlog!("auth", "listener-start-failed");
            let _ = tx.send(AuthOutcome::Error {
                error: "loopback_failed".into(),
                description: "The local sign-in listener could not start.".into(),
                state: String::new(),
            });
            return;
        }
    };
    crate::dlog!("auth", "listener-waiting");

    let started = Instant::now();
    let mut last_poll = started;
    let mut last_beat = started;
    let mut requests = 0u32;
    let mut tx = Some(tx);

    let reason = loop {
        if cancel.load(Ordering::SeqCst) {
            break "cancelled";
        }
        if started.elapsed() >= config.lifetime {
            break "expired";
        }

        let now = Instant::now();
        let gap = now.duration_since(last_poll);
        if gap >= STALL {
            // The poll below returns every 250 ms, so a gap this long means the thread
            // was not scheduled at all: on Android, the app was frozen in the
            // background. Any connection made meanwhile sat unanswered in the queue.
            crate::dlog!(
                "auth",
                "listener-stalled",
                gap_ms = gap.as_millis(),
                waited_s = started.elapsed().as_secs(),
            );
        }
        last_poll = now;
        if now.duration_since(last_beat) >= HEARTBEAT {
            crate::dlog!(
                "auth",
                "listener-heartbeat",
                waited_s = started.elapsed().as_secs(),
                requests = requests,
            );
            last_beat = now;
        }

        let request = match server.recv_timeout(Duration::from_millis(250)) {
            Ok(Some(request)) => request,
            Ok(None) => continue,
            Err(e) => {
                crate::dlog!("auth", "listener-accept-failed", error = e.kind());
                break "accept-error";
            }
        };
        requests += 1;
        let method = request.method().clone();

        let Some(url) = parse_target(request.url(), &config.base) else {
            crate::dlog!(
                "auth",
                "listener-request",
                n = requests,
                method = method,
                path = "(unparseable)",
            );
            answer_bad_request(request);
            continue;
        };
        let path = url.path().to_string();
        crate::dlog!(
            "auth",
            "listener-request",
            n = requests,
            method = method,
            path = path_for_log(&path),
            query = query_keys(&url),
        );

        let on_callback = config
            .callback_path
            .as_deref()
            .map_or(true, |callback| callback == path);
        if !on_callback {
            let sent = answer_text(request, 404, "Not found");
            crate::dlog!(
                "auth",
                "listener-answered",
                n = requests,
                status = 404,
                ok = sent.is_ok(),
            );
            continue;
        }
        if method != tiny_http::Method::Get {
            // A HEAD or a preflight must not consume the code: only the browser's
            // own navigation (a GET) completes the sign-in.
            let sent = answer_text(request, 405, "Method not allowed");
            crate::dlog!(
                "auth",
                "listener-answered",
                n = requests,
                status = 405,
                ok = sent.is_ok(),
            );
            continue;
        }

        let Some(outcome) = read_outcome(&url) else {
            let sent = answer_text(request, 400, WAITING_TEXT);
            crate::dlog!(
                "auth",
                "listener-answered",
                n = requests,
                status = 400,
                reason = "no-code-or-error",
                ok = sent.is_ok(),
            );
            continue;
        };

        let (status, body, kind) = match &outcome {
            AuthOutcome::Code { .. } => (200, success_page(cfg!(target_os = "android")), "code"),
            AuthOutcome::Error {
                error, description, ..
            } => (
                400,
                ERROR_PAGE
                    // Google's own error code: short, and from a fixed vocabulary,
                    // but escaped all the same.
                    .replace("{ERROR}", &escape_html(error))
                    // Google's `error_description` is prose written for a person. It
                    // is also attacker-influenceable, so it is escaped and truncated:
                    // a hostile redirect must not inject markup into a page served
                    // from `127.0.0.1`.
                    .replace("{DETAIL}", &escape_html(description)),
                "error",
            ),
        };
        let sent = request.respond(
            tiny_http::Response::from_string(body)
                .with_status_code(status)
                .with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"text/html; charset=utf-8"[..],
                    )
                    .unwrap(),
                )
                .with_header(
                    tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap(),
                ),
        );
        crate::dlog!(
            "auth",
            "listener-callback",
            n = requests,
            outcome = kind,
            status = status,
            page_sent = sent.is_ok(),
            waited_s = started.elapsed().as_secs(),
        );

        // The outcome counts whether or not the page reached the browser: the code is
        // what the app needs, and the browser may have gone away after sending it.
        let delivered = tx.take().map(|tx| tx.send(outcome).is_ok());
        crate::dlog!(
            "auth",
            "listener-delivered",
            to_app = delivered.unwrap_or(false),
        );
        break "answered";
    };

    crate::dlog!(
        "auth",
        "listener-closed",
        reason = reason,
        requests = requests,
        waited_s = started.elapsed().as_secs(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A representative authorize URL, as `web/src/core/gmail/pkce.ts` builds
    /// it: the loopback port is a placeholder Rust has to fill in.
    const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth\
        ?response_type=code&client_id=abc&scope=mail\
        &redirect_uri=http%3A%2F%2F127.0.0.1%3A__WINNOW_LOOPBACK_PORT__%2Fwinnow-oauth\
        &code_challenge=xyz&code_challenge_method=S256&state=s1";

    #[test]
    fn begin_substitutes_the_real_port_into_the_redirect_uri() {
        // The whole reason the placeholder exists: Google redirects to whatever
        // `redirect_uri` says, so it has to name the port the listener is on.
        let session = begin(AUTH_URL.into()).expect("loopback should bind");
        assert_ne!(session.port, 0);

        let encoded = format!("127.0.0.1%3A{}", session.port);
        assert!(
            session.auth_url.contains(&encoded),
            "expected the encoded redirect to name port {}, got {}",
            session.port,
            session.auth_url
        );
        assert!(!session.auth_url.contains(PORT_PLACEHOLDER));
        session.abort();
    }

    #[test]
    fn a_url_without_the_placeholder_is_refused() {
        // Silently substituting nothing would produce a redirect_uri pointing at
        // a port nothing is listening on, and the user would watch it hang for
        // five minutes before being told to check their network.
        //
        // Matched rather than `expect_err`, because `AuthSession` holds a
        // `oneshot::Receiver` and deliberately has no `Debug`: there is nothing
        // about an in-flight sign-in worth printing.
        let Err(error) =
            begin("https://example.invalid/auth?redirect_uri=http://127.0.0.1/".into())
        else {
            panic!("a URL with no port placeholder must be refused");
        };
        assert!(error.contains(PORT_PLACEHOLDER), "unhelpful error: {error}");
    }

    #[test]
    fn the_redirect_is_captured_and_answered() {
        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        // Play the browser: issue the redirect the way Google would.
        let redirect = std::thread::spawn(move || {
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(20));
                if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                    use std::io::Write;
                    let _ = stream.write_all(
                        b"GET /winnow-oauth?state=xyz&code=abc123 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                    );
                    let mut response = String::new();
                    use std::io::Read;
                    let _ = stream.read_to_string(&mut response);
                    return response;
                }
            }
            String::new()
        });

        let outcome = block_on(session.take_receiver().unwrap())
            .expect("the listener should have sent exactly one outcome");
        let body = redirect.join().unwrap();

        match outcome {
            AuthOutcome::Code { code, state } => {
                assert_eq!(code, "abc123");
                assert_eq!(state, "xyz");
            }
            other => panic!("expected a code, got {other:?}"),
        }
        assert!(
            body.contains("200 OK"),
            "expected an HTML response, got: {body}"
        );
        assert!(body.contains("Signed in to Winnow"));
    }

    #[test]
    fn google_errors_are_passed_through() {
        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        std::thread::spawn(move || {
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(20));
                if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                    use std::io::Write;
                    let _ = stream.write_all(
                        b"GET /winnow-oauth?error=access_denied&error_description=User+said+no HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                    );
                    return;
                }
            }
        });

        match block_on(session.take_receiver().unwrap()).expect("an error should have been sent") {
            AuthOutcome::Error {
                error, description, ..
            } => {
                assert_eq!(error, "access_denied");
                assert_eq!(description, "User said no");
            }
            other => panic!("expected an error, got {other:?}"),
        }
    }

    /// A minimal executor so the tests do not need a full Tokio runtime.
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn unrelated_requests_do_not_end_the_flow() {
        let session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        let probe = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                use std::io::Write;
                let _ = stream.write_all(
                    b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                );
            }
        });

        // Give the probe time to land, then check the session is still live.
        probe.join().unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            !session.cancel.load(Ordering::SeqCst),
            "a stray request must not cancel the sign-in"
        );
        session.abort();
    }

    /// Split a request target the way the listener has to.
    ///
    /// Factored out because this is where the bug lived: folding the whole
    /// target into `Url::set_path` — query string included — produces a URL whose
    /// `query_pairs()` is empty, so the listener answers 204s forever and never
    /// sees a code. The transport tests above still passed against that version,
    /// because they checked that a request was *answered* and not that anything
    /// was *understood*.
    fn split_target(target: &str) -> (&str, Option<&str>) {
        match target.split_once('?') {
            Some((path, query)) => (path, Some(query)),
            None => (target, None),
        }
    }

    #[test]
    fn the_query_is_never_treated_as_part_of_the_path() {
        let (path, query) = split_target("/winnow-oauth?code=abc123&state=xyz");
        assert_eq!(path, "/winnow-oauth");
        assert_eq!(query, Some("code=abc123&state=xyz"));

        let url = url::Url::parse("http://127.0.0.1:8080/")
            .unwrap()
            .join(path)
            .unwrap();
        // The regression itself: a path carrying `?` would parse, and would
        // silently yield no query at all.
        assert_eq!(url.path(), "/winnow-oauth");
        assert_eq!(url.query(), None);
    }

    #[test]
    fn a_target_with_no_query_is_still_usable() {
        let (path, query) = split_target("/favicon.ico");
        assert_eq!(path, "/favicon.ico");
        assert_eq!(query, None);
    }

    /// Drive a real request through `serve` and hand back the raw response.
    ///
    /// The helper the four tests below share. It is a *transport* test: it proves
    /// the listener answered, which is the weaker half of what the redirect tests
    /// above assert. Each of them also checks the body or the outcome, because
    /// "a request was answered" is exactly the property that held while the query
    /// string was folded into `set_path` and no code was ever read.
    fn request_once(port: u16, target: String) -> String {
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(20));
            if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                use std::io::{Read, Write};
                let request = format!(
                    "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
                );
                if stream.write_all(request.as_bytes()).is_err() {
                    return String::new();
                }
                let mut response = String::new();
                let _ = stream.read_to_string(&mut response);
                return response;
            }
        }
        String::new()
    }

    #[test]
    fn the_redirect_path_is_the_registered_one_not_just_the_root() {
        // Google redirects to whatever `redirect_uri` names, and Winnow registers
        // `/winnow-oauth`. So the callback arrives on that path with the code in
        // the query — the combination that has to survive the parse. Asserted
        // end-to-end because the transport working and the *path* working are
        // separate facts, and only the second one means sign-in works.
        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        // The request runs on its own thread because the listener only sends once it
        // has received something; awaiting the receiver first would deadlock against
        // a test that can only pass by making the request.
        let browser = std::thread::spawn(move || {
            request_once(port, "/winnow-oauth?state=s1&code=the-real-code".into())
        });

        let outcome =
            block_on(session.take_receiver().unwrap()).expect("an outcome should have been sent");
        let body = browser.join().unwrap();

        match outcome {
            AuthOutcome::Code { code, state } => {
                assert_eq!(
                    code, "the-real-code",
                    "the code must survive the path split"
                );
                assert_eq!(state, "s1");
            }
            other => panic!("expected a code, got {other:?}"),
        }
        assert!(body.contains("Signed in to Winnow"), "body was: {body}");
    }

    #[test]
    fn a_percent_encoded_code_is_decoded_before_the_exchange() {
        // Google percent-encodes the authorization code. A `+`-containing code is
        // the case that matters: `query_pairs` decodes `+` as a space, which is
        // correct for form encoding and is what Google emits, so the assertion
        // pins that the decoding path is the one actually in use.
        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        let browser = std::thread::spawn(move || {
            request_once(port, "/winnow-oauth?state=s&code=a%2Bb%2Fc".into())
        });

        match block_on(session.take_receiver().unwrap()).expect("an outcome should have been sent")
        {
            AuthOutcome::Code { code, .. } => assert_eq!(code, "a+b/c"),
            other => panic!("expected a code, got {other:?}"),
        }
        let _ = browser.join();
    }

    #[test]
    fn a_malformed_target_is_answered_rather_than_dropped() {
        // The bug: an unparseable request target hit a bare `continue`, so the
        // `Request` was dropped without being answered. The browser waited on a
        // socket that had accepted and then gone silent — indistinguishable from
        // the network being down.
        let session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        // A target containing raw control characters cannot be a valid URL, and
        // `tiny_http` will hand it through verbatim.
        let probe = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                use std::io::{Read, Write};
                let _ = stream.write_all(
                    b"GET /%zz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                );
                let mut response = String::new();
                let _ = stream.read_to_string(&mut response);
                return response;
            }
            String::new()
        });

        let body = probe.join().unwrap();
        // Either it parsed and was answered as an unrelated request (204), or it
        // did not and was answered as a bad request (400). Both are answers.
        // What is asserted is that it is one: a non-empty response.
        assert!(
            !body.is_empty(),
            "an unparseable target must still be answered, got nothing"
        );

        // And the sign-in is still alive afterwards.
        std::thread::sleep(Duration::from_millis(100));
        assert!(!session.cancel.load(Ordering::SeqCst));
        session.abort();
    }

    #[test]
    fn the_success_page_links_back_into_the_app_on_android_only() {
        let android = success_page(true);
        assert!(android.contains(r#"href="winnow://signed-in""#));
        assert!(!android.contains("{RETURN}"));

        let desktop = success_page(false);
        assert!(!desktop.contains("winnow://"));
        assert!(desktop.contains("close this tab"));
        assert!(!desktop.contains("{RETURN}"));
    }

    #[test]
    fn the_error_page_shows_the_description_escaped() {
        // Two properties at once, because they are the same line of code: Google's
        // prose reaches the page (it was parsed and thrown away before), and it is
        // escaped on the way (the value comes off the query string of a request
        // anyone on the machine could make).
        assert_eq!(escape_html("User said no"), "User said no");
        assert_eq!(
            escape_html("<script>alert(1)</script>"),
            "&lt;script&gt;alert(1)&lt;/script&gt;"
        );
        assert_eq!(escape_html("a & b"), "a &amp; b");
        assert!(escape_html(&"x".repeat(500)).ends_with('…'));

        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        let browser = std::thread::spawn(move || {
            request_once(
                port,
                "/winnow-oauth?state=s&error=access_denied&error_description=User+said+no"
                    .to_string(),
            )
        });

        let outcome =
            block_on(session.take_receiver().unwrap()).expect("an outcome should have been sent");
        let body = browser.join().unwrap();

        match &outcome {
            AuthOutcome::Error { description, .. } => assert_eq!(description, "User said no"),
            other => panic!("expected an error, got {other:?}"),
        }
        assert!(
            body.contains("User said no"),
            "the description was parsed but never rendered: {body}"
        );
        assert!(body.contains("access_denied"));
    }
    // ── Listener robustness ───────────────────────────────────────────────────
    //
    // The Android 15 report was "127.0.0.1 took too long to respond": a socket that
    // accepted and never answered. These pin that the listener answers *everything*,
    // keeps waiting through anything that is not the real callback, and closes only
    // when it is told to.

    /// Send raw bytes on one connection and read until the server closes it.
    fn raw_exchange(port: u16, bytes: &[u8]) -> String {
        use std::io::{Read, Write};
        for _ in 0..100 {
            if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream.write_all(bytes).unwrap();
                let mut response = String::new();
                let _ = stream.read_to_string(&mut response);
                return response;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        String::new()
    }

    fn get(path: &str) -> Vec<u8> {
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").into_bytes()
    }

    /// The receiver's answer, or `None` if nothing came within `wait`.
    fn outcome_within(
        receiver: oneshot::Receiver<AuthOutcome>,
        wait: Duration,
    ) -> Option<Result<AuthOutcome, oneshot::error::RecvError>> {
        block_on(async { tokio::time::timeout(wait, receiver).await.ok() })
    }

    #[test]
    fn stray_requests_before_the_callback_are_answered_and_do_not_consume_it() {
        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;
        let receiver = session.take_receiver().unwrap();

        // A favicon probe, the right code on the wrong path, a prefetch of the bare
        // callback path, and a HEAD carrying the code: each answered, none final.
        let favicon = raw_exchange(port, &get("/favicon.ico"));
        assert!(favicon.starts_with("HTTP/1.1 404"), "{favicon}");
        let wrong_path = raw_exchange(port, &get("/?state=s1&code=not-here"));
        assert!(wrong_path.starts_with("HTTP/1.1 404"), "{wrong_path}");
        let bare = raw_exchange(port, &get("/winnow-oauth"));
        assert!(bare.starts_with("HTTP/1.1 400"), "{bare}");
        assert!(bare.contains("waiting for Google"), "{bare}");
        let head = raw_exchange(
            port,
            b"HEAD /winnow-oauth?state=s1&code=early HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
        assert!(head.starts_with("HTTP/1.1 405"), "{head}");
        assert!(!session.cancel.load(Ordering::SeqCst));

        // Then the real redirect still lands.
        let page = raw_exchange(port, &get("/winnow-oauth?state=s1&code=the-code"));
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        match outcome_within(receiver, Duration::from_secs(5)) {
            Some(Ok(AuthOutcome::Code { code, state })) => {
                assert_eq!(code, "the-code");
                assert_eq!(state, "s1");
            }
            _ => panic!("the callback after the strays should have been captured"),
        }
    }

    #[test]
    fn several_requests_on_one_connection_are_each_answered() {
        // Browsers reuse a keep-alive connection: the favicon probe and the redirect
        // can arrive on the same socket, one after the other.
        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;
        let receiver = session.take_receiver().unwrap();

        let browser = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let mut stream = loop {
                if let Ok(stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                    break stream;
                }
                std::thread::sleep(Duration::from_millis(20));
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .unwrap();
            let mut first = [0u8; 256];
            let n = stream.read(&mut first).unwrap_or(0);
            let first = String::from_utf8_lossy(&first[..n]).to_string();
            stream
                .write_all(&get("/winnow-oauth?state=k&code=keepalive"))
                .unwrap();
            let mut rest = String::new();
            let _ = stream.read_to_string(&mut rest);
            (first, rest)
        });

        let outcome = outcome_within(receiver, Duration::from_secs(5));
        let (first, rest) = browser.join().unwrap();
        assert!(first.starts_with("HTTP/1.1 404"), "{first}");
        assert!(rest.contains("Signed in to Winnow"), "{rest}");
        assert!(matches!(
            outcome,
            Some(Ok(AuthOutcome::Code { ref code, .. })) if code == "keepalive"
        ));
    }

    #[test]
    fn a_connection_that_never_sends_does_not_block_the_callback() {
        // Chrome opens speculative connections it may never use. One sitting idle on
        // the listener must not hold up the redirect on another.
        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;
        let receiver = session.take_receiver().unwrap();

        let _idle = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let page = raw_exchange(port, &get("/winnow-oauth?state=i&code=after-idle"));
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(matches!(
            outcome_within(receiver, Duration::from_secs(5)),
            Some(Ok(AuthOutcome::Code { ref code, .. })) if code == "after-idle"
        ));
    }

    #[test]
    fn a_late_callback_is_still_captured() {
        // The user takes their time at Google: many idle polls pass, then the
        // redirect arrives and is read like any other.
        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;
        let receiver = session.take_receiver().unwrap();

        let early = raw_exchange(port, &get("/favicon.ico"));
        assert!(early.starts_with("HTTP/1.1 404"));
        std::thread::sleep(Duration::from_millis(1_600));
        assert!(!session.cancel.load(Ordering::SeqCst));

        let page = raw_exchange(port, &get("/winnow-oauth?state=l&code=late"));
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(matches!(
            outcome_within(receiver, Duration::from_secs(5)),
            Some(Ok(AuthOutcome::Code { ref code, .. })) if code == "late"
        ));
    }

    #[test]
    fn the_listener_closes_when_cancelled_and_not_before() {
        let session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        // Still up after a stray request and a pause.
        assert!(raw_exchange(port, &get("/favicon.ico")).starts_with("HTTP/1.1 404"));
        std::thread::sleep(Duration::from_millis(300));
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());

        // Closed (refused, not hanging) soon after a cancel.
        session.abort();
        let mut refused = false;
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(50));
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
                refused = true;
                break;
            }
        }
        assert!(refused, "a cancelled listener should stop accepting");
    }

    #[test]
    fn a_listener_nobody_waits_on_expires() {
        let mut session = begin_with(AUTH_URL.into(), Duration::from_millis(300)).unwrap();
        let receiver = session.take_receiver().unwrap();
        // The sender is dropped without an outcome, which `oauth_await` reports as
        // "the sign-in listener closed before Google replied".
        assert!(matches!(
            outcome_within(receiver, Duration::from_secs(5)),
            Some(Err(_))
        ));
    }

    #[test]
    fn the_redirect_target_is_read_from_the_authorize_url() {
        assert_eq!(
            redirect_target(AUTH_URL),
            Some(RedirectTarget {
                host: "127.0.0.1".into(),
                path: "/winnow-oauth".into()
            })
        );
        let v6 = AUTH_URL.replace("127.0.0.1", "%5B%3A%3A1%5D");
        assert_eq!(
            redirect_target(&v6).map(|t| t.host),
            Some("[::1]".to_string())
        );
        assert_eq!(
            bind_addr("[::1]"),
            std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
        );
        assert_eq!(
            bind_addr("localhost"),
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        );
        assert_eq!(
            redirect_target("https://accounts.google.com/auth?x=1"),
            None
        );
    }

    #[test]
    fn query_keys_name_parameters_but_never_their_values() {
        let url = url::Url::parse(
            "http://127.0.0.1:1/winnow-oauth?state=S3CR3T&code=4%2F0Abc&scope=gmail&junk=x&more=y",
        )
        .unwrap();
        let keys = query_keys(&url);
        assert_eq!(keys, "state,code,scope,+2");
        assert!(!keys.contains("S3CR3T") && !keys.contains("0Abc"));
        let bare = url::Url::parse("http://127.0.0.1:1/favicon.ico").unwrap();
        assert_eq!(query_keys(&bare), "(none)");
    }

    #[test]
    fn the_debug_log_sees_each_request_by_path_and_never_the_code() {
        let _serial = crate::debug_log::tests::SERIAL.lock();
        crate::debug_log::drain();
        crate::debug_log::set_enabled(true);

        let mut session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;
        let receiver = session.take_receiver().unwrap();
        raw_exchange(port, &get("/favicon.ico"));
        raw_exchange(
            port,
            &get("/winnow-oauth?state=STATE-VALUE-77&code=CODE-VALUE-99"),
        );
        let _ = outcome_within(receiver, Duration::from_secs(5));
        // Let the listener write its closing line.
        std::thread::sleep(Duration::from_millis(100));
        crate::debug_log::set_enabled(false);

        let log = crate::debug_log::drain().join("\n");
        assert!(log.contains("rust:listener-bound addr=127.0.0.1:"), "{log}");
        assert!(log.contains("path=/favicon.ico"), "{log}");
        assert!(log.contains("path=/winnow-oauth query=state,code"), "{log}");
        assert!(log.contains("rust:listener-callback"), "{log}");
        assert!(
            log.contains("rust:listener-closed reason=answered"),
            "{log}"
        );
        assert!(!log.contains("CODE-VALUE-99"), "the code leaked: {log}");
        assert!(!log.contains("STATE-VALUE-77"), "the state leaked: {log}");
    }
}
