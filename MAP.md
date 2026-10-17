# Winnow Project Map

Where things are, and — where it matters — why they are there instead of
somewhere else. It describes the code as it is today, not an architecture promise.

`README.md` is the product. This file is the map: for someone reading the source
rather than running the app.

| | Files | Lines |
| --- | --- | --- |
| `web/src/core` — product logic | 100 | 33,426 |
| `web/src/ui` — the screen | 46 | 11,537 |
| `web/src/platform` — the browser/desktop boundary | 8 | 1,893 |
| `web/src/App.tsx` + `main.tsx` + `index.css` | 3 | 3,067 |
| `native/src-tauri/src` — Rust | 9 | 2,076 |
| `proxy` — optional render service | 6 | 1,526 |
| **total** | **172** | **53,525** |

Of that, 61 test files and 20,287 lines — roughly two-fifths of the source, and
none of it needs a DOM.

---

## 1. The shape

```
web/                The whole product: logic, UI and the Gmail client, in one bundle.
  index.html        Vite entry. Loads /src/main.tsx and /theme-boot.js.
  public/
    theme-boot.js   Sets data-theme before React exists, so the first paint is the right colour.
    relay*.svg      Light/dark tray relay artwork.
    demo-avatars/   Seven SVGs for the seeded demo mailbox. No network, no Gravatar.
  src/
    core/           Pure TypeScript. No DOM, no React, no platform calls.
      gmail/        The Gmail REST API: quota, retries, sync, MIME.
      session/      OAuth, the token/credential stores, the offline cache.
      classify/     Message → signals, and the list pipeline.
      learn/        Stars and hidden buckets → weights.
      model/        Email, signals, filters, profile, appearance, ids.
      contacts/     People API sync, the contact index, suggestions.
      mail/         Sanitising, quoting, dates, codes, unsubscribe, keybinds.
      store/        The store, its derived view, preferences.
      avatars/      Contact photos, Gravatar, BIMI logos, the local picture caches.
      data/         The demo mailbox seed.
    platform/       The boundary. Two implementations (web.ts, desktop.ts), one interface.
    ui/             React components and the pure helpers beside them.
  scripts/          check-version.mjs, bump-version.mjs, smoke.mjs, bundle.mjs — see §11.
native/src-tauri/   Tauri v2 shell. Rust. Native bits only. README.md there explains
                   the IPC naming rule, the loopback port and why the build is a
                   script.
proxy/              Optional render proxy. Separate Node service, see §9 and its README.
docs/               google-setup.md — the step-by-step for a BYO OAuth client.
```

Two entry points, no more: `web/src/main.tsx` for the app (both hosts), and
`native/src-tauri/src/main.rs` → `winnow_lib::run()` for the desktop shell.

---

## 2. Where to start reading

Six files, in this order, and you will have the shape of the product:

| Read | Because |
| --- | --- |
| `web/src/core/store/store.ts` | The only file that knows about all the state. It owns one derived pass (§5.1) and everything else reads its snapshot. |
| `web/src/core/classify/classify.ts` | What a message *is*. Pure, synchronous, and the oldest code in the project. |
| `web/src/core/gmail/sync.ts` | How the mailbox gets here at all: full vs incremental, cursor, caps. |
| `web/src/platform/types.ts` | The thirteen methods that are allowed to differ between browser and desktop. |
| `web/src/App.tsx` | The keyboard, the theme and the layout, and the three pieces of state that live here rather than in the store. |
| `native/src-tauri/src/commands.rs` | The whole native surface, thin enough to read in one sitting. |

If you only have five minutes: `core/classify/classify.ts` and
`core/classify/filters.ts`. They are the product.

---

## 3. The one rule: dependency direction

```
ui  →  platform  →  core
                      ↑
native  (reachable from platform, and nothing else)
```

Three consequences, and each is load-bearing:

- **`core/` never imports `ui/`.** It does not know React exists. The store is
  driven by `useSyncExternalStore`, not by a provider.
- **`core/` never touches `window` or `document`**, with the one runtime
  exception in the table below. This one is enforced by the test runner rather
  than by convention: `vitest.config.ts` sets `environment: "node"`, so a core
  module that reaches for `window` fails with a clear `ReferenceError` instead of
  quietly passing because a jsdom shim answered it.
- **`core/` never imports Tauri.** Tauri appears only in `platform/desktop.ts`.

Three honest exceptions, all deliberate:

| Exception | Why |
| --- | --- |
| `core/session/*` takes a `Platform` as a constructor argument | The session is the seam: it is handed the host's implementation and cannot ask what host it is on. These imports are `import type` and erase at compile time. |
| `core/session/errors.ts` imports `isTauri()` from `platform` | One runtime import, and it is a pure predicate over `window.__TAURI_INTERNALS__`. It exists so an OAuth failure message can say "wrong client type for this build" instead of something generic. |
| `proxy/` imports `core/mail/sanitize.ts` | The proxy is a separate deployable that must produce byte-identical sanitising to the app. Sharing the sanitiser is the point; it is why the proxy's imports are the only ones that leave `web/`. |

Two of the three rules are one grep each:

```sh
grep -rn "from \"\.\./ui\|from \"\.\./\.\./ui" web/src/core   # must be empty
grep -rn "@tauri-apps" web/src/core                          # must be empty
```

---

## 4. One message's journey

The path a single email takes, with every hop named. This is also the debugging
order for "why is this message wrong".

```
1. Gmail history.list / messages.list          core/gmail/client.ts
     one QuotaBucket, 4800 units/min, burst 1000; every retry charges again
2. messages.get?format=metadata                core/gmail/client.ts
     then payload → Email                       core/gmail/mapper.ts
       From is parsed not trusted; internalDate beats the Date header;
       plain text wins over HTML
3. written to the mirror                        core/session/session.ts (localCache)
     winnow.gmail.cache.messages, debounced 250ms; a loaded body is never
     overwritten by a metadata-only copy
4. handed to the store                          core/store/store.ts (applySync)
5. classified                                   core/classify/classify.ts
     pure, synchronous, one message in / one EmailSignals out;
     spam likelihood is computed *before* importance, because importance pays for it
6. profile rebuilt from inbox + trash           core/model/profile.ts
7. derived: search → filter → sort → group     core/classify/pipeline.ts
     signals come from a map the caller built; the classifier never runs here
8. rail ranked, counts computed                 core/classify/filters.ts
9. one snapshot                                 core/store/store.ts (derive)
10. React                                       web/src/App.tsx → useStore → components
```

