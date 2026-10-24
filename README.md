# Winnow

Gmail, but it sorts the noise out for you and shows its working.

I made this because Gmail kept burying mail I actually needed. Not spam, not
promotions — just mail. Winnow reads everything, decides what each message *is*
(important, needs a reply, a security alert, a one-time code, shipping, social,
junk), and puts the ones you'd have missed at the top. It learns from what you
star and what you filter, and tells you why instead of asking for trust.

Runs in a browser and as a desktop app. Same program either way.

## What you don't get

- **Gmail and nothing else.** No IMAP, no Outlook, no Fastmail, no self-hosted
  server (all of those are "yet"). It's the Gmail REST API and its labels all the way down.
- **Drafts, but no Drafts folder.** Compose, reply and forward are plain text with
  no attachments. What you write is saved to your Gmail drafts as you type (and kept
  on this device, so a reload brings it back), but Winnow has no Drafts mailbox to
  browse them in yet: Gmail's own drafts aren't fetched.
- **The classifier is wrong sometimes.** It's a pile of rules ported from an old
  Swift app of mine, and some of them look like bugs because they are. I left
  them narrow on purpose. Widening them makes it louder, not better.
- **No sign-in wall.** The demo mailbox is seeded on boot and is the default, not
  a fallback. "Connect Gmail" is a button, not a gate.

## Install

