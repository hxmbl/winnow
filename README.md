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
- **No signed installers.** There are [downloads](#download), but nothing is
  code-signed or notarised, so macOS and Windows both warn you the first time.
  No `brew install`, no app store, no npm package, no auto-update.
- **One account.** Not multi-account. Not "coming soon".
- **The classifier is wrong sometimes.** It's a pile of rules ported from an old
  Swift app of mine, and some of them look like bugs because they are. I left
  them narrow on purpose. Widening them makes it louder, not better.
- **The Swift app isn't here.** Every file says `Ported from
  legacy/swift-native/...` and there is no `legacy/` directory. It's in another
  checkout. Don't go looking for it here.
- **No sign-in wall.** The demo mailbox is seeded on boot and is the default, not
  a fallback. "Connect Gmail" is a button, not a gate.

## Download

Every release is on the [Releases page](https://github.com/hxmbl/winnow/releases).
Take the newest one that isn't marked *Pre-release* unless you want the beta.

| Platform | File |
| --- | --- |
| Linux | `Winnow_<version>_amd64.AppImage` (any distro: `chmod +x`, run it) or `Winnow_<version>_amd64.deb` (`sudo apt install ./Winnow_…deb`) |
| macOS | `Winnow_<version>_universal.dmg`, Apple silicon and Intel, macOS 10.15+ |
| Windows | `Winnow_<version>_x64_en-US.msi` or `Winnow_<version>_x64-setup.exe`, when that release has them — the Windows build is best-effort |

**None of it is signed**, which costs money I haven't spent yet. So:

- **macOS** says Winnow "can't be opened because Apple cannot check it for
  malicious software" (or, on newer versions, that it's damaged). Drag it to
  Applications, then **right-click → Open** and confirm, once. If that's not
  offered (macOS 15 moved it to **System Settings → Privacy & Security → Open
  Anyway**), or you'd rather use a terminal:

  ```sh
  xattr -dr com.apple.quarantine /Applications/Winnow.app
  ```

- **Windows** SmartScreen says "Windows protected your PC". Click **More info**,
  then **Run anyway**.
- **Linux** doesn't care. The AppImage needs FUSE 2 (`libfuse2`) on some
  distros; the `.deb` doesn't.

Winnow doesn't ship a Google sign-in client. To connect Gmail you bring your own:
create a free OAuth client in your own Google Cloud project and paste it into the
app (**Connect Gmail**, or **Settings → Google account**).
[docs/google-setup.md](docs/google-setup.md) walks through it in about ten
minutes. Because the client is your own unverified project, Google shows its
"Google hasn't verified this app" screen before consent; that's expected.

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

Bring your own client. Winnow ships none, so there is nothing to put in
`.env.local` and no Google secret in any build. Each person creates an OAuth
client in their own Google Cloud project and pastes it into the setup screen;
[docs/google-setup.md](docs/google-setup.md) has the step-by-step.

| Build | Client type | Redirect URI | Secret | Stored in |
| --- | --- | --- | --- | --- |
| Desktop | **Desktop app** | none to register, Winnow uses a loopback port | optional; sent if you paste it (not confidential for an installed app) | OS keychain, entry `google.oauth-client` |
| Web | **Web application** | the page's own address, shown on the setup screen | required | `localStorage`, key `winnow.google.oauthClient`, this origin only |

**Scopes.** Add all three to the OAuth consent screen (Google Auth Platform →
Data access):

| Scope | Asked for | Why |
| --- | --- | --- |
| `https://www.googleapis.com/auth/gmail.modify` | at sign-in | read, label, send |
| `https://www.googleapis.com/auth/contacts.readonly` | later, opt-in | saved contacts in recipient suggestions |
| `https://www.googleapis.com/auth/contacts.other.readonly` | later, opt-in | "other contacts" (people you've written to) |

Sign-in only ever asks for `gmail.modify`. The two contact scopes are requested
through incremental consent (`include_granted_scopes=true`) when someone chooses
**Improve suggestions from Google contacts** — in Settings on both builds, and
under the composer's To field on the desktop (the web build would have to
navigate away from the draft to ask). The People API has to be enabled for the
project too, next to the Gmail API. Both contact scopes are *sensitive*, not
restricted: fine for a test-mode app with listed test users.

Things worth knowing:

- **The client is read per request.** `TokenManager` asks the platform's
  `CredentialStore` for it each time it exchanges or refreshes, so a changed client
  takes effect without a reload. Saving a *different* client signs out first: a
  refresh token belongs to the client that issued it.
- **"Test connection" doesn't sign in.** It sends a made-up authorization code to
  Google's token endpoint; Google checks the client before the code, so
  `invalid_grant` means the client is good and `invalid_client` says which half is
  wrong.
- **The loopback port is a placeholder.** The web layer writes
  `__WINNOW_LOOPBACK_PORT__`, Rust binds a real ephemeral one and substitutes it.
  The redirect URI and the listening socket can't disagree that way. The failure
  mode otherwise is a sign-in that hangs for five minutes and then blames your
  network.

### Cutting a release

```sh
# the same plain version in web/package.json, native/src-tauri/tauri.conf.json
# and native/src-tauri/Cargo.toml (then `cargo check` to update Cargo.lock)
cd web && node scripts/check-version.mjs     # prints it, or lists the disagreements
git tag v0.2.0 && git push origin v0.2.0      # or v0.2.0-beta.1 for a pre-release
```

`.github/workflows/release.yml` runs the secret scan, checks the tag against the
manifests, builds Linux, macOS (universal) and Windows, and attaches the bundles
to a **draft** release for you to publish. A suffix (`-beta.1`) marks it a
pre-release; the manifests stay plain `MAJOR.MINOR.PATCH`, because the Windows
`.msi` refuses anything else. Windows may fail without holding up the other two.

The release needs no repository secrets: there is no Google client to bake in.
It still fails if a bundle contains a `GOCSPX-` string, as a tripwire against a
client secret ever ending up in one.

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

1199 of them, none needing a DOM. 1162 over `web/src`, 37 for the proxy.

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
- **Google contacts are a prior, not a ranking.** A saved contact adds a fixed
  bonus on top of what the mail says, an "other contact" a smaller one. Saved
  beats other with the same history, and either can surface someone the mail
  never mentions, but somebody you actually write to every week still outranks a
  name you saved once in 2019. Synced with People API sync tokens; an expired
  token means a quiet full re-list, not an error.
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

## Privacy

The developer runs no servers and
collects nothing (no telemetry, analytics, crash reports or update checks); your
mail, tokens and OAuth client stay on your device and go only to Google; and you
can cut Winnow off at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## License

MIT — see [LICENSE](LICENSE).

The bundled typeface, IBM Plex Sans, is under the SIL Open
Font License 1.1; see [web/src/assets/fonts](web/src/assets/fonts/README.md).