Opening it takes a second path: `store.loadBody` → `backend.fetchBody` →
`client.messageBodyHtml`, written back into the mirror so the message reads
offline afterwards. Bodies are only fetched for what is on screen, plus a
prefetch window — `BODY_RETENTION = 500` messages, the newest 50 unread, and
±2 rows around the open one.

---

## 5. `web/src/core` — product logic

### 5.1 `store/` — the one derived pass

`WinnowStore` is a plain class, not a React store. It publishes through
`subscribe` / `getSnapshot`, and `ui/useStore.ts` is the only bridge.

**The central decision.** Everything the screen shows is computed once per change
in `derive()`: profile → signals → search → filter → sort → thread grouping →
rail ranking → inbox counts → attention line → contact index. One answer, handed
to everyone, so nothing on screen can disagree with anything else on screen.

The snapshot is `StoreState & { view: MailboxView; key: string }`. The `key` is a
monotonic string; `useStore` caches the snapshot against it, because
`getSnapshot` recomputes the whole view and returns a new object every call —
without that cache React loops forever. `core/store/scale.test.ts` asserts the
memo: a clock tick classifies nothing, and a weight change reclassifies.

**Why the counts are over the inbox, not the current result.** `inboxCounts` is a
claim about the user's mail, not about the rows currently rendered. Ranking the
rail against anything else reshuffles it the moment you open a bucket.

The public surface is ~80 methods, grouped:

| Group | Methods |
| --- | --- |
| Lifecycle | `connect`, `refresh`, `retryConnection`, `signOut`, `restoreState`, `markDemoMode`, `startClock` |
| Backend passthrough | `sync` via `MailBackend`; `toggleStar`, `moveToMailbox`, `setRead`, `deletePermanently`, `sendReply`, `fetchAttachment`, `fetchBody` |
| Navigation | `setMailbox`, `select`, `openCursor`, `closeReader`, `moveCursor`, `openRow`, `focusMessage`, `searchSubject`, `listTitle`, `setOverlay`, `moveNavigation`, `activateNavigation` |
| Filters | `toggleFilter`, `clearFilters`, `setFilters` (private) |
| Mutations | `archive`, `move`, `trash`, `toggleRead`, `markAllRead`, `markUnreadAndMoveOn`, the `*Many` batch variants, `undoLast` |
| Senders | `blockSender`, `unblockSender`, `muteSender`, `unmuteSender`, `showSender`, `isSenderMuted` |
| Bodies | `loadBody`, `prefetchBodies`, `hasLoadedBody`, `scheduleReclassify` |
| Offline storage | `saveMailboxOffline`, `declineMailboxStorage`, `dismissStoragePrompt` |
| Learning | `resetLearning`, `setPreferences`, `setSortBy`, `setGoogleContacts` |

Two behaviours worth knowing before touching it:

- **Every mutation goes through `mutate()`,** which snapshots for `undoLast()`
  and drops the read cursor when the row under it leaves the screen. An undo that
  cannot restore exactly what it touched is not an undo.
- **`signOut()` keeps what is about the person, drops what is about the account.**
  Mail, unread state, active filters and the account go; preferences, blocked and
  muted senders, and everything Winnow learned stay, so signing back in finds the
  app tuned. The reason is in the code and it is the right reason: the learning is
  not the account's.

`preferences.ts` holds the `Preferences` shape and its `localStorage` codec;
`retiredKeys.ts` deletes keys from older builds on launch (currently
`winnow.mutedFilters.v1`) so a stale list cannot linger.

### 5.2 `classify/` — what a message is

| File | Job |
| --- | --- |
| `classify.ts` | `classifyEmail(email, profile, weights) → EmailSignals`. Pure and synchronous, so a cached classification stays valid across restarts. Also exports `contentBag`, `inboxSearchBag`, `matchesSocialDomain`, `senderRankBonus`, `classifyAll`. |
| `heuristics.ts` | The vocabulary: ten `KeywordTable`s, one `SOCIAL_DOMAINS` table, and the regexes (`promoRegex`, `phishingRegex`, `coercionRegex`, `clickHereRegex`, `financeRegex`, `needsActionRegexes`, `replyRequestRegex`). |
| `text.ts` | `PhraseMatcher` and `KeywordTable`. Word-bounded, never `String.includes` — `otp` inside `hotel` is the reason. |
| `filters.ts` | `matchesBuiltin` / `matchesFilter` / `countAllFilters` / `rankFilters`. One predicate, shared by the list, the rail ranking and the badge renderer, so a filter and its badge cannot disagree. |
| `scoring.ts` | The **Smart Score**, 0–100, used only for ordering. Fixed, not learned. `recencyWindow` + `relativeRecencyBonus` measure against the newest message in the set, never the wall clock. |
| `weights.ts` | The ten learnable weights, their clamped ranges, and `nudgeWeight`, which returns the *same object* when a move would clip so callers can use identity to detect change. |
| `pipeline.ts` | `runInboxQuery` (search → filter → sort) and `groupThreads`. The hottest function in the app; the classifier never runs inside it. |
| `attention.ts` | The one-sentence triage line. Derived from signals the classifier already produced, so it cannot disagree with the rail and costs no request. |

**The signal set** (`model/signals.ts`): twelve booleans — `security`,
`newsletter`, `promotional`, `urgentText`, `needsAction`, `finance`, `codes`,
`shipping`, `travel`, `events`, `social`, `longRead` — plus `spamLikelihood` and
`importanceScore`. Observations and judgements, kept in one object on purpose.

**Order inside `classifyEmail`, and why it is that order:**

1. Bags and bias computed once (`contentBag` excludes the sender on purpose: a
   mailbox called `newsletter@…` is not a newsletter).
2. Security and bulk gates → marketing → urgency → asks.
3. Semantic buckets, each gated so `security` wins over `codes`, `promotional`
   over `shipping`, and so on.
4. Spam likelihood accumulates: empty body, sender tells, phishing or
   click-here, coercion, keyword stack (capped 0.35), shouting, trash bias.
5. Importance starts at 50 and **pays for** the spam likelihood already computed.

**The spam rule that keeps the bucket usable.** `phishingRegex` deliberately
excludes "unusual sign-in" — banks send that about genuine fraud — and
`coercionRegex` requires a *demand* alongside the threat, because a bucket that
cries wolf is the only way to make it useless. `coercion` is capped at 0.45 so
two coercive phrasings cannot clear the threshold alone.

**Weights and ranges** (`weights.ts`, in the order Settings shows them):

