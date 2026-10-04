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
there is no sign-in wall — so the status line at the top of the mailbox carries a
**Connect Gmail** button, which is the only route to sign-in on a fresh install.

## Tests

683 unit tests over `web/src` — the classifier, the profile, the filters, the list
pipeline and Smart Score, the learning model and its tolerant snapshot reader, the
store's derivation, its undo and its mutes, the demo seed's own contract, the Gmail wire
types and sync engine, the request layer's single 401 retry, MIME assembly, PKCE, token
refresh and token storage, day bucketing, reply quoting, keybinds, the OAuth redirect
parsing, the desktop IPC wire shapes, the palettes' contrast, the remote-reference count
behind the reader's privacy note, and the rail's ordering. No DOM required, which is the
payoff of the `core`/`ui` split.
Three of those deserve naming.

**`platform.test.ts` pins the names that cross the Rust/TypeScript boundary.** That is
the one place in the codebase where a silent field-name mismatch produces no error at
all: Tauri rewrites *argument* keys from camelCase to snake_case but never rewrites
*return values*, so a struct declared `authorize_url` in Rust and read as `authorizeUrl`
in TypeScript produced `undefined` — and desktop sign-in was impossible, with the
sign-in screen showing the raw IPC error as though it had come from Google. Both
directions are asserted now: every invoked command is registered *and* declared, every
declared command is registered (the shape of the `markNotSpam` bug), `AppInfo`'s four
capability flags serialise under exactly the camelCase keys the UI reads, the
snake_case spellings are absent, serde's near-miss `nativeOauth` is absent too, the
return-value field names match, the event names and tray action ids match, the deep-link
scheme matches, and the OAuth port placeholder matches. The Rust side is read as text
rather than linked, so the web suite stays runnable without a Rust toolchain; Rust's
own `commands.rs` tests assert the *values* from the other end.

**`theme.test.ts` makes the palettes checkable.** A screenshot cannot tell you that a
grey is 3.14:1 on white, which is how `inkSubtle` shipped — it was the colour of every
section header, every row timestamp and the status line, at 11–13px. The test asserts
each text token clears WCAG AA against every plane it is painted on, in both schemes;
that a badge chip's *label* clears AA on its own wash (nine of the twenty-one light
accents were between 2.7:1 and 4.2:1, because the accent is both the fill and the
text); that the muted steps stay a *visible* step apart rather than merely ordered; and
that no token colour is combined with a Tailwind `/opacity` modifier, which emits
`rgb(var(--wn-surface) / 0.6)` — not a colour — and drops the declaration silently.

**`mapper.test.ts` and `mime.test.ts` cover the two ends of a send.** Nothing on the
way in and nothing on the way out was tested, which is why quoted-printable subjects
rendered as mojibake (`=E2=80=94` decoded byte-by-byte into three Latin-1 characters),
`In-Reply-To` went out as a bare Gmail id rather than a Message-ID — so replies threaded
in the sender's own Gmail and arrived as new conversations everywhere else — attachment
bodies were written in base64*url* under a `Content-Transfer-Encoding: base64` header,
and the `raw` field was sent as plain JSON text, which the API accepts for ASCII and
rejects the moment a header is non-ASCII. Each of those is invisible until someone
else's mail client shows it.

`datetime.test.ts` covers the other end of that symmetry: day sections are only emitted
for a date-sorted list, because a "Today" header is a claim about adjacency that only
chronological order can make. Sorted by score, the days interleaved and the list read
`Today / This week / Today` — with each section keyed on its bucket name, so every
repeat was a duplicate React key.

The Rust side has its own tests for the parts worth testing: the loopback listener,
the path sanitiser, the background scheduler, deep-link parsing. The listener's tests
in particular assert that a redirect is *understood*, not merely that a request was
*answered* — a distinction that turned out to matter, because the version that folded
the query string into `Url::set_path` answered every request with a 204 and never once
read a code.

`npm run smoke` drives the real production build through a browser and asserts
that the app boots, classifies, navigates by keyboard, composes, persists, and logs
nothing to the console. It starts its own `vite preview` in-process, so the command
in this file is the whole command. It is the check that the three layers are
actually wired to each other, which unit tests structurally cannot tell you — and
the reason several of its assertions exist at all is that the corresponding defect
was invisible from inside any single layer.

It also fails the run if anything raises a *native* dialog. The composer's discard
confirmation used to be `window.confirm`, which Tauri's webviews do not reliably
implement — so on the desktop the question could not be asked at all — and which
blocks the render loop and cannot be styled anywhere. It is a real dialog now.

Two of its assertions need a second browser context, because they are about
capabilities a viewport cannot simulate. A touch device is one: Chromium reports
`hover: hover` however narrow the window is, so nothing at 390px can tell you whether
a control that only appears on hover exists at all on a phone. The rail's per-pill
*hide* control was `hidden` and revealed on `group-hover`, so on a real phone a bucket
Winnow kept over-firing could not be silenced from anywhere — Settings lists what has
already been hidden, and the palette is a list of places to go, not of things to
change. `hasTouch: true` is what makes `(hover: none)` match, and the suite opens a
context with it to check.

