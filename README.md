# Winnow

A mail client that tells you what matters.

Winnow is not a Gmail skin. It reads your mail, decides for each message what
kind of thing it is — important, needs a reply, a security alert, a one-time
code, shipping, social, junk — and puts the ones you would have missed above the
ones you would have skimmed. It learns from what you star and what you filter,
and it shows you its reasoning rather than asking for your trust.

It runs as a normal website and as a desktop app. Both are the same program.

## Layout

```
web/          The whole application: product logic, UI, and the Gmail client.
  src/core/     Pure TypeScript. No DOM, no React, no platform.
  src/platform/ The browser/desktop boundary. Two implementations, one interface.
  src/ui/       React components.
native/
  src-tauri/    Tauri v2 shell. Rust. Native capabilities only.
legacy/
  swift-native/ The original. A behaviour reference, not a dependency.
references/     Design assets.
```

The dependency arrows only ever point inward: `ui` → `platform` → `core`, and
`native` is reachable from `platform` and nothing else. `core/` does not import
React, does not import Tauri, and does not touch `window`. That is what makes
the classifier unit-testable and lets the same bundle serve both hosts.

### The platform rule

> If a browser can do it, it does not belong in the platform interface.

Seven things a browser genuinely cannot do well, and therefore the whole
reason Tauri exists:

| Capability | Browser | Desktop |
| --- | --- | --- |
| OAuth tokens at rest | `localStorage` | OS keychain |
| OAuth redirect | a page load back to the site | loopback listener on an ephemeral port |
| Sync while hidden | a throttled timer, or nothing | a Rust thread |
| Notifications | `Notification` | native, carrying message ids |
| Unread badge | `document.title` | dock badge / tray tooltip |
| Save an attachment | a download | a real save dialog, returning a path |
| Open a link | a new tab | the system browser |

Everything else — classification, sync, search, threading, replies, the store —
is shared, unchanged, in both builds.

## Running it

```sh
cd web
npm install
npm run dev            # http://localhost:5173, demo mailbox, no account needed
npm run check          # typecheck + lint + tests
npm run smoke          # Playwright pass over the production build
```

Desktop:

```sh
npm run tauri:dev      # runs `cargo tauri dev` in native/
npm run tauri:build    # a bundle in native/src-tauri/target/release/bundle
npm run tauri:build -- app   # just the .app — no create-dmg needed
```

The desktop build needs a Rust toolchain, `cargo install tauri-cli --version "^2"`,
and per platform the usual Tauri system dependencies (WebKitGTK on Linux). On
macOS a `.dmg` additionally needs `brew install create-dmg`; the `.app` does not.
See `native/README.md` for why the build is a script rather than a bare
`cargo tauri build`.

## Gmail setup

Create an OAuth client in the Google Cloud console. **Which kind depends on how
you are running it**, and this is the one configuration decision that is easy to
get wrong:

| Build | Client type | Redirect URI | Secret |
| --- | --- | --- | --- |
| Desktop | **Desktop app** | none — Winnow uses a loopback port | none, and must not be set |
| Web | **Web application** | a URL on your own origin | required |

```sh
# web/.env.local
VITE_GMAIL_CLIENT_ID=…apps.googleusercontent.com

# desktop only, and nothing else
# VITE_GMAIL_CLIENT_SECRET=…   # ← do NOT set this for a desktop build
```

For a web deployment:

```sh
VITE_GMAIL_REDIRECT_URI=https://your.host/auth/callback
VITE_GMAIL_CLIENT_SECRET=…
```

Two details that are easy to trip over:

- **No secret is ever sent on the desktop, and PKCE is the whole security story
  there.** A shipped binary is a public binary. `platform/desktop.ts` ignores
  `VITE_GMAIL_CLIENT_SECRET` outright rather than reading it, so a developer with
  one set for the web build still gets a correct desktop build.
- **The loopback port is a placeholder.** The web layer writes
  `__WINNOW_LOOPBACK_PORT__` where the port belongs, Rust binds an ephemeral one
  and substitutes it. Doing it that way means the redirect URI and the listening
  socket cannot disagree — the failure mode being a sign-in that hangs for five
  minutes and then blames the user's network.

The app runs with no Google configuration at all: the demo mailbox is seeded on
boot, so you can see whether the classification is any good before deciding
whether to trust it with an account. The demo is the *default*, not a fallback —
there is no sign-in wall — so the top bar's status line carries a **Connect Gmail**
button, which is the only route to sign-in on a fresh install.

## Tests