| Key | Default | Range |
| --- | --- | --- |
| `starBoost` | 22 | 0–40 |
| `security` | 16 | 0–40 |
| `urgency` | 18 | 0–40 |
| `actionNeeded` | 12 | 0–40 |
| `finance` | 7 | 0–20 |
| `newsletterPenalty` | 5 | 0–20 |
| `promoPenalty` | 11 | 0–40 |
| `spamSensitivity` | 44 | 0–80 |
| `quietContactPenalty` | 6 | 0–20 |
| `topSenderBoost` | 18 | 0–40 |

**Why two scores.** The Smart Score is fixed and the importance score is learned,
deliberately. Sorting by the learned score would reorder the inbox every time
somebody nudged a weight. They share `senderRankBonus`, so they agree about *who*
matters and disagree about how much each signal is worth.

### 5.3 `learn/` — the only training data

`LearningModel` learns from three events: `starred`, `unstarred`, and
`filter_rejected` (the last is read from old snapshots and cannot be created any
more). One star moves each touched weight by exactly `LEARNING_STEP = 1`, clamped
to its range, and records a `FeedbackEvent`.

- `activeSignals` on an event is the list of **weights that event moved**, not
  the signals on the message. An empty array is a real answer.
- `predictedImportance` is the score *before* the star was applied. `recordStar`
  must be called before `email.starred` flips, or the model learns from its own
  output.
- `starBoost` never moves, so a star cannot feed its own signal.
- `spamSensitivity` moves outside the "any touched signal" gate, in both
  directions, so starring then unstarring a lure cancels exactly.
- The log is capped at `MAX_EVENTS = 400`, oldest dropped, and kept across a
  reset — it is the audit trail, and Settings → **How Winnow sorts** renders it.
- `fromSnapshot` never throws. A corrupt snapshot costs the user their tuning; a
  thrown error costs them the app.

### 5.4 `model/` — the vocabulary

| File | Holds |
| --- | --- |
| `email.ts` | `Email` (product view) vs `RawEmail` (wire view), `Mailbox = "inbox" \| "archive" \| "sent" \| "trash" \| "spam"`, `MAILBOX_LABEL`, `EmailCategory`, `Contact`, `Attachment`, `Draft`, plus the loaded-body helpers (`isBodyLoaded`, `keepLoadedBody`, `withLoadedBody`) and `withCode`. |
| `signals.ts` | `BUILTIN_FILTERS` (21, in rail-catalog order), `FILTER_LABELS`, `PERMANENT_FILTERS = ["important", "shipping"]`, `NAVIGATION_ITEMS`, `UNSAFE_THRESHOLD = 0.4`, `IMPORTANT_THRESHOLD = 56`, `isUnsafe`, `isImportant`, `badgeFilters` (the chips in a reader) and `rowIndicators` (the at-most-one word a list row carries). |
| `profile.ts` | `buildUserProfile(inbox, trash)`: per-sender trash bias (unbounded in the profile, clamped to `MAX_TRASH_BIAS = 0.35` where used), top six correspondents, the quiet tail, and first-time senders. Deterministic, and ties break on the sender name — a ranking that hides mail cannot be a shuffle. |
| `appearance.ts` | `APPEARANCES` (`system \| light \| dark \| oled`) and `ACCENT_THEMES` (`space \| plum \| ember \| aurora`). Names live in `core` because the store persists them and `core` does not import from `ui`. |
| `ids.ts` | `hashId` (FNV-1a/64 truncated to 53 bits, deterministic so a cached classification survives a restart), `threadKey`, `localId`. |

### 5.5 `gmail/` — the wire

| File | Job |
| --- | --- |
| `dto.ts` | The API's JSON and nothing else, plus `GMAIL_API`, `GOOGLE_TOKEN_URL`, `GOOGLE_AUTH_URL`, the base64url codec, `GMAIL_SCOPE`, and `LABEL`. API changes land here and in `mapper.ts`, nowhere else. |
| `client.ts` | The typed `fetch` wrapper. Owns quota pacing and retries. Every verb Winnow uses: `profile`, `list`, `message`, `messageBodyHtml`, `history`, `addLabels`/`removeLabels`, `archive`, `markRead`, `setStarred`, `trash`, `restore`, `markNotSpam`, `deletePermanently`, `send`, `attachment`, `draft`, `listDrafts`, `createDraft`, `updateDraft`, `sendDraft`, `deleteDraft`. |
| `sync.ts` | `GmailSyncEngine`: full vs incremental, the cursor, the five capped views, batching, partial publishing. Also defines the two interfaces everything else is written against: `MailboxCache` and `CursorStore`. |
| `mapper.ts` | Gmail message → `Email`. Parses `From` rather than trusting it, prefers plain text over HTML, keeps attachments as metadata, and uses `internalDate` over the `Date:` header. |
| `mime.ts` | RFC 822 out: `buildMime`, `messageIdFor`, `replyReferences`. Getting `Message-ID` / `In-Reply-To` / `References` wrong threads the reply in the sender's account and nowhere else. |
| `tokens.ts` | `TokenManager` over a `TokenStore`. Single-flight refresh, a generation counter so a refresh landing after sign-out is dropped, and `invalid_grant` handled as re-auth rather than retry. Sign-out also revokes the grant at Google (`revokeGrant`): fire and forget with a 5 s timeout, never on an `invalid_grant` clear or in the demo. |
| `pkce.ts` | RFC 7636 PKCE plus `state`, `buildAuthorizeUrl`, `parseRedirect`, `stateMatches`. The verifier never leaves the app; only the challenge does. |
| `pool.ts` | `mapPool` and `TaskQueue` — bounded concurrency, in place of Gmail's `/batch` endpoint (a pool reuses the ordinary request path, including the quota bucket). |
| `people.ts` | The People API client for the two contact listings, with its own quota bucket (60/min) and typed errors: `ExpiredSyncToken`, `PeopleScopeMissing`, `PeopleApiDisabled`. |
| `syncFake.ts` | Test-only fake with real latency. Not imported by the app; it lives beside the engine because the parallel and bench suites share it. |

**Quota and retry numbers, in one place** (`client.ts`): `MAX_PAGE_SIZE = 200`,
`UNITS_PER_MINUTE = 4800`, `BURST_UNITS = 1000`, `MAX_RETRIES = 6`,
`MAX_BACKOFF_MS = 64000`, `MAX_SERVER_RETRIES = 3`. `costOf` charges 100 for
send, 20 for an attachment or a message fetch, 10 for delete, 2 for history, 1
for the profile, 5 otherwise. Over-charging a genuinely pricier endpoint errs
toward being more polite, never less.

