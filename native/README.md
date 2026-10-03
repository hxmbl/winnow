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
npm run tauri:build                 # .app + .dmg on macOS
npm run tauri:build -- app          # just the .app, no create-dmg needed
```

Tauri 2 requires the `tauri-cli` v2 binary:

```sh
cargo install tauri-cli --version "^2"
```

### Why the build is a script and not `cargo tauri build`

> The previous version of this section claimed that `cargo tauri build` produces
> **no bundle at all** with tauri-cli 2.11 — exits 0, prints `Built application
> at …`, writes nothing under `target/release/bundle/` — and cited a matrix of
> experiments across `tauri.conf.json` bundle settings. **That was wrong.**
> `bundle.active` defaults to `true`, so a bare `cargo tauri build` does bundle;
> verified against tauri-cli 2.11 after the fact. The experiments were almost
> certainly reading a stale `target/release/bundle/` from an earlier run.

The script survives the correction, for the two reasons that were always true:

1. **Bundle kinds are named per host.** Asking macOS for `deb` is not an error
   Tauri reports — it declines to bundle, quietly. So the targets are decided
   here, where a missing one is a sentence.
2. **Success is asserted by looking for the output,** and per kind rather than per
   directory. "The tool said it succeeded" and "a bundle exists where a release
   should be" are different facts, and a bundle directory containing only empty
   subdirectories passes the weaker check while shipping nothing. A release script
   that reports success without shipping anything is worse than one that fails.

It is also where the argument parsing lives, and that was broken: the original
sliced `passthrough.slice(bundles.length)`, which is always an empty slice because
`bundles.length` *is* `passthrough.length` on that branch. Every flag except a
bundle name was silently swallowed, and `npm run tauri:build -- --bundles app`
produced the literal string `--bundles,app` as a bundle name.

### macOS packaging prerequisites

Bundling a `.dmg` needs Homebrew's `create-dmg` — Tauri's `bundle_dmg.sh` is a
thin wrapper around it:

```sh
brew install create-dmg
```

The `.app` needs nothing beyond a Rust toolchain. The script checks for
`create-dmg` up front and says so, because without it the `.app` builds fine and
the `.dmg` then dies inside a vendored bash script with no mention of what to
install.

### Apple Silicon

The bundle built here is whatever the host toolchain targets — x86_64 on an Intel
Mac, `aarch64` on Apple Silicon. For a universal binary:

```sh
npm run tauri:build -- --target universal-apple-darwin
```

which needs both targets installed: `rustup target add aarch64-apple-darwin
x86_64-apple-darwin`.

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
listener *answered* a request and not that it *understood* one. A malformed target
is now answered with an error page rather than dropped, for the same reason: a
connection that hangs open is indistinguishable from a listener that is not there.

## Field names across the IPC boundary

Tauri rewrites **argument** keys from camelCase to snake_case, and never rewrites
**return values** — those go through plain serde using the struct's own field
names. So a struct declared `authorize_url` in Rust and read as `authorizeUrl` in
TypeScript yields `undefined`, and nothing anywhere reports an error.

Three bugs shipped that way before the tests that now catch them existed:

- `AppInfo`'s capability flags all arrived `undefined`, so `backgroundSync` read
  as absent and the settings panel's entire Background section was gated on it. A
  feature that was implemented, permissioned and unreachable.
- `oauth_begin`'s reply was read as `authorizeUrl`, so `open_external` was called
  with `url: undefined`, IPC rejected it with "missing required key url", and
  desktop sign-in was impossible.
- `notify_new_mail`'s `message_ids` was sent as `messageIds`, which *deserialised
  successfully* into a struct with `#[serde(default)]` — as an empty vec. No error
  at all, and a notification click could never know which conversation to open.

`serde(rename_all = "camelCase")` is not the fix for the first of these: it
produces `nativeOauth`, not `nativeOAuth`. Every field carries an explicit
`#[serde(rename = …)]`, and `web/src/platform/platform.test.ts` asserts the
wire shapes the UI actually reads.

## Three fixes worth knowing about

Each of these was a hang, a deadlock, or a silent no-op, and none of them
produced an error at the call site.

- **`oauth_await` no longer unregisters its port on entry.** It did, so `oauth_cancel`
  had nothing to cancel and Cancel did nothing — the sign-in could not be stopped.
- **`save_attachment` is `async`.** The save dialog blocks; called synchronously from
  the command thread it deadlocked the main thread, so the dialog could not be
  dismissed.
- **`Reopen` reveals the window,** and `focusWindow` calls `unminimize` before
  `show` and `setFocus`. `setFocus` on a minimised window focuses nothing visible,
  and `unminimize` needed a capability that had not been granted — so it was
  rejected, and being first in the sequence, it stopped the other two running.
  Every deep link and every tray click on a running app therefore did nothing.

## Closing the window hides the app

The inbox client is meant to keep syncing, so `CloseRequested` hides rather than
quits. That makes the tray load-bearing rather than decorative: it is the only
way back in, and the only way to quit. If you remove the tray, remove the hide.

The corollary is that showing the window has to be deliberate. It is configured
`visible: false` so nobody sees a white rectangle while the webview boots, and
`on_page_load` reveals it once the page has actually finished — the only moment
there is something to look at. Before that hook existed, a normal launch produced
a tray icon and no window at all.

`--minimized` skips the reveal: that is how the autostart entry point launches,
and a login item that opens a window over whatever the user is doing is exactly
the behaviour people switch off.