431 unit tests over `web/src` — the classifier, the profile, the filters, the list
pipeline and Smart Score, the learning model and its tolerant snapshot reader, the
store's derivation and undo, the demo seed's own contract, the Gmail sync engine,
token refresh, reply quoting, keybinds, the OAuth redirect parsing, the desktop IPC
wire shapes, and the rail's ordering. No DOM required, which is the payoff of the
`core`/`ui` split.

`platform.test.ts` pins the names that cross the Rust/TypeScript boundary, which is
the one place in the codebase where a silent field-name mismatch produces no error
at all. Tauri rewrites *argument* keys from camelCase to snake_case but never
rewrites *return values*, so a struct declared `authorize_url` in Rust and read as
`authorizeUrl` in TypeScript produced `undefined` — and desktop sign-in was
impossible with the sign-in screen showing the raw IPC error as though it had come
from Google. `serde(rename_all = "camelCase")` is not the fix, either: it yields
`nativeOauth`, not `nativeOAuth`. Both directions are asserted in tests now.

The Rust side has its own tests for the parts worth testing: the loopback
listener, the path sanitiser, the background scheduler, deep-link parsing. The
listener's tests in particular assert that a redirect is *understood*, not merely
that a request was *answered* — a distinction that turned out to matter, because
the version that folded the query string into `Url::set_path` answered every
request with a 204 and never once read a code.

`npm run smoke` drives the real production build through a browser and asserts
that the app boots, classifies, navigates by keyboard, composes, persists, and logs
nothing to the console. It starts its own `vite preview` in-process, so the command
in this file is the whole command. It is the check that the three layers are
actually wired to each other, which unit tests structurally cannot tell you — and
the reason several of its assertions exist at all is that the corresponding defect
was invisible from inside any single layer.

## Design notes worth knowing

**One `derive()` pass.** The store computes profile → signals → bags → list →
rail in a single pass and hands the result to everyone. Consumers cannot
disagree about what is on screen, because there is only one answer and it is
computed once.

**`NO_CURSOR = -1`.** Distinct from "cursor on row 0", so a fresh list knows the
user has not touched the keyboard yet — which is why `j` starts at the top and
`k` starts at the bottom.

**`now` is state.** The demo is built around a fixed instant so its day sections
and relative timestamps are deterministic; live mail replaces it with the wall
clock on connect.

**The keyword tables are narrow on purpose.** Ported faithfully from the Swift
reference, including the parts that look like bugs. Widening them would make the
classifier louder and less trustworthy. See `legacy/swift-native/README.md`.

**Engagement is weighted by correspondence, not volume.** A sender's score
discounts bulk mail per message using Gmail's own category, so a retailer
sending four promotions does not outrank a colleague writing three replies. The
discount is per *message* rather than per sender, because someone who forwards
one newsletter among six replies is overwhelmingly a contact. Ties break on the
sender name: a ranking that decides what is hidden cannot be a shuffle.

**Coercion is scored separately from phishing.** The phishing test is binary, so
folding "your account will be suspended… all data will be removed" into it
changed nothing for exactly the worst message. Every coercion pattern requires a
*demand* alongside the threat, so a real bank notice about a delinquent account
does not get filed as phishing — an Unsafe bucket that cries wolf is the only way
to make it useless.

**No gravatar.** Avatars are a colour hashed from the address. A third-party
request per message is a latency cost and a privacy leak for decoration.

**Forwarding is a first-class verb.** `GmailClient` has had `markNotSpam` and a
forward path since early on and nothing in the UI called either, so a message could
be replied to but not forwarded, and a message Gmail misfiled could only be
recovered by going to gmail.com. Both are wired now: `f` opens a forward sheet that
starts in the To field with Send disabled until there is a recipient, and the spam
folder is the only place the "not spam" button appears.

**Muting a bucket is reversible from where you did it.** Hiding a bucket is a
statement about your mail, so it is persisted with the rest of what you have told
Winnow — but a mute that cannot be undone from the rail is a trap. The muted pill
stays in place, struck through and not filterable, carrying a ↺ that brings the
bucket back; Settings also lists them under "Hidden buckets".

**Smart Score is deliberately not importance.** The list sort is a fixed formula and
the learnable importance score is not, so dragging a weight slider cannot silently
reorder the inbox underneath you. They share the sender ladder, so they agree about
*who* matters while disagreeing about how much each signal is worth. Its recency
nudge is relative to the span of the messages being ranked, never the wall clock: an
inbox that re-sorted itself overnight would be impossible to reason about while
triaging.

**The empty state has five reasons, not one.** "Nothing here" can mean the mailbox
is empty, the search is too narrow, the filters are too narrow, the buckets you
muted are hiding everything, or the default inbox's own spam rule is hiding
everything. Those have three different remedies, and the old single message either
blamed the user for a filter they did not set or left them with an empty screen and
no button.