Two behaviours that are easy to get wrong and are pinned by tests: a 401 gets
**exactly one** forced refresh and one replay, and a rate-limit response drains
the bucket rather than sleeping alone, so the rest of the burst stops.

**Sync, in one paragraph.** No cursor → full sync: profile first (so anything
arriving while paging is caught by the next incremental), then five views —
`in:inbox` uncapped because the inbox is the product, `in:sent`,
`-in:inbox -in:trash -in:sent -in:draft -in:spam`, `in:trash`, `in:spam`, each
capped at 500 — fetched eight at a time, upserted in batches of 25, with the
inbox published as soon as there are 25 rows and at most every 750 ms after.
With a cursor → read *all* history pages first so a message touched by three
records is fetched once, then re-fetch the union. Re-fetch, never apply the diff:
a diff is something that can drift from the server's truth. The cursor advances
only when nothing failed and the cache actually reached disk.

**`HISTORY_TYPES` are sent as repeated parameters**, not one comma-joined value —
a single joined value is one unknown enum and Gmail answers 400.

### 5.6 `session/` — the seam

`GmailSession` owns the backend; the store owns state. Keeping them apart is why
the store can be driven by a demo seed with no session at all.

| File | Job |
| --- | --- |
| `session.ts` | `localCache()` and `GmailSession`. Sign-in, refresh, contacts grant, `signOut`, and `backend()` — the object the store talks to. |
| `bridge.ts` | `SessionBridge`: a flat façade the UI uses, plus the two side effects the session cannot do (`store.signOut` when the client changes or the user signs out). |
| `credentials.ts` | The user's own OAuth client: validation, the two stores (web `localStorage`, desktop keychain), and `testConnection`, which posts a deliberately invalid code and reads the verdict. |
| `clientJson.ts` | Import of Google's downloaded `client_secret_….json`. 64 KB cap, and the exact list of refusals and warnings below. |
| `redirect.ts` | Web-only redirect parsing as pure functions over a query string. A code with no `state` returns `null`. |
| `pendingAuth.ts` | The PKCE verifier in `sessionStorage`, as an array keyed by `state` so two tabs cannot clobber each other. Single-use: `take` removes. |
| `errors.ts` | `describeFailure` — the message and hint for each failure kind. |

**The offline cache** (`localCache`). A `Map<GmailId, Email>` mirror in memory,
with `localStorage` treated as a *sink*, not a store: mutations coalesce into one
250 ms write. The alternative — read, merge and re-serialise the whole mailbox
per upsert — measured 1.36 s and 6.15 MB of allocation over a 100-upsert sync.
Writes are individually guarded because private mode and a full quota *throw*
rather than return; a failure is recorded and surfaced by `flush()` instead of
being swallowed. Past roughly 2,000 messages the origin's ~5 MB quota is the
ceiling, and `persistCache()` is the answer: it asks for persistent storage and
reports honestly when the write still did not stick.

**`signOut()` order matters:** tokens → contacts → pending auth → message cache
→ cursor. The cursor is last for a specific reason — a cursor left over an empty
cache makes the next sign-in sync incrementally into an empty mailbox.

**`clientJson.ts` refusals,** in order: over 64 KB; not JSON or not an object; a
service account; both or neither of `installed` / `web`; missing `client_id`; an
id without the `.apps.googleusercontent.com` suffix; a client type this build
cannot use (a `web` client on the desktop, an `installed` client in the browser);
a secret that is not a string; a secret that is required and blank, or that is
the client id pasted into the wrong field. Warnings are non-fatal: an odd
`project_id`, unknown `auth_uri` / `token_uri`, a desktop file listing
non-loopback redirects, a web file that does not register this page's redirect
URI or origin. The secret never appears in an error, a warning or a log.

### 5.7 `contacts/` — three layers and two helpers

| Layer | File | Job |
| --- | --- | --- |
| Wire | `gmail/people.ts` | The People API. Both scopes or neither — half the feature failing silently is worse than not offering it. |
| Sync | `contacts/google.ts` | Snapshot in `winnow.google.contacts.v1`, incremental by sync token, all-or-nothing per listing, saved contacts persisted first. An expired token is a quiet re-list, not an error. |
| Index | `contacts/index.ts` | `buildContactIndex(emails, {selfAddress, googleContacts})` — derived from `state.all` on every pass, so it cannot disagree with the mail. Sent mail counts double; recency decays over 45 days against the newest message in the index; a saved Google contact adds an additive prior. |
| Query | `contacts/suggest.ts` | `suggestContacts` — capped at 8, ranked by `score × fit`, separate from matching so a ranking change cannot change what counts as a match. |
| Text | `contacts/addresses.ts` | `foldText`, `isValidAddress` (RFC 5322 dot-atoms, and at least two domain labels), `parseRecipients` — which splits on commas, semicolons and newlines but *not* spaces, because the `Name <addr>` form depends on them. |

### 5.8 `mail/` — everything a message needs on the way in and out

| File | Job |
| --- | --- |
| `sanitize.ts` | The allowlist sanitiser. 1,400 lines: a hand-written scanner, a CSS walker, and the document builder. `MAX_DEPTH = 64`, `MAX_OUTPUT = 2 MiB`, `MAX_DIMENSION = 4096`. Drops `<script>`, `position: fixed\|sticky`, `z-index` and `@font-face`; `allowRemote` defaults to false. |
| `html.ts` | HTML → text, `decodeEntities`, `sanitizeDisplayName` (strips C0/C1, zero-width, bidi; 128 chars), `parseAddressHeader`, and `remoteReferences` — the remote-image counter the reader offers to show. |
| `reply.ts` | `buildReply`, `buildForward`, `quotedBody`, `stripQuote` (a quote is stripped only while it is still an untouched *suffix*). |
| `datetime.ts` | `dayBucket` counted from calendar fields so a 23- or 25-hour DST day is still one day; `formatRowTime`, `daySections`, `formatRelative`, memoised formatters and a 4096-entry cache. |
| `otp.ts` | `detectCode(subject, text)` with explicit false-positive rules for dates, times, prices, percentages, phone numbers, years, postcodes and order numbers. `CODE_CHIP_MS = 5 min`. |
| `unsubscribe.ts` | RFC 2369 + RFC 8058. Keeps at most one https URL and one mailto; `oneClick` is only set when the POST header says so, and Winnow never sends the POST (CORS would refuse it from a web page). |
| `imageConsent.ts` | `ImagePolicy = "ask" \| "always" \| "never"` and `resolveImageConsent`. Three states because there are three intentions, and a grant is for one message id only. |
| `proxy.ts` | The optional render proxy client. The base URL is read once from the **build-time** `VITE_RENDER_PROXY` constant, http/https only — a runtime setting pointing the app at an arbitrary URL is a remote-administration hole. The returned document is mounted in `sandbox=""`. |
| `keybinds.ts` | `BINDINGS` as data, plus the router. Four imperative carve-outs: not ready, system modifiers, text editing, and modal grammars for the cheat sheet and the mailbox palette. `Masthead` prints its toolbar hints from the same array, so a button cannot advertise a shortcut the router will not take. |