Grab the right file from the [releases page](https://github.com/hxmbl/winnow/releases).

| Platform | File |
| --- | --- |
| Linux | `Winnow_<version>_amd64.AppImage` (any distro: `chmod +x`, run it) or `Winnow_<version>_amd64.deb` (`sudo apt install ./Winnow_…deb`) |
| macOS | `Winnow_<version>_universal.dmg`, Apple silicon and Intel, macOS 10.15+ |
| Android | `Winnow_<version>_android-universal.apk` (or `…-debug.apk`), any phone on Android 7+ |

**macOS**: Gatekeeper will complain. Drag to Applications, then **right-click → Open** and confirm once. Or:

```sh
xattr -dr com.apple.quarantine /Applications/Winnow.app
```

**Windows**: No desktop build. Run the web app: `docker compose up -d` in a clone, then open http://localhost:8080. Or build it yourself: `cd web && npm install && npm run build`, then serve `web/dist`.

**Linux**: AppImage needs FUSE 2 (`libfuse2`) on some distros; the `.deb` doesn't.

## Updates

Winnow checks GitHub for new releases on launch and every few hours. Shows once in the status pill when an update is available. **What's new** shows release notes since your version.

How it updates depends on how you run it:

| Running as | Update |
| --- | --- |
| macOS app, Linux AppImage | Downloads the signed update, replaces itself and restarts |
| Linux `.deb` | Downloads the new `.deb` to Downloads and opens your package installer |
| Android | Downloads the new APK and opens Android's installer (allow "Install unknown apps" for Winnow once) |
| Web app in Docker | Tells you to restart the container (`docker compose restart`): each start fetches the newest release |
| Web app you host | Tells you to update it: `git pull && npm --prefix web ci && npm --prefix web run build`, then redeploy |

Pre-releases (versions like `1.6.0-beta.1`) are never offered: only stable releases. Maintainers can opt an installed app (macOS, AppImage, `.deb`, Android) into **Beta updates**, which also offers pre-releases, installed from that release's own signed files with the same checks; it's off by default, and turning it off never moves you back to an older version (you stay on the beta until the next stable release newer than it). The Docker image only runs a pre-release you pin with `WINNOW_VERSION`.

The `.deb` and the APK are checked against the release's `SHA256SUMS` before the installer opens; a download that doesn't match, or a release without the file, is refused. To check a download yourself: `sha256sum -c SHA256SUMS --ignore-missing`.

Turn off the automatic check in **Settings → About**; **Check now** is there too.

## Running from source

```sh
cd web
npm install
npm run dev            # http://localhost:5173, demo mailbox, no account needed
npm run check          # typecheck + lint + tests
npm run smoke          # Playwright pass over the production build
```

Desktop (needs Rust toolchain and `cargo install tauri-cli --version "^2"`):

```sh
npm run tauri:dev      # runs `cargo tauri dev` in native/
npm run tauri:build    # a bundle in native/src-tauri/target/release/bundle
npm run tauri:build -- app   # just the .app, no create-dmg needed
```

On Linux you also need WebKitGTK plus `libayatana-appindicator3` and `librsvg2` — copy them from the CI file. On macOS the `.dmg` needs `brew install create-dmg`; the `.app` doesn't. `native/README.md` explains why the build is a script and not a bare `cargo tauri build`. [MAP.md](MAP.md) is an annotated map of the tree if you're here to read the code.

## Docker

Web app as a container, for Windows or for a server of your own:

```sh
git clone https://github.com/hxmbl/winnow && cd winnow
docker compose up -d           # http://localhost:8080
```

Image is `ghcr.io/hxmbl/winnow` (amd64 and arm64): nginx as an unprivileged user, read-only root, and the app's Content-Security-Policy sent as a header. `docker compose up -d --build` builds it from your checkout instead.

**Updating is restarting.** Each time the container starts it asks GitHub for the newest release, downloads that release's prebuilt `winnow-web-<version>.tar.gz`, checks it against the release's `.sha256` (and GitHub's own digest), and serves it. So when Winnow says a new version is out:

```sh
docker compose restart
```

If GitHub can't be reached or a download fails its check, it serves the copy it downloaded last time, and failing that the one in the image; it never serves anything unverified. It only ever talks to github.com and GitHub's download hosts, over https. Downloads live in the `winnow-data` volume.

In `docker-compose.yml`:

| Setting | Effect |
| --- | --- |
| `WINNOW_VERSION: "v1.5.0"` | Run that release instead of the newest |
| `WINNOW_AUTO_UPDATE: "false"` | Never contact GitHub; run the image's copy (update with `docker compose pull && docker compose up -d`) |

**Gmail** needs a **Web application** OAuth client with this deployment's address as the redirect URI and JavaScript origin (the setup sheet shows both). Google allows plain `http` only for `localhost`, so anywhere else put it behind https (a reverse proxy such as Caddy or Traefik, or your host's TLS).

**The render proxy** (see [below](#the-render-proxy)) is a second container:

```sh
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d
```

Put `COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml` in a `.env` beside them so plain `docker compose restart` includes it. The proxy is not published on the host; the web container forwards `/render` and `/asset/` to it, so it's same-origin with the app and needs no CORS setting. It updates the same way (`winnow-proxy-<version>.tar.gz`, image `ghcr.io/hxmbl/winnow-proxy`). To use a proxy you run elsewhere instead, set `WINNOW_RENDER_PROXY: "https://render.example"` on the web container; its origin is added to the policy's `connect-src`, and the proxy needs `ALLOWED_ORIGINS` set to the app's origin.

## Gmail setup

Bring your own client. Winnow ships none, so there is nothing to put in `.env.local` and no Google secret in any build. Each person creates an OAuth client in their own Google Cloud project and pastes it into the setup screen, or imports the `client_secret_….json` Cloud Console downloads (**Import JSON**, drop the file on the sheet, or paste its text into Client ID); [docs/google-setup.md](docs/google-setup.md) has the step-by-step.

The setup sheet opens only when you ask for it (**Connect Gmail**, **Continue with Google**, or **Settings → Google account**); Winnow always starts in the demo, and **Continue in demo** stays on the sheet the whole way through. It is a five-step guide, each step with a link straight to the right Cloud Console page (opened in your browser):

1. **Create a Google Cloud project.** Keep it selected; the next links open in it.
2. **Enable the Gmail API**, and optionally the People API (contact suggestions and photos).
3. **Configure the consent screen**: External, left in Testing, with your Gmail address as a test user, and the scopes below added under Data access (each has a copy button on the sheet).
4. **Create the OAuth client**: Desktop app on the desktop and Android builds, Web application in the browser, with the exact redirect URI and origin shown and a copy button for each.
5. **Paste the client ID and secret** (or import the JSON). The format is checked as you type, **Test connection** asks Google whether it knows the client, and a failed test or sign-in comes back as a plain fix with a link to the step that fixes it.

Steps you finish are ticked, and a half-finished setup is remembered on this device (the step, the ticks and the client ID draft, never the secret, under `winnow.google.setupProgress`), so the sheet picks up where you left off; **Start over** clears it, and saving the client drops it.

Google shows most setup errors on its own pages. Paste what it said under **Google showed an error?** on step 5, or pick it from the list:

| Google says | What it means | Fix (step) |
| --- | --- | --- |
| `Error 400: redirect_uri_mismatch` | Web: the page's address isn't registered. Desktop: the client isn't a Desktop app client | add the redirect URI exactly, or create the right client type (4) |
| `Error 403: access_denied`, "has not completed the Google verification process" | your address isn't a test user | add it under Audience → Test users (3) |
| `Error 401: invalid_client`, "OAuth client was not found" | the ID is wrong or from another project | copy it again (5) |
| `invalid_client` (other) | the secret is wrong | copy it again or add a new secret (5) |
| `invalid_request`, "client_secret is missing" | a Web application client needs its secret | paste the secret (5) |
| `unauthorized_client` | wrong client type for this build | create a Desktop app / Web application client (4) |
| "Gmail API has not been used in project … or it is disabled" (`SERVICE_DISABLED`) | the Gmail API is off | enable it in the same project (2) |
| `Error 403: org_internal` | the consent screen is Internal | set the audience to External (3) |
| `admin_policy_enforced` | a Workspace admin blocks unlisted apps | ask the admin to trust the client, or use a personal account (3) |

| Build | Client type | Redirect URI | Secret | Stored in |
| --- | --- | --- | --- | --- |
| Desktop | **Desktop app** | none to register, Winnow uses a loopback port | optional; sent if you paste it (not confidential for an installed app) | OS keychain, entry `google.oauth-client` |
| Web | **Web application** | the page's own address, shown on the setup screen | required | `localStorage`, key `winnow.google.oauthClient`, this origin only |

**Scopes.** Add all three to the OAuth consent screen (Google Auth Platform → Data access):

| Scope | Asked for | Why |
| --- | --- | --- |
| `https://www.googleapis.com/auth/gmail.modify` | at sign-in | read, label, send, drafts |
| `https://www.googleapis.com/auth/contacts.readonly` | later, opt-in | saved contacts in recipient suggestions, and their photos in avatars |
| `https://www.googleapis.com/auth/contacts.other.readonly` | later, opt-in | "other contacts" (people you've written to) |

Sign-in only ever asks for `gmail.modify`, which also covers saving drafts, so autosave needs nothing more. (A grant without it — narrowed outside Winnow — makes the composer say "Drafts need permission" and offer to ask for `gmail.compose` the same incremental way; until then the draft stays on the device.) The two contact scopes are requested through incremental consent (`include_granted_scopes=true`) when someone chooses **Settings → Google contacts → Contact photos and suggestions → Connect**, or **Show contact photos** in a sender's menu, on both builds, and under the composer's To field on the desktop (the web build would have to navigate away from the draft to ask). The People API has to be enabled for the project too, next to the Gmail API; if it is off, Settings says so and links to the switch. Both contact scopes are *sensitive*, not restricted: fine for a test-mode app with listed test users.

## The buckets

Twenty-one, and a message sits in several at once — Important, Action needed and Unread is one ordinary Friday. They're filters rather than verdicts: a pill switches its filter on and off, **All** clears them, and none of them can be hidden. In the list and the reader, a bucket is a word with a tooltip, and the tooltip is the reason:

| Bucket | Why |
| --- | --- |
| Important | from someone you read or reply to |
| Urgent | wants an answer soon |
| Action needed | needs a reply from you |
| Security | an alert about your account |
| Codes | a one-time or verification code |
| Deliveries | a delivery or an order |
| Travel | a booking or an itinerary |
| Events | an invitation or a reminder |
| Receipts | a receipt or an invoice |
| Starred | starred by you |
| Unread | you have not read this yet |
| Files | has a file attached |
| New contacts | someone you have not corresponded with |
| Top contacts | from someone you read most |
| Quiet contacts | rarely from you |
| Newsletters | a mailing list |
| Promos | an advertisement |
| Read later | nothing is waiting on you |
| Long reads | long, and not urgent |
| Social | a social network notification |
| Unsafe | likely junk or phishing |

Where it learned all that is a screen too: **Settings → How Winnow sorts** lists every star, unstar and hidden bucket it has taken as a lesson, with what it had predicted at the time, and offers one reset that throws the lot away. A guess that learns from you only beats one that doesn't if you can read the ledger.

## Keyboard

It's a keyboard application first; the mouse is the fallback. `?` opens this list in the app, rendered from the same table the router reads, so a button can't advertise a shortcut that isn't wired.

| Keys | Does |
| --- | --- |
| `j` / `k`, `↓` / `↑` | Next / previous message; the arrows scroll an open message instead |
| `Home` | Back to the top of the list |
| `o` or `⏎` | Open the highlighted message |
| `Esc` | Close the message, a sheet, or the filters |
| `s` | Star or unstar |
| `c` | Compose a new message (copies the code when the open message has one) |
| `e` | Archive, unarchive, or restore — whichever this mailbox implies |
| `#` or `⌫` | Move to trash, or delete permanently from Trash |
| `u` / `m` | Mark read or unread |
| `r` / `f` | Reply / forward the open message |
| `/` | Search |
| `1`–`9` | Toggle the filter pill in that position |
| `!` | Switch mailbox, or open Settings |
| `,` | Settings |

`⌘`/`⌃`/`⌥` are never touched, and neither is Tab: those belong to the system, and swallowing Tab made every `focus-visible` control unreachable.

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

Everything else — classification, sync, search, threading, replies, the store — is shared, unchanged, in both builds.

## The render proxy

`proxy/` fetches a message's images and hands back a self-contained document, so reading a newsletter doesn't tell the sender where you are. It's off unless you build for it — no `VITE_RENDER_PROXY`, no Proxied option in the reader, nothing else changes.

Read `proxy/README.md` before running it. It's a server that will fetch a URL chosen by whoever emailed you, and the interesting part is the address policy: an address is judged *after* DNS resolution, and every address a hostname resolves to gets judged, including the IPv6 ways of spelling a blocked IPv4 address.

```sh
cd web && npm run proxy          # http://127.0.0.1:8787
VITE_RENDER_PROXY=http://127.0.0.1:8787 npm run build
```

In Docker the proxy is named at run time instead, so the published image works with or without one: see [Docker](#docker).

## Privacy

The developer runs no servers and collects nothing (no telemetry, analytics or crash reports; the update check is one anonymous request to GitHub's releases API every few hours, and can be turned off); your mail, tokens and OAuth client stay on your device and go only to Google (if you turn on **Show brand logos**, sender domains also go to Cloudflare's DNS resolver and logos load from the senders' own sites; with **Gravatar photos** on, a SHA-256 hash of each sender's address goes to Gravatar); and you can cut Winnow off at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

Sharing your screen or taking a screenshot? **Settings → Appearance → Blur sensitive info** hides what you choose, step by step: email addresses; then passwords given in mail; then postal addresses; then the names of people Winnow knows. Each thing hidden becomes the same number of random letters and is blurred, everywhere Winnow shows it (list, reader, composer, accounts, Settings, notifications, message bodies). It's best effort, so check before you share, and it only changes what's on screen: your replies still go to the real addresses.

The mail itself is a mirror in browser storage: `winnow.gmail.cache.messages` holds every synced message as plain JSON, bodies included for the 500 newest, kept in memory and written to `localStorage` as a sink. On the desktop that's the webview's storage — not a database, and not the keychain; only the OAuth tokens and the client go in the keychain. Past the origin's ~5 MB quota the write fails, and Winnow asks before it keeps the cache and says so when it can't, rather than quietly forgetting. Signing out erases the cache and keeps what it learned from you (`winnow.learning.v1`, your preferences, your blocked senders), because the learning is about you and not about that account. It also deletes the tokens and asks Google to revoke Winnow's access, so a copy of the refresh token stops working too. That request is best effort: sign-out never waits for it, so if you were offline, remove Winnow at the permissions page above.

## License

MIT — see [LICENSE](LICENSE).

The bundled typeface, IBM Plex Sans, is under the SIL Open Font License 1.1; see [web/src/assets/fonts](web/src/assets/fonts/README.md).
