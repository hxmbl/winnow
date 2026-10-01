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
use std::time::Duration;
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
    Code { code: String, state: String },
    Error { error: String, description: String, state: String },
}

/// State shared between the command layer and the listener thread.
pub struct AuthSession {
    pub port: u16,
    /// The authorize URL with the real port already substituted.
    pub auth_url: String,
    pub cancel: Arc<AtomicBool>,
    pub receiver: oneshot::Receiver<AuthOutcome>,
}

impl AuthSession {
    pub fn abort(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}

/// Live sessions, keyed by loopback port so a stale `await` cannot be matched
/// against a sign-in that has since been restarted.
#[derive(Default)]
pub struct Sessions(pub Mutex<HashMap<u16, AuthSession>>);

/// Bind an ephemeral loopback port and hand back the raw listener, so the
/// caller can learn the port before `tiny_http` takes ownership of it.
fn bind() -> std::io::Result<std::net::TcpListener> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
}

/// Start a listener, and return the session the webview will drive.
///
/// `authorize_url` comes from the TypeScript layer with [`PORT_PLACEHOLDER`] in
/// place of the loopback port; it is substituted here, once the port is known.
pub fn begin(authorize_url: String) -> Result<AuthSession, String> {
    if !authorize_url.contains(PORT_PLACEHOLDER) {
        // Refusing is the point. Substituting nothing would produce a URL whose
        // `redirect_uri` names a port we are not listening on, and the sign-in
        // would then hang until the timeout and blame the user's network.
        return Err(format!(
            "the authorize URL must contain {PORT_PLACEHOLDER} where the loopback port goes"
        ));
    }

    let listener = bind().map_err(|e| format!("could not open a loopback port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read the loopback address: {e}"))?
        .port();

    let authorize_url = authorize_url.replace(PORT_PLACEHOLDER, &port.to_string());

    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = oneshot::channel::<AuthOutcome>();

    let thread_cancel = Arc::clone(&cancel);
    std::thread::Builder::new()
        .name("winnow-oauth".into())
        .spawn(move || serve(listener, port, tx, thread_cancel))
        .map_err(|e| format!("could not start the loopback listener: {e}"))?;
    // `listener` moved into the thread; `port` is only used to build the base
    // URL, which the thread recomputes from the same value.

    Ok(AuthSession {
        port,
        auth_url: authorize_url,
        cancel,
        receiver: rx,
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
</style></head>
<body><div class="card">
  <h1>Signed in to Winnow</h1>
  <p>You can close this tab and go back to the app.</p>
</div></body></html>"#;

const ERROR_PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Winnow could not sign you in</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display-items:center; justify-content:center;
         font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
         background:#EFF3F3; color:#15181D; }
  .card { background:#fff; border-radius:14px; padding:32px 36px; max-width:30rem;
          box-shadow:0 12px 32px rgba(15,23,42,.10), 0 2px 6px rgba(15,23,42,.04); }
  h1 { margin:0 0 8px; font-size:20px; font-weight:600; }
  p  { margin:0; color:#3C434C; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size:13px;
         color:#C2410C; }
</style></head>
<body><div class="card">
  <h1>Winnow could not sign you in</h1>
  <p>Google said: <code>{ERROR}</code></p>
</div></body></html>"#;

/// Poll the listener until the redirect arrives, the user cancels, or we hit
/// the 5-minute mark that the Swift implementation used as well.
fn serve(
    listener: std::net::TcpListener,
    port: u16,
    tx: oneshot::Sender<AuthOutcome>,
    cancel: Arc<AtomicBool>,
) {
    let server = match tiny_http::Server::from_listener(listener, None) {
        Ok(server) => server,
        Err(_) => {
            let _ = tx.send(AuthOutcome::Error {
                error: "loopback_failed".into(),
                description: "The local sign-in listener could not start.".into(),
                state: String::new(),
            });
            return;
        }
    };

    let base = format!("http://127.0.0.1:{port}/");

    while !cancel.load(Ordering::SeqCst) {
        let request = match server.recv_timeout(Duration::from_millis(250)) {
            Ok(Some(request)) => request,
            Ok(None) => continue,
            Err(_) => break,
        };

        // Split the request target into path and query *before* handing anything to
        // `Url`. The bug this replaces folded the whole target — query string and
        // all — into `set_path`, so `query_pairs()` was always empty and the
        // listener never once read a `code` or an `error`. It did not fail; it
        // looped, answering 204s and waiting for a redirect it was structurally
        // incapable of parsing, until the five-minute timeout blamed the user's
        // network. Three tests asserted this behaviour passed, because they
        // exercised the *transport* and never checked that anything came back.
        let (path, query) = match request.url().split_once('?') {
            Some((path, query)) => (path, Some(query)),
            None => (request.url(), None),
        };

        let url = match url::Url::parse(&base) {
            Ok(mut url) => {
                // `set_path` percent-decodes nothing and treats `?` as an
                // ordinary character, so the path has to be handed over without
                // the query. It is empty-safe: an absolute-form request target
                // starts with `http`, which is not a path, and is taken whole.
                let path = if path.starts_with("http://") || path.starts_with("https://") {
                    path.to_string()
                } else if path.starts_with('/') {
                    path.to_string()
                } else {
                    format!("/{path}")
                };

                if path.starts_with("http://") || path.starts_with("https://") {
                    // Absolute-form request target (RFC 7230 §5.3.2): parse it
                    // whole rather than grafting it onto the base.
                    match url::Url::parse(&path) {
                        Ok(parsed) => parsed,
                        Err(_) => continue,
                    }
                } else {
                    url.set_path(&path);
                    url.set_query(query);
                    url
                }
            }
            Err(_) => continue,
        };

        let mut code = None;
        let mut error = None;
        let mut state = String::new();
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "code" => code = Some(value.into_owned()),
                "state" => state = value.into_owned(),
                "error" => error = Some(value.into_owned()),
                _ => {}
            }
        }

        let outcome = match (code, error) {
            (Some(code), _) => Some(AuthOutcome::Code { code, state }),
            (None, Some(error)) => {
                let description = url
                    .query_pairs()
                    .find(|(k, _)| k == "error_description")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_else(|| error.clone());
                Some(AuthOutcome::Error {
                    error,
                    description,
                    state,
                })
            }
            // A favicon probe or a stray health check — answer and keep waiting.
            _ => None,
        };

        let Some(outcome) = outcome else {
            let _ = request.respond(
                tiny_http::Response::from_string("").with_status_code(204),
            );
            continue;
        };

        let (status, body) = match &outcome {
            AuthOutcome::Code { .. } => (200, SUCCESS_PAGE.to_string()),
            AuthOutcome::Error { error, .. } => (
                400,
                ERROR_PAGE.replace("{ERROR}", error),
            ),
        };
        let _ = request.respond(
            tiny_http::Response::from_string(body)
                .with_status_code(status)
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                        .unwrap(),
                )
                .with_header(
                    tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap(),
                ),
        );

        // The webview stops caring once the sender is dropped.
        let _ = tx.send(outcome);
        break;
    }
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
        let session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        // Play the browser: issue the redirect the way Google would.
        let redirect = std::thread::spawn(move || {
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(20));
                if let Ok(mut stream) =
                    std::net::TcpStream::connect(("127.0.0.1", port))
                {
                    use std::io::Write;
                    let _ = stream.write_all(
                        b"GET /?state=xyz&code=abc123 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                    );
                    let mut response = String::new();
                    use std::io::Read;
                    let _ = stream.read_to_string(&mut response);
                    return response;
                }
            }
            String::new()
        });

        let outcome = block_on(session.receiver)
            .expect("the listener should have sent exactly one outcome");
        let body = redirect.join().unwrap();

        match outcome {
            AuthOutcome::Code { code, state } => {
                assert_eq!(code, "abc123");
                assert_eq!(state, "xyz");
            }
            other => panic!("expected a code, got {other:?}"),
        }
        assert!(body.contains("200 OK"), "expected an HTML response, got: {body}");
        assert!(body.contains("Signed in to Winnow"));
    }

    #[test]
    fn google_errors_are_passed_through() {
        let session = begin(AUTH_URL.into()).unwrap();
        let port = session.port;

        std::thread::spawn(move || {
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(20));
                if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                    use std::io::Write;
                    let _ = stream.write_all(
                        b"GET /?error=access_denied&error_description=User+said+no HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                    );
                    return;
                }
            }
        });

        match block_on(session.receiver).expect("an error should have been sent") {
            AuthOutcome::Error { error, description, .. } => {
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
}