### 5.9 `avatars/` and `data/`

- `bimi.ts` looks up `default._bimi.<domain>` over DNS-over-HTTPS at
  `cloudflare-dns.com` and shows its `l=` logo — always through `<img>`, https
  only, never inlined. The `a=` certificate is not verified, and the code says so.
- `logoCache.ts` keeps answers for a week (a day for "no record"), rate-limits,
  and is wiped on sign-out or when the setting goes off. Its `PictureCache` is
  shared with `gravatar.ts`.
- `gravatar.ts` is opt-in Gravatar photos: SHA-256 of the trimmed, lower-cased
  address, `?d=404`, probed as a credential-less, no-referrer `<img>`; never for
  malformed, no-reply or relayed ("via") senders.
- `photos.ts` is contact photos, opt-in, from the People API only.
- No favicon lookup, and Gravatar only behind its own switch: each tells a third party who mails you.
- `data/demo.ts` seeds **57 messages** against a fixed instant
  (`DEMO_NOW = 2026-05-09T18:00Z`), plus `DEMO_TRASH` (12 records),
  `DEMO_CONTACTS`, `DEMO_BRAND_LOGOS` and `demoNewsletter.ts` for the rich view.
  43 of the seeds declare the bucket they exist to demonstrate, and
  `DEMO_EXPECTATIONS` turns those declarations into the table the classifier
  tests assert against — so adding a bucket means adding a seed, or the test
  fails. `demoMailbox(now)` shifts the whole seed onto the real clock so recency
  and day sections behave in a live run.

---

## 6. `web/src/platform` — the boundary

`types.ts` is the whole contract. Thirteen methods, and a browser cannot do seven
of them properly:

| Method | Browser | Desktop |
| --- | --- | --- |
| `info()` | constant `WEB_INFO` | `invoke("app_info")`, memoised |
| `tokenStore()` | `localStorage["winnow.gmail.tokens"]` | keychain `gmail.tokens` |
| `credentialStore()` | `localStorage["winnow.google.oauthClient"]` | keychain `google.oauth-client` |
| `beginSignIn()` | `sessionStorage` + `location.assign` | `oauth_begin` / `open_external` / `oauth_await` on an ephemeral loopback port |
| `cancelSignIn()` | drop the session key | `oauth_cancel` |
| `notifyNewMail()` | `Notification` with a shared `tag` | `notify_new_mail`, grouped |
| `requestNotificationPermission()` | `Notification.requestPermission()` | `request_notification_permission` |
| `setUnreadBadge()` | `document.title` | dock badge + tray tooltip |
| `setBackgroundSync()` | `setInterval`, floor 30 s | a Rust thread, 30–3600 s |
| `onBackgroundTick()` | module handler set | `listen("winnow://sync-tick")` |
| `openExternal()` | `window.open(..., "noopener,noreferrer")` | `open_external` (https only) |
| `saveFile()` | blob + `<a download>`, returns `null` | `save_attachment`, returns a path |
| `focusWindow()` | `globalThis.focus()` | `unminimize` + `show` + `setFocus` |

Supporting files:

- `index.ts` — `isTauri()`, `createPlatform()`, and the module-level `platform`
  singleton everything else imports.
- `foregroundSync.ts` — polls every 10 s while the document is visible and
  focused, and fires at once on focus regain, tab-visible and `online`. There is
  no server to push from, and an empty incremental sync costs 2 quota units. The
  same code runs in both hosts because a Tauri webview fires the same DOM events.
- `web.ts` adds `readRedirectFromLocation()` and `pendingSignInState()`;
  `desktop.ts` adds `onDeepLink()` and `onTrayAction()`.

**The IPC naming rule, which has cost real time.** Tauri rewrites *argument* keys
from camelCase to snake_case but never rewrites *return values*. So `AppInfo` has
explicit `#[serde(rename)]` on all four capability flags (serde would emit
`nativeOauth`, which reads as `undefined` at the call site), `OAuthBegin` returns
`authorize_url` and the web layer reads `authorize_url`, and `NewMail` is
`rename_all = "camelCase"` so `messageIds` survives. `desktop.ts`'s
`normaliseAppInfo` accepts either spelling on the way in.

---

## 7. `web/src/ui` — the screen

`App.tsx` is 2,327 lines and is the only file that knows about the store, the
platform and React at once. It owns exactly three things: **the keyboard** (one
`keydown` listener on `window`, registered once with an empty dependency array,
reading current values through refs), **the theme** (resolved from preference
plus OS, applied as CSS custom properties), and **the layout**.

### 7.1 Components

