# Winnow

Gmail, but it does the sorting and shows its working.

I made this because Gmail kept burying mail I actually needed. Not spam, not
promotions — just mail. So Winnow reads everything, decides what each message
*is* (important, needs a reply, a security alert, a one-time code, shipping,
social, junk), and puts the ones I'd have missed at the top. It learns from what
I star and what I filter, and it tells you why instead of asking for trust.

It runs in a browser and as a desktop app. Same program either way.

## What you don't get

- **Gmail and nothing else.** No IMAP, no Outlook, no Fastmail, no self-hosted
  server. It's the Gmail REST API and its labels all the way down.
- **No release.** No `brew install`, no `.dmg` page, no npm package, no
  installer. CI builds a bundle so I know the Rust compiles, then throws it away.
  There's a `# TODO: Add releases` at the bottom of `.github/workflows/ci.yml`.
  Clone it.
- **One account.** Not multi-account. Not "coming soon".
- **The classifier is wrong sometimes.** It's a pile of rules ported from an old
  Swift app of mine, and some of them look like bugs because they are. I left
  them narrow on purpose. Widening them makes it louder, not better.
- **The Swift app isn't here.** Every file says `Ported from
  legacy/swift-native/...` and there is no `legacy/` directory. It's in another
  checkout. Don't go looking for it here.
- **No sign-in wall.** The demo mailbox is seeded on boot and is the default, not
  a fallback. "Connect Gmail" is a button, not a gate.

## Layout

```
web/          The whole app: product logic, UI, and the Gmail client.
  src/core/     Pure TypeScript. No DOM, no React, no platform.
  src/platform/ The browser/desktop boundary. Two implementations, one interface.
  src/ui/       React components.
native/
  src-tauri/    Tauri v2 shell. Rust. Native bits only.
proxy/         Optional render proxy. Separate Node service, see its README.
```

Arrows only ever point inward: `ui` → `platform` → `core`, and `native` is
reachable from `platform` and nothing else. `core/` doesn't import React, doesn't
import Tauri, doesn't touch `window`. That's what makes the classifier testable
without a browser and lets one bundle serve both hosts.

## Why there's a Rust process at all

The rule I built it on:

> If a browser can do it, it doesn't go in the platform interface.

Which leaves seven, and seven is the entire argument for Tauri:

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
npm run tauri:build -- app   # just the .app, no create-dmg needed
```

Needs a Rust toolchain and `cargo install tauri-cli --version "^2"`. On Linux it
also wants WebKitGTK plus `libayatana-appindicator3` and `librsvg2` — the CI
file lists them, copy it from there. On macOS the `.dmg` needs
`brew install create-dmg`; the `.app` doesn't. `native/README.md` explains why
the build is a script and not a bare `cargo tauri build`.

## Gmail setup

Get this wrong and you'll lose an afternoon. One table:

| Build | Client type | Redirect URI | Secret |
| --- | --- | --- | --- |
| Desktop | **Desktop app** | none, Winnow uses a loopback port | none, and must not be set |
| Web | **Web application** | a URL on your own origin | required |

```sh
# web/.env.local
VITE_GMAIL_CLIENT_ID=…apps.googleusercontent.com

# web only, and nothing else
# VITE_GMAIL_CLIENT_SECRET=…   # ← do NOT set this for a desktop build
# VITE_GMAIL_REDIRECT_URI=https://your.host/auth/callback
```

Two things that bit me:

- **No secret ever goes out on the desktop, and PKCE is the whole security story
  there.** A shipped binary is a public binary. `platform/desktop.ts` ignores
  `VITE_GMAIL_CLIENT_SECRET` outright rather than reading it, so having one set
  for the web build doesn't break your desktop build.
- **The loopback port is a placeholder.** The web layer writes
  `__WINNOW_LOOPBACK_PORT__`, Rust binds a real ephemeral one and substitutes it.
  The redirect URI and the listening socket can't disagree that way. The failure
  mode otherwise is a sign-in that hangs for five minutes and then blames your
  network.

## The render proxy

`proxy/` fetches a message's images and hands back a self-contained document, so
reading a newsletter doesn't tell the sender where you are. It's off unless you
build for it — no `VITE_RENDER_PROXY`, no Proxied option in the reader, nothing
else changes.

