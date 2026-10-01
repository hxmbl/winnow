# The desktop shell

A Tauri v2 application whose entire job is to give the web app seven things a
browser cannot do. Nothing here decides anything about mail.

## What is in it

| Module | Why it cannot be TypeScript |
| --- | --- |
| `secrets.rs` | OAuth tokens in the OS keychain, not `localStorage` |
| `oauth.rs` | A loopback HTTP listener on an ephemeral port, for the redirect |
| `scheduler.rs` | A background thread that ticks while the window is hidden |
| `files.rs` | A real save dialog, and a path sanitiser |
| `deep_link.rs` | `winnow://` links, registered with the OS |
| `tray.rs` | The tray icon, which is also the only way back once the window hides |
| `commands.rs` | The command surface. Thin: validate, delegate, stringify errors |

Everything else — the classifier, the sync engine, the store, every pixel — is in
`web/` and runs unchanged in a browser.

## Running

From `web/`:

```sh
npm run tauri:dev
npm run tauri:build
```

Both run `cargo tauri` from this directory, which is where `src-tauri/` lives.
Tauri 2 requires the `tauri-cli` v2 binary:

```sh
cargo install tauri-cli --version "^2"
```

## The command surface

Every command in `commands.rs` has a binding in `web/src/platform/desktop.ts`
and a working browser equivalent except the ones documented as native-only. When
you add a command, add both halves, or the platform interface grows a method
with no browser implementation — which is the whole thing the interface is
designed to prevent.

```
app_info                    what this build can do
secrets_set / _get / _delete   the keychain
oauth_begin / _await / _cancel  the loopback sign-in
notify_new_mail             a native notification
open_external               the system browser, https only
save_attachment             a save dialog
set_unread_badge            dock badge, tray tooltip, window title
set_background_sync         start, retune or park the ticker
request_notification_permission
```

## The loopback port

`oauth_begin` receives the authorize URL with `__WINNOW_LOOPBACK_PORT__` where
the port goes, binds a listener, substitutes the port it actually got, and hands
back the finished URL. A URL without the placeholder is refused rather than
silently accepted — see the comment on `PORT_PLACEHOLDER` for why that failure
would be so expensive.

## Parsing the request target

`serve` splits the request target on `?` and hands the path to `Url::set_path`
and the query to `set_query`, separately.

This is not a detail. The version that folded the whole target into `set_path`
produced a URL whose `query_pairs()` was always empty, so the listener answered
every request with a 204 and never once read a `code` or an `error`. It did not
crash or report anything wrong: it waited, and the sign-in timed out five
minutes later with a message blaming the user's network.

The tests around it had passed the whole time, because they checked that the
listener *answered* a request and not that it *understood* one.

## Closing the window hides the app

The inbox client is meant to keep syncing, so `CloseRequested` hides rather than
quits. That makes the tray load-bearing rather than decorative: it is the only
way back in, and the only way to quit. If you remove the tray, remove the hide.