| File | Responsibility |
| --- | --- |
| `MessageList.tsx` | The windowed, day-sectioned list. Flat item union, memoised rows, heights in a `Map` plus a `ResizeObserver`, pinned day headers painted outside the scroller, drag/⌘/shift selection, long-press, sender and row menus, code chips. At most one signal word per row. |
| `Reader.tsx` | The message pane: back bar, header (avatar → sender menu, sender `h2`, subject as the document `h1`), filter tags with their reasons, the three-way image offer, body, attachments, the conversation, and the phone dock. |
| `MessageBody.tsx` | Renders the body in the chosen `BodyView`: `rich` (sanitised, inline), `plain`, `sent` (`sandbox=""` iframe), `proxied`. The view is per message and is not persisted. |
| `Masthead.tsx` | Sidebar toggle, search, position readout, prev/next/mark-all-read, Compose, and the `FilterStrip`. Its `searchRef` must be the same ref the keybind handler holds, or `/` silently does nothing. |
| `FilterStrip.tsx` | The rail of pills: sticky leading mark, `All`, edge fades and step chevrons. Fades are `pointer-events-none` — a gradient that eats clicks at the edge is the worst possible bug in a filter rail. |
| `MailNav.tsx` | The sidebar overlay: Inbox with its thread count, then the other four mailboxes in `MAILBOX_ORDER`, an account footer carrying Settings, and the progressive scrim blur. Always mounted so it can animate out; `role="dialog"` and `inert` only while open. |
| `SettingsPanel.tsx` | Settings. Sections: Google account, Reading, Appearance, Background, Google contacts, How Winnow sorts, hidden senders. |
| `Composer.tsx` | Reply, forward and new message: recipients, subject, body, ⌘⏎, Send and Discard, the Reply / Reply all toggle and the draft status. Three layouts: docked at the bottom of the reader pane (desktop reply and forward, not modal, its own Escape), a centred sheet (desktop new message), full screen (phone, everything). |
| `GoogleSetup.tsx` | Paste, import by file, drop or paste-into-field; test; save; connect. |
| `ComposeFab.tsx` | The phone's round compose pencil, measured to sit above the dock. Rendered from `App.tsx`, not the phone chrome; shown only over the list. |
| `RecipientField.tsx` | The composer's To, Cc and Bcc fields: chips plus an ARIA 1.2 editable combobox. Nothing is highlighted until an arrow key, Tab only accepts after navigation (WCAG 2.1.1), Escape is consumed only while the list is open. |
| `Overlay.tsx` | `Sheet`, `ConfirmDialog`, `SheetHeader`. Focus moved in and restored on unmount, Tab trapped by `getClientRects()` (because `offsetParent` is null for a fixed element). `ConfirmDialog` exists because `window.confirm` is unimplemented in a Tauri webview. |
| `Menu.tsx` | The WAI-ARIA menu pattern, including submenus. Every other key is swallowed so the app's global shortcuts cannot fire while a menu is open. |
| `menuPlacement.ts` | `placeMenu` and `MenuAnchor` as pure geometry, kept out of the component module so they test without React. |
| `NavigationPalette.tsx` | The `!` palette: inbox, spam, trash, sent, settings. It is a `menu`, not a `dialog`. |
| `PhoneChrome.tsx` | `PhoneTopBar` and `PhoneDock`. Below `sm` the masthead is replaced, not squeezed; all targets are 44 px. |
| `SelectionBar.tsx` | The batch bar, using the same `archiveLabel` and `moveTargets` helpers as the row menu so the two cannot disagree. |
| `Avatar.tsx` | Contact photo → Gravatar → BIMI logo → monogram. Every picture is an `<img>`; the monogram stays present under a loaded logo so a transparent logo does not let the letter through. |
| `ShortcutSheet.tsx` | The cheat sheet, rendered from `BINDINGS`. |
| `CodeCopy.tsx` | The code chip in a row and the code bar in the reader. |
| `ErrorText.tsx` | Selectable failure copy, collapsed under a disclosure when long — the one text in the app a user needs to copy. |
| `ReaderSplitHandle.tsx` | The list/reader divider at `lg` and up: pointer-captured drag, arrow keys, double-click reset. It writes `--wn-reader-split` on `main` so a drag never re-renders the app; `index.css` clamps the pane's width from it. |

### 7.2 Pure helpers worth knowing exist

| File | Why it is separate |
| --- | --- |
| `theme.ts` | Every colour and the machinery that mirrors it to `--wn-*`, plus the contrast functions `theme.test.ts` uses. A screenshot cannot tell you a grey is 3.14:1 on white, which is how `inkSubtle` shipped. |
| `rail.ts` | `buildPills`, `digitFor`, scroll geometry. Separate from `FilterStrip.tsx` because exporting a plain function from a component module breaks fast refresh. An active sender pill is never hidden. |
| `selection.ts` | Selection arithmetic and the `LongPress` state machine (`LONG_PRESS_MS = 450`, `TOUCH_SLOP = 10`, `EDGE_SCROLL_ZONE = 40`). |
| `windowing.ts` | Variable-height windowing arithmetic (`ESTIMATED_ROW_HEIGHT = 53`, `OVERSCAN = 6`). No fixed-height virtualiser, because rows are 53–82 px. |
| `syncStatus.ts` | The sync line and button text as one pure function, with a documented precedence order. |
| `bodyViews.ts` | Which "Show as" options exist for this message — two instead of four when there is no HTML part. |
| `filterColors.ts` / `filterIcons.tsx` | A hue and saturation per bucket (never a finished colour), and one icon + one reason. `important` is a Bookmark, not a star, because the row's star is a control. |
| `senderPictures.ts` / `avatar.ts` / `demoPictures.ts` | Avatar sourcing as a context, plus the pure hash that gives a sender a stable tone. |
| `sidebarOverlay.ts` | The idle-close policy (all seven conditions must be false) and the scrim recipe. |
| `menus.ts` | Both menus' contents as data, so the rules are unit-tested rather than trapped in JSX. |
| `readerSplit.ts` | The reader's share of the width as a fraction (default 0.38, saved under `winnow.readerSplit.v1`), its 280 px list / 360 px reader minimums resolved per width, and the handle's key steps. |
| `useStore.ts` / `useOnline.ts` / `usePhoneLayout.ts` | The three hooks. `useStore` caches the snapshot against the store's key; `usePhoneLayout` publishes the on-screen-keyboard inset as `--wn-keyboard`. |

### 7.3 What lives in `App.tsx` instead of the store

Composer, its autosave and its discard confirmation (a desktop reply docked in the
reader is parked as a draft when the selection moves, rather than asking); the open menu (`kind`, id, ids, anchor,
trigger); the sidebar; the per-message remote-image grant; the sign-in and setup
flow's local state. Overlays (`shortcuts`, `settings`, `navigation`) *are* in the
store, because the keyboard router has to see them.

---

## 8. `native/src-tauri` — the desktop shell

The rule from `lib.rs`: nothing here re-implements product behaviour. If a command
could be written in TypeScript, it belongs in `web/`.

| File | Job |
| --- | --- |
| `main.rs` | Seven lines: `winnow_lib::run()`, plus `windows_subsystem = "windows"` so a release build has no console. |
| `lib.rs` | The real startup: `single_instance` registered **first**, then dialog/opener/notification/window-state, the invoke handler, `on_page_load` revealing the window (skipped with `--minimized`), `setup` registering autostart, OAuth sessions, deep links, tray and scheduler, and `CloseRequested` → hide rather than quit. |
| `commands.rs` | 13 commands, each of which validates, delegates and converts errors to strings. |
| `oauth.rs` | The loopback listener: binds `127.0.0.1:0`, substitutes the real port into `__WINNOW_LOOPBACK_PORT__`, answers one request and stops. |
| `secrets.rs` | Keychain get/set/delete under service `app.winnow.desktop`, one user per secret name. |
| `scheduler.rs` | The tick, 30–3600 s, clamped, joined on retune so two threads can never overlap. |
| `files.rs` | Save dialog → sanitised filename → `spawn_blocking` write. Async is mandatory, not stylistic: blocking the calling thread deadlocks the dialog callback. |
| `tray.rs` | The tray icon and its four items (`sync`, `mark_all_read`, `settings`, `quit`). A left click reveals the window; there is deliberately no "Open Winnow" row duplicating it. |
| `deep_link.rs` | The `winnow://` scheme only. The old OAuth callback scheme was removed: a private-use redirect URI is not something Google hands a desktop client an authorization code for. |