The other is geometry. The reader's pane is a flex child, and without `min-w-0` its
base size is its content — 733px of `max-w-[68ch]` body text. On a 390px phone that
overflowed the line, `body { overflow: hidden }` clipped it, and the message was
unreadable: every line ran off the right edge with no way to reach the rest, and the
six action buttons went with it. So a phone could read half a message and do nothing
with it. The suite measures the article's right edge against the viewport, and asserts
that no labelled control anywhere in the app is off-screen unless it sits inside a
deliberate horizontal scroller.

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
bucket back; Settings also lists them under "Hidden buckets", and the undo strip
offers the same way back.

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
no button. The one that *can* be acted on and was not — an empty mailbox, where the
answer is "look again" — now offers that, and only when there is an account to sync
with, because offering it over the demo mailbox would be a button that cannot do
anything.

**The rail gets its own row.** It used to share one with the mailbox nav, the search
box, seven tool buttons and the position cluster. Every one of those is `shrink-0`
because it must not reflow, so the rail — the only elastic child, and the product's
entire opinion about your mail — absorbed the whole shortfall and showed three pills
of twenty-eight at 1440px. Giving it a full-width row costs about thirty pixels of
chrome and shows eleven. It also removes the second copy of the strip: two renderings,
two scroll containers, two sets of overflow fades, and an `inert` attribute, for one
control list.

**Day sections are conditional on the sort.** "Today" is a claim about adjacency —
everything above this arrived today — and only a date-sorted list can make it. Sorted by
score or sender the days interleave, so the runs came out as `Today / This week /
Today`, four headers none of which was true, and because each section was keyed on its
*bucket name* every repeat was a duplicate React key. A non-chronological list now gets
one unlabelled section: the rows still carry their own day bucket, which is what chooses
between "10:42" and "Mar 3" in the corner, so the information survives and the noise
does not.

**One name per folder.** The palette used to carry its own labels and drifted: it said
"Bin / Trash" for the folder every other surface called "Trash", and "Bin" appeared
nowhere else in the product. The labels come from `MAILBOX_LABEL` now, so there is one
spelling of a destination in the whole app.

**The app mark is a component, not an asset.** It was `<img src="./relayLight.svg">` in
two places — a black mark on a white shape, which in dark mode rendered as a black
shape on a near-black header and effectively disappeared. The name said `Light`, which
was the tell: there was no dark version and no branch anywhere that chose one. Inlined
and driven by the theme tokens it follows `systemDark` with no second file, and the
browser tab — which is not ours to theme — gets a `prefers-color-scheme` pair instead.

**Every verb has a way back, and the two that did not now do.** A star is a toggle, a
filed message reappears where it went, a filter has its own pill. `⇧U` — clear the read
state of a whole mailbox — had nothing, and it is the one keystroke in triaging whose
mistake cannot be walked back. It now offers an undo that restores exactly the messages
it touched, reads live state so an interleaved move is not clobbered, and drops itself
when you change mailbox, because its label names one.

Muting a bucket is the other, for a less obvious reason. A mute was already reversible —
the pill stays in the rail with a ↺, and Settings lists it — but the muted pill is
sorted to the *end* of the rail, because a muted pill is not filterable and leaving it in
place would silently repoint every digit shortcut after it. So the pill you clicked left
a twenty-seven-pill strip you have probably not scrolled, and the whole visible effect
of the click was that something disappeared. It says what it hid and puts the Undo under
the hand that did it. Writing the test for it immediately caught a second bug: taking
that undo left the strip on screen with a button that no longer had a handler behind it,
so `restoreFilter` now drops the offer whichever of the two routes you came back by.

**Remote content is loaded one message at a time.** The reader's escape hatch used to
be a preference change wearing a per-message label: the button said "Load images",
sat under the message you were reading, and turned on `loadRemoteContent` — so every
later message from then on rendered a sandboxed iframe of sender-supplied markup, and
the choice survived a reload. Nobody clicking that under one message means it for
everyone, forever. It is one message now, and the count beside it is exact: an inline
`data:` logo and a `background="#fff"` are not remote references, and counting them
made the note a false reassurance about your own privacy.

**A pill's count and its shortcut do not look like one number.** "Important 26 1"
reads as twenty-six-one. The digit is drawn as a keycap — the same chip the shortcut
sheet uses — so the two roles separate at a glance.

**The ten weight sliders are split by the distinction the model already makes.**
They were one column of ten identical rows, so finding one meant reading all ten
labels. They are now grouped by `isPenalty` — the same function the learning loop uses
to decide which way to nudge — into what raises importance and what lowers it. That
halves the search space and says something true about each half, without a second
list to keep in step.

**The conversation list leads with the message's own words.** In a thread the subjects
are the same string three times over, so the one column that identified which message
you were about to open carried no information at all, while the thing that does differ
was nowhere on screen. The subject is still shown when it genuinely changed, because
that *is* information.

**The reader header stacks until the window can afford a row.** Six 28px icons and a
`shrink-0` toolbar need about 200px, and the pane is 37.9% of the window — so side by
side the sender's name is what gives way. It read "Dana Whitfi…" on a phone and "Dana
at North…" at 1100px, and the reader's own sender line is the wrong place to be
stingy: it is the first thing you read and the thing you check the list row against.
The threshold is 1200px rather than `lg` because `lg` is the width at which the pane
*appears*, not the width at which it fits — at 1024 the pane is 388px, which is exactly
the case that needed fixing.