Read `proxy/README.md` before running it. It's a server that will fetch a URL
chosen by whoever emailed you, and the interesting part is the address policy: an
address is judged *after* DNS resolution, and every address a hostname resolves
to gets judged, including the IPv6 ways of spelling a blocked IPv4 address.

```sh
cd web && npm run proxy          # http://127.0.0.1:8787
VITE_RENDER_PROXY=http://127.0.0.1:8787 npm run build
```

## Tests

1085 of them, none needing a DOM. 1048 over `web/src`, 37 for the proxy.

Most are ordinary unit tests of ordinary pure functions. Four are worth naming,
because each exists only because a real bug got out and nothing else would have
caught it:

- **`platform.test.ts`** pins the names crossing the Rust/TypeScript line. Tauri
  rewrites *argument* keys from camelCase to snake_case but never rewrites
  *return values*, so a struct declared `authorize_url` in Rust and read as
  `authorizeUrl` in TypeScript gave `undefined` and desktop sign-in was
  impossible — with the screen showing the raw IPC error as though Google had
  sent it. Rust is read as text rather than linked, so the web suite still runs
  without a Rust toolchain.
- **`theme.test.ts`** makes the palettes checkable. A screenshot can't tell you a
  grey is 3.14:1 on white, which is how `inkSubtle` shipped. It was every
  section header, every row timestamp and the status line, at 11–13px.
- **`mapper.test.ts` / `mime.test.ts`** cover both ends of a send. Nothing on the
  way in or out was tested, so quoted-printable subjects rendered as mojibake and
  `In-Reply-To` went out as a bare Gmail id. Replies threaded in the sender's
  Gmail and arrived as new conversations everywhere else.
- **`contacts/`** folds addresses, so `Ada@Example.com` and `ada@example.com`
  are one row instead of two that the recipient list will happily offer you.

`npm run smoke` drives the real production build through a browser: boots,
classifies, keyboard navigation, compose, persist, and logs nothing to the
console. It starts its own `vite preview` in-process, so the command above is the
whole command. It also fails the run if anything raises a *native* dialog — the
discard confirmation used to be `window.confirm`, which Tauri's webviews don't
reliably implement, so on desktop the question couldn't be asked at all.

## Decisions I'd defend

- **One `derive()` pass.** The store computes profile → signals → bags → list →
  rail once and hands it to everyone. One answer, so nothing can disagree about
  what's on screen.
- **Bulk mail is discounted per message, not per sender.** Someone who forwards
  one newsletter among six replies is a contact, and discounting the whole sender
  files them with the retailers. Ties break on the sender name, because a ranking
  that decides what gets hidden can't be a shuffle.
- **Recency decays against the newest message in the corpus, not the wall
  clock.** An inbox that re-sorts itself overnight is impossible to reason about
  while triaging.
- **The list sort is a fixed formula; the learned score is not.** So dragging a
  weight slider can't silently reorder the inbox under you. They share the sender
  ladder, so they agree about *who* matters and disagree about how much each
  signal is worth.
- **Coercion isn't phishing.** The phishing test is binary, and a bucket that
  cries wolf is the only way to make it useless. Every coercion pattern needs a
  *demand* alongside the threat, so a real bank notice about a delinquent account
  doesn't get filed as an attack.
- **Images load one message at a time.** It used to be a preference, which meant
  one click under one message turned on sandboxed sender markup for every message
  after it, forever.
- **No gravatar.** A third-party request per message is a latency cost and a
  privacy leak, for decoration.
- **Sent is a mailbox.** It's also the only source for "who do I write to". The
  recipient list is built from both halves of a conversation and sent mail is
  normally the invisible half.
- **Every verb has a way back.** `⇧U` restores exactly the messages it touched, a
  muted bucket stays in the rail struck through with a ↺, a filed message
  reappears where it went.

## And what isn't true forever

The layout up there is a picture of how the code is right now, not an
architecture promise. Add a second mail provider or a fourth host and it stops
being true, and whoever does that will have to redraw it.

If this ever grows a `platform/` interface with three implementations, something
went wrong.

## License

MIT — see [LICENSE](LICENSE).