### 8.1 The command surface

| Command | Takes | Gives back | Web side |
| --- | --- | --- | --- |
| `app_info` | — | `AppInfo` (camelCase, four explicit flags) | `info()` |
| `secrets_get` / `secrets_set` / `secrets_delete` | `name`, `value` | `Option<String>` / `()` | token and credential stores |
| `oauth_begin` | `authorize_url` | `{ port, authorize_url }` | `beginSignIn` |
| `oauth_await` | `port`, `timeout_ms?` | `AuthOutcome` (`kind: code \| error`) | `beginSignIn` |
| `oauth_cancel` | `port` | `()` | `cancelSignIn` |
| `notify_new_mail` | `{ title, body, messageIds }` | `()` | `notifyNewMail` |
| `request_notification_permission` | — | `bool` | `requestNotificationPermission` |
| `open_external` | `url` | `()` | `openExternal` |
| `save_attachment` | `filename`, `bytes_base64` | `Option<String>` (path) | `saveFile` |
| `set_unread_badge` | `count` | `()` | `setUnreadBadge` |
| `set_background_sync` | `interval_secs?` | `()` | `setBackgroundSync` |

Four tests in `commands.rs` pin the boundary: only https reaches the shell, the
camelCase payload survives, `app_info` serialises what the webview reads, and the
comparison is against a literal rather than a prefix.

Three decisions in there are worth not rediscovering:

- **The OAuth session stays registered while `oauth_await` waits.** Removing it
  on entry made `oauth_cancel` a no-op, so Cancel became a button that made the
  wait *longer*.
- **The window title is left alone by `set_unread_badge`.** The document owns the
  title; the OS owns the badge. Two owners meant the title flickered.
- **`save_attachment` is `async`.** As a sync command it ran on the main thread
  the save dialog also needs: no panel, no settled promise, a wedged app.

### 8.2 Configuration worth reading before a build

- `tauri.conf.json`: one window, `visible: false`, `dragDropEnabled: false`,
  `frontendDist: ../../web/dist`, and a CSP with `object-src 'none'`,
  `form-action 'none'`, `base-uri 'self'` and a `connect-src` that names exactly
  the Google hosts and `cloudflare-dns.com`. There is no `targets` key, so bundle
  kinds come from `web/scripts/bundle.mjs`, not from here.
- `capabilities/default.json`: deliberately short. `store`, `os`, `autostart` and
  the dialog/opener/notification JS APIs are absent because Rust calls those
  plugins directly and Rust calls are not subject to the ACL.
- `Cargo.toml`: `tray-icon`, `image-png` and `image-ico` (a PNG-only Windows
  bundle builds fine and then has no tray icon), `keyring` with
  `apple-native`/`windows-native`/`sync-secret-service`, and a release profile of
  `opt-level = "s"`, `lto`, `codegen-units = 1`, `strip`.

---

## 9. `proxy/` — the optional render proxy

Off unless built with `VITE_RENDER_PROXY`. It fetches a message's images and
returns a self-contained document, so reading a newsletter does not tell the
sender where you are. `proxy/README.md` is the argument; this is the map.

```
server.ts       node:http, binds 127.0.0.1:8787 by default (PORT, HOST env).
                GET /health · POST /render · GET /asset/<sha256-prefix>
                CORS by exact origin list (ALLOWED_ORIGINS, empty = same-origin).
                Hardened headers: nosniff, a strict CSP, Referrer-Policy: no-referrer.
assets.ts       planAssets() over the RAW html, before sanitising, in five shapes:
                src/background/poster, srcset, style="" url(), <style> url(),
                @import (counted, never fetched). href is not a request yet.
addressPolicy.ts  checkUrl: scheme → credentials → address literal. Then the
                caller resolves and judges EVERY address the name returned.
transport.ts    guardedLookup is passed to http.request as the lookup option, so
                the resolver IS the check — for the first hop and every redirect.
```

The numbers: `MAX_ASSETS_PER_DOCUMENT = 60`, `MAX_ASSET_BYTES = 8 MiB`,
`ASSET_TIMEOUT_MS = 8000`, `ASSET_TTL_MS = 15 min`, `MAX_CACHED_ASSETS = 512`,
request bodies capped at 16 MiB. Fetches are sequential on purpose. SVG is
refused: it can carry code, and a re-hosted one would be served from the proxy's
own origin. Blocked ranges cover RFC 1918, CGNAT, loopback, link-local including
`169.254.169.254`, and the documentation and benchmarking blocks, in both
families — plus IPv4-mapped, NAT64 and 6to4 forms, where the *wrapped* address is
judged as IPv4.

---

## 10. Where state lives

| Key | Holds | Cleared by |
| --- | --- | --- |
| `winnow.preferences.v1` | Appearance, sort, image policy, blocked/muted senders | never, by design |
| `winnow.learning.v1` | Weights + the 400-event log | never, by design |
| `winnow.activeFilters.v1` | The active filter set | sign-out |
| `winnow.mailbox.v1` | Which mailbox was last open | — |
| `winnow.drafts.v1:<account>` | Unsent composer drafts, one per context (`new`, `reply:<id>`, `forward:<id>`), for restore after a reload | send, discard |
| `winnow.gmail.cache.messages` | The mailbox, as plain JSON | sign-out |
| `winnow.gmail.cache.cursor` | Gmail `historyId` | sign-out |
| `winnow.google.contacts.v1` | The People API snapshot | sign-out, revocation |
| `winnow.brandLogos.v1` | Cached BIMI answers | sign-out, setting off |
| `winnow.gravatars.v1` | Cached Gravatar answers, by sender address | sign-out, setting off |
| `winnow.google.oauthClient` | The user's OAuth client (web only) | setup |
| `winnow.gmail.tokens` | Tokens (web only) | sign-out, which also revokes the grant at Google |
| `winnow.pendingAuth`, `winnow.pendingState` | PKCE verifier, sign-in state (`sessionStorage`) | read, or 15 min |
| keychain `gmail.tokens`, `google.oauth-client` | The same two, on desktop and Android | sign-out (revoked at Google first, from the web layer) / setup |
| `winnow.mutedFilters.v1` | Retired — deleted on launch | — |

---

## 11. Tests, and the scripts that run them

| Suite | Command | What it is |
| --- | --- | --- |
| Unit | `npm test` | Vitest, **node** environment, `src/**/*.test.ts` plus `../proxy/**/*.test.ts`. There are no component tests, and the glob says `.ts` not `.tsx` so nobody infers there should be. |
| Gate | `npm run check` | typecheck + lint + lint:proxy + unit |
| End-to-end | `npm run smoke` | Playwright + Chromium against the real production build. Owns its `vite preview` on port 4173 (`WINNOW_PORT`, or point `WINNOW_URL` at your own). A native `confirm`/`alert`/`prompt` is a tripwire failure. |
| Secrets | `minesweep --config .minesweep.yml --fail-on high .` | CI job 1, and the pre-commit hook. |

`web/scripts/`:

- `check-version.mjs` — six manifests must agree (`package.json`,
  `package-lock.json` twice, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`), all
  plain `MAJOR.MINOR.PATCH`, because a suffix lives only in the tag and WiX
  rejects anything else. `tauri.conf.json` is the authority.
- `bump-version.mjs` — sets one version in all six manifests (`patch`, `minor`,
  `major` or exact), editing in place so formatting survives, then re-runs
  `check-version.mjs`. Used by the Cut release workflow.
- `bundle.mjs` — bundle kinds are named per host (asking macOS for a `deb`
  declines quietly rather than erroring), and success is asserted by looking for
  the file. Preflights `hdiutil` and `create-dmg` so a missing one is a sentence
  rather than a stack trace from inside a vendored bash script.
- `smoke.mjs` — 23 sections. It asserts the rail renders exactly once below the
  search field with `aria-keyshortcuts` in order, that every pill is visible with
  ≥4.5:1 label contrast, that the sidebar scrim's blur falls off identically in
  all directions, that persistence survives a reload, that the theme survives a
  reload with the bundle blocked, that a phone layout has no sideways scroll, and
  that the console stayed empty.

The four tests worth reading first, because each exists because a real bug got
out and nothing else would have caught it:

| Test | The bug it pins |
| --- | --- |
| `platform.test.ts` | Tauri rewrites argument keys but never return values, so `authorize_url` read as `authorizeUrl` gave `undefined` and desktop sign-in was impossible — with Google's raw IPC error on screen. |
| `theme.test.ts` | A screenshot cannot tell you a grey is 3.14:1 on white, which is how `inkSubtle` shipped as every section header, row timestamp and status line at 11–13 px. |
| `mapper.test.ts` / `mime.test.ts` | Neither end of a send was tested: quoted-printable subjects rendered as mojibake and `In-Reply-To` went out as a bare Gmail id, so replies threaded in the sender's account and nowhere else. |
| `core/store/scale.test.ts` | A 2,500-message sync must not serialise the mailbox 100 times, and a weight change must still reclassify. |

---

## 12. Environment and named constants

The environment surface is four variables and one build-time constant. Every
numeric constant worth knowing is quoted in the section that owns it: quota and
retry in §5.5, sanitiser limits in §5.8, sync caps in §5.5, proxy limits in §9.

| Name | Where | Effect |
| --- | --- | --- |
| `VITE_RENDER_PROXY` | build time | Turns on the Proxied view and its client. http/https only, read once. |
| `__WINNOW_LOOPBACK_PORT__` | both hosts | Placeholder the web layer writes and Rust substitutes with a real ephemeral port. `oauth.rs` refuses a URL without it. |
| `PORT`, `HOST`, `ALLOWED_ORIGINS` | proxy runtime | Bind address and the exact-origin CORS allow list. |
| `WINNOW_PORT`, `WINNOW_URL`, `WINNOW_CHROMIUM` | smoke | Point the suite at another port, an existing server, or a system browser. |

The repository's own secret gate is `.minesweep.yml` — `public-github` profile,
`fail_on: high`, `min_confidence: 0.7`, no baseline — and it runs both in CI
(job one) and as the pre-commit hook.

---

## 13. Conventions that are load-bearing

Each of these is a rule with a reason attached; breaking one produces a bug that
is hard to see.

| Rule | Why |
| --- | --- |
| Token colours are CSS variables, so Tailwind's `/opacity` never applies to them | `rgb(var(--wn-veil) / 0.5)` is not a colour and renders nothing. `theme.test.ts` asserts this over every token. |
| `fontSize` and `borderRadius` are **overridden**, not extended | So `text-sm` does not exist and an arbitrary `text-[13px]` is caught by a test. |
| Focus rings are `outline`, never Tailwind's `ring` | `ring-2` composes `box-shadow` out of custom properties and silently resolves to `none`. |
| `base: "./"` in `vite.config.ts` | A Tauri window requesting `/assets/…` from the filesystem root renders blank. |
| One entry point, no route code splitting | A lazy chunk that has not been written yet fails at runtime with no error message. |
| No path aliases anywhere | The project has none; an import that needs one is a signal. |
| `theme.ts` and `tailwind.config.js` list the same colour names, by hand | A name in one and not the other silently produces an unstyled element rather than a build error. |
| Rust serialises camelCase explicitly | Tauri rewrites argument keys but never return values. |
| New Rust code goes in a module, not in `commands.rs` | The command layer is meant to stay readable in one sitting. |

---

## 14. What is deliberately not here

- **No second platform implementation.** Three of `Platform` means a rule was
  wrong.
- **No attachments on outgoing mail, and no rich text.** Compose, reply and forward
  send `text/plain` through one builder (`core/gmail/mime.ts`); `core/mail/compose.ts`
  is the new-message half: the blank draft, the recipient check, `mailto:`.
- **No component tests.** The layers that are hard to get right (classification,
  the wire, sanitising, the store) are pure and heavily tested; the components
  are covered by the smoke pass against a real browser instead.
- **No Drafts mailbox.** The composer autosaves to Gmail drafts (`core/mail/drafts.ts`,
  `DraftAutosaver`: device copy at once, Gmail ~2 s after typing stops, one id per
  draft, `drafts.send` on Send, `drafts.delete` on Discard), but Gmail's own drafts
  are excluded from sync, so there is nothing to browse them in yet.
- **No path aliases, no router, no state library, no CSS framework beyond
  Tailwind, no date library, no component library.** Each absence is a decision
  recorded in the file that would otherwise have imported it.

---

*Counts and constants in this file were taken from the tree at the time of
writing. Where a file states a reason for its own shape, the reason is quoted;
where this file states one, it is inferred and worth checking.*