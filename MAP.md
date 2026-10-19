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
    favicon.*       The tab icon: favicon.svg follows the OS scheme itself; .ico/.png for Safari.
    relayLight.svg  The original paper-plane artwork the icons are drawn from.
    demo-avatars/   Seven SVGs for the seeded demo mailbox. No network, no Gravatar.
  src/
    core/           Pure TypeScript. No DOM, no React, no platform calls.
      gmail/        The Gmail REST API: quota, retries, sync, MIME.
      session/      OAuth, the token/credential stores, the offline cache.
      classify/     Message → signals, and the list pipeline.
      learn/        Stars and hidden buckets → weights; filter corrections → smart filters that learn.
      model/        Email, signals, filters, profile, appearance, ids.
      contacts/     People API sync, the contact index, suggestions.
      mail/         Sanitising, quoting, dates, codes, unsubscribe, keybinds.
      store/        The store, its derived view, preferences.
      avatars/      Contact photos, Gravatar, BIMI logos, the local picture caches.
      data/         The demo mailbox seed.
      offline/      The offline action queue (§5.10).
    platform/       The boundary. Two implementations (web.ts, desktop.ts), one interface.
    ui/             React components and the pure helpers beside them.
  scripts/          check-version.mjs, bump-version.mjs, smoke.mjs, sweep.mjs, bundle.mjs — see §11.
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
| `web/src/platform/types.ts` | The fourteen methods that are allowed to differ between browser and desktop. |
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
     winnow.gmail.cache.messages, written in idle time in chunks (idleWrite.ts) and at
     once on pagehide or flush(); a loaded body is never
     overwritten by a metadata-only copy
4. handed to the store                          core/store/store.ts (applySync)
5. classified                                   core/classify/classify.ts
     pure, synchronous, one message in / one EmailSignals out;
     spam likelihood is computed *before* importance, because importance pays for it
6. profile from inbox + trash                   core/model/profile.ts
     counts updated per moved message (updateProfileStats); only senders whose
     bias, rank tier or quiet status changed are reclassified (sendersReclassifiedBy)
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
memo: a clock tick classifies nothing, a weight change reclassifies, and archiving or
binning one message reclassifies only the senders it affects, with the same answer as
a full pass.

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
| Mutations | `archive`, `move`, `trash`, `toggleRead`, `markUnreadAndMoveOn`, the `*Many` batch variants, `moveWithUndo` / `discardDraftWithUndo` (the phone's swipes), `archiveWithUndo` / `trashWithUndo` / `moveManyWithUndo` (every other move the user makes), `undoLast`, `dismissUndo` |
| Senders | `blockSender`, `unblockSender`, `muteSender`, `unmuteSender`, `showSender`, `isSenderMuted` |
| Bodies | `loadBody`, `prefetchBodies`, `hasLoadedBody`, `scheduleReclassify` |
| Offline storage | `saveMailboxOffline`, `declineMailboxStorage`, `dismissStoragePrompt` |
| Learning | `resetLearning`, `setPreferences`, `setSortBy`, `setGoogleContacts` |

Two behaviours worth knowing before touching it:

- **Every mutation goes through `mutate()`,** which snapshots for `undoLast()`
  and drops the read cursor when the row under it leaves the screen. An undo that
  cannot restore exactly what it touched is not an undo.
- **The undo offer has one slot** (`state.undo`, `offerUndo`, stamped with `at`), shown
  in the status pill (`ui/components/StatusPill.tsx`). Every move the user makes offers
  it: the phone's swipes and a notification's Delete (`moveWithUndo`), `e`/`#`, the
  selection bars, the row menu and the reader's Archive/Trash/Not spam
  (`archiveWithUndo`, `trashWithUndo`, `moveManyWithUndo`), all on one private
  `movesWithUndo` so a batch is one notice ("Moved 3 to Trash.", `undoLabel`) and one
  Undo; plus `discardDraftWithUndo`. `z`, Ctrl+Z and ⌘Z take the offer back
  (`keybinds.ts`, only while one is on offer and never in a text field). A short word about the last action ("Draft saved.",
  "Message sent.") is `flash(text, ms)` (`state.flash`), gone by itself; the persistent
  `notice` strip stays for what is not about an action (a capped mailbox, a failure). A draft discard only reaches Gmail when the offer is *let
  go* — dismissed, replaced by a newer offer, left by a mailbox change, or after
  `DRAFT_DISCARD_UNDO_MS = 10 s` — and a listing in the meantime keeps the row out.
  Sign-out and the demo drop the offer without committing, so the draft survives.
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

### 5.3a `learn/filter*` — smart filters that learn, readably

"Change smart filters…" (row menu, reader overflow, selection bar, phone long-press →
selection bar) records one **correction** per message per ticked or unticked filter.
That is the only input; nothing is learned from opening or ignoring mail.

- `filterClues.ts` — the readable features: patterns (`p:tracking`, `p:ups`,
  `p:royal-mail`, `p:evri`, `p:dpd`, `p:amazon-order`, `p:order-number`, `p:amount`,
  `p:date`), headers (`h:list-unsubscribe`, `h:no-reply`, `h:attachments`), Gmail's
  category (`c:updates`) and up to 10 subject/preview words (`w:parcel`). Each has a
  phrase for "Why it's here". The sender is not a clue.
- `filterLearning.ts` — `FilterLearning`, immutable. Decision order per learnable
  filter: this message's own correction → a **sender rule** (an exact address from its
  own corrections, one is enough; a registrable domain only with corrections from at
  least `MIN_DOMAIN_ADDRESSES = 2` distinct addresses there; a sender or domain with
  corrections both ways has no rule; the account's own domain — `northwind.example` in
  the demo — and gmail.com-style shared domains never get a domain rule) → **per-filter
  naive Bayes** over the clues, with the built-in answer as the prior at
  `BUILT_IN_ODDS = 3` to 1. Generic clues (`c:*`, `h:no-reply`, `h:list-unsubscribe`,
  `h:attachments`, `p:date`) never count; all words together count as one clue at most;
  each clue is smoothed toward its rate in the inbox (`clueBackground`,
  `BACKGROUND_WEIGHT = 2`) and never votes against the direction it was seen in more;
  it may overturn the built-in answer only with `MIN_SUPPORT = 2` corrections sharing a
  specific clue, and never takes mail out of Security or Important → the built-in
  rules (`builtInSays`, the filter's full predicate). Learned answers are stored as
  per-filter overrides (`EmailSignals.filterOverrides`), never by rewriting the
  classifier's flags, so a correction changes exactly that filter; `inSignalFilter`
  (signals.ts) is the one predicate the list, counts, badges and learning share, and
  unsafe mail is never put into a filter. One "Change smart filters…" action records
  only messages whose membership changes, in one `batch`, so it counts once per sender.
  Star learning reads the raw classifier output (`baseSignals`). Twelve filters are
  learnable (`LEARNABLE_FILTERS` = `SIGNAL_FILTERS`); Starred, Unread, Files, the contact
  buckets, Read later, Long reads and Unsafe are facts, not judgements, and are not.
- `filterExplain.ts` — one line per filter the message is in, naming the path that
  decided (`source`: message, sender, similar or built-in): "In Deliveries because:
  from evri.com, has an Evri tracking number, you moved 2 emails here". Important's
  built-in line names only what pushed it over the line. Words only.
- Storage: `winnow.filterLearning.v1`, `{ version: 1, owner, corrections }`, capped at
  300 corrections, 20 clues each and 1,200 distinct clues (rarest words dropped first).
  Local only, never synced. Cleared on sign-out and when a different account connects
  (the demo's corrections are dropped on the first real connect).
- The demo has two Evri deliveries (`demo-missed-delivery-1/2`) the built-in rules miss
  on purpose; correcting the first moves the second by the sender rule.
- Targeted smoke: `node web/scripts/smoke-filters.mjs` (port 4350 by default).

### 5.4 `model/` — the vocabulary

| File | Holds |
| --- | --- |
| `email.ts` | `Email` (product view) vs `RawEmail` (wire view), `Mailbox = "inbox" \| "archive" \| "sent" \| "drafts" \| "trash" \| "spam"`, `MAILBOX_LABEL`, `EmailCategory`, `Contact`, `Attachment`, `Draft`, plus the loaded-body helpers (`isBodyLoaded`, `keepLoadedBody`, `withLoadedBody`) and `withCode`. |
| `signals.ts` | `BUILTIN_FILTERS` (21, in rail-catalog order), `FILTER_LABELS`, `PERMANENT_FILTERS = ["important", "shipping"]`, `NAVIGATION_ITEMS`, `UNSAFE_THRESHOLD = 0.4`, `IMPORTANT_THRESHOLD = 56`, `isUnsafe`, `isImportant`, `badgeFilters` (the chips in a reader) and `rowIndicators` (the at-most-one word a list row carries). |
| `profile.ts` | `buildUserProfile(inbox, trash)`, also built incrementally (`profileStats` → `updateProfileStats` → `profileFromStats`, integer counts per category so both paths agree exactly; `sendersReclassifiedBy` names the senders a profile change reclassifies): per-sender trash bias (unbounded in the profile, clamped to `MAX_TRASH_BIAS = 0.35` where used), top six correspondents, the quiet tail, and first-time senders. Deterministic, and ties break on the sender name — a ranking that hides mail cannot be a shuffle. |
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
| `bridge.ts` | `SessionBridge`: a flat façade the UI uses, plus the two side effects the session cannot do (`store.signOut` when the client changes or the user signs out). `accountEmail` falls back to a placeholder so a launch still opens the cached mail; `verifiedAccountEmail` throws instead, for the demo's "Back to your inbox", which must know the session works before the store leaves the demo. |
| `credentials.ts` | The user's own OAuth client: validation, the two stores (web `localStorage`, desktop keychain), and `testConnection`, which posts a deliberately invalid code and reads the verdict. |
| `clientJson.ts` | Import of Google's downloaded `client_secret_….json`. 64 KB cap, and the exact list of refusals and warnings below. |
| `redirect.ts` | Web-only redirect parsing as pure functions over a query string. A code with no `state` returns `null`. |
| `pendingAuth.ts` | The PKCE verifier in `sessionStorage`, as an array keyed by `state` so two tabs cannot clobber each other. Single-use: `take` removes. |
| `errors.ts` | `describeFailure` — the message and hint for each failure kind. |
| `googleErrors.ts` | Google's setup errors (redirect_uri_mismatch, not a test user, API disabled, invalid_client, missing secret, org_internal, admin policy, …) mapped to a plain title, the fix, and the setup step that makes it. `explainGoogleText` reads a code out of pasted text. |
| `nativeSignIn.ts` | Native Android sign-in's pure decisions. Two clients can own a session now: the main (Desktop app) client, or the Web application client native sign-in names as `serverClientId`, which `TokenSet.clientId` records. `refreshClientFor` picks the one to refresh under; `sessionStrandedBy` says when saving a client must sign out; `browserFallbackScope` re-asks for the session's scopes when the browser's client is not the one that granted them. `GmailSession.authorize` tries `platform.nativeGoogleSignIn` first when a Web client is stored, and falls back to the browser on anything but a code or a cancel, the exchange included. |
| `exchangeRetry.ts` | The end of a native sign-in on a WebView that may be paused (Android, behind the browser): before the code exchange and the profile read, wait for `platform.waitForForeground`, and resend only an attempt that got no HTTP response (`GoogleUnreachable`, or a bare fetch `TypeError` for the profile), backing off 0.5/1.5/3 s. `invalid_grant` and every other answer from Google are never resent. Out of attempts → `SignInUnreachable`: "Couldn't reach Google to finish signing in. Check your connection and try again." |

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

### 5.10 `offline/` — the action queue, and undo send

`queue.ts` wraps the session's backend (`bridge.backend()` returns it wrapped). Archive,
trash, restore, read/unread, star and send taken while `navigator.onLine` is
false, or whose request got **no HTTP response** (`TypeError: Failed to fetch`,
`GoogleUnreachable`), are kept in `winnow.offlineQueue.v1` and resolve at once, so the
store's optimistic change stands. An *answered* refusal still rolls back. Replay is FIFO,
one at a time, on `online`, before every sync, and on a 1 s → 60 s backoff; a newer
star/read/move of a message replaces the older one. 404/410 drop quietly; 401 and
`reauth_required` (`invalid_grant`) pause until the next connect or a sync that gets
through, never on a timer. A raw `messages.send` whose answer was lost is never replayed
(it is reported, and a new message reopens in the composer); a `drafts.send` is, since a second try on
a sent draft is a 404. Every sync result has the queue laid over it, so a fresh reading
cannot undo a waiting change on screen. A label change queued by 1.3.0-beta is dropped
on load, never replayed (§13a). A waiting send's files are written
under the drafts' device-copy budget (`forDeviceCopy`), so one big file cannot overflow
`localStorage` and leave the queue unsaved; this session keeps every byte. Permanent delete is not queued. Sign-out clears
it; a queue saved for another account is discarded. `ui/components/OfflineIndicator.tsx`
is the "Offline: N changes waiting" line (`ui/offlineStatus.ts`).

Undo send (`core/mail/undoSend.ts`, Settings → Compose → **Undo send window**, Off/5/10/20 s,
10 s by default; a saved 30 s from ≤ 1.2.2 reads as 20 s; "Sending in Ns… Undo · Send now"
in the status pill): if the app closes in the window
the message is **kept as a draft, not sent** — the safe choice, reasoned in that file.

---

## 6. `web/src/platform` — the boundary

`types.ts` is the whole contract. Fourteen methods (plus three optional notification
helpers, `confirmNotificationAction`, `keptReplies`, `releaseKeptReplies`, that only the
native host has), and a browser cannot do seven
of them properly:

| Method | Browser | Desktop |
| --- | --- | --- |
| `info()` | constant `WEB_INFO` | `invoke("app_info")`, memoised |
| `tokenStore()` | `localStorage["winnow.gmail.tokens"]` | keychain `gmail.tokens` |
| `credentialStore()` | `localStorage["winnow.google.oauthClient"]` | keychain `google.oauth-client` |
| `beginSignIn()` | `sessionStorage` + `location.assign` | `oauth_begin` / `open_external` / `oauth_await` on an ephemeral loopback port |
| `cancelSignIn()` | drop the session key | `oauth_cancel` |
| `notifyNewMail()` | a `Notification` per message, click-to-open (no buttons without a service worker) | `notify_messages`: per-message with buttons, see §8.3 |
| `onNotificationAction()` | the click closure | `listen("winnow://notification-action")` |
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
- `nativeGoogle.ts` — reads what the Android sign-in plugin returns
  (`parseNativeSignInResult`, `parseSigningInfo`). Anything unexpected is
  `unavailable`, which sends the sign-in to the browser. `desktop.ts` implements the
  two optional, Android-only `Platform` methods with it: `nativeGoogleSignIn` and
  `appSigningInfo` (package name, the running APK's SHA-1, Play services). Its
  `beginSignIn` opens Google in a Custom Tab on Android (`open_sign_in_tab`), and in
  the system browser if that fails.
- `visibility.ts` — `waitUntilVisible`: resolves when `document.visibilityState` is
  `visible`, or `false` after a timeout (15 s). `desktop.ts`'s `waitForForeground` uses it
  on Android only; desktop windows are not paused behind the browser.
- `foregroundSync.ts` — polls every 10 s while the document is visible and
  focused, and fires at once on focus regain, tab-visible and `online`. There is
  no server to push from, and an empty incremental sync costs 2 quota units. The
  same code runs in both hosts because a Tauri webview fires the same DOM events.
- `web.ts` adds `readRedirectFromLocation()` and `pendingSignInState()`;
  `desktop.ts` adds `onDeepLink()`, `onTrayAction()`, and Android's `onBackButton()` /
  `exitApp()`.

**The IPC naming rule, which has cost real time.** Tauri rewrites *argument* keys
from camelCase to snake_case but never rewrites *return values*. So `AppInfo` has
explicit `#[serde(rename)]` on all four capability flags (serde would emit
`nativeOauth`, which reads as `undefined` at the call site), `OAuthBegin` returns
`authorize_url` and the web layer reads `authorize_url`, and `notify_messages`'s
`NotificationBatch` is `rename_all = "camelCase"` so `messageId` and friends survive. `desktop.ts`'s
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
| `MessageList.tsx` | The windowed, day-sectioned list. Flat item union, memoised rows, heights in a `Map` plus a `ResizeObserver`, pinned day headers painted outside the scroller, drag/⌘/shift selection, long-press, sender and row menus, code chips, and the phone's swipe actions (the row is moved by hand with `translate3d`, a backdrop is mounted for the swiped row only, and `touch-action: pan-y pinch-zoom` on the list leaves sideways motion to it). At most one signal word per row; "Urgent" is drawn in the Urgent chip's hue (`.wn-signal-ink`: `FILTER_HUES.urgent` at the mode's `pill.textLightness`, AA-checked by `pillInk` in `theme.test.ts`), the rest grey. Under floating chrome (`topInset`) the rows start below the measured chrome plus a 6px gap (`TOP_GAP`), published on the scroller as `--wn-top-chrome` (padding) and `--wn-top-clear` (`scroll-padding-top`, with the first day's height). The first message is always revealed at scroll 0; a new view (`listView`: mailbox, filters, sort, search) starts at its top; a `j`/`k` while the list is hidden behind the reader is revealed on the way back (`revealIndex`, since the phone shows no cursor). Smoke: `scripts/smoke-top-email.mjs`, run by `smoke.mjs` and alone. |
| `Reader.tsx` | The message pane: back bar, header (avatar → sender menu, sender `h2`, subject as the document `h1`), filter tags with their reasons, the three-way image offer, body, attachments, the conversation, and the phone dock. |
| `MessageBody.tsx` | Renders the body in the chosen `BodyView`: `rich` (sanitised, inline), `plain`, `sent` (`sandbox=""` iframe), `proxied`. The view is per message and is not persisted. |
| `Masthead.tsx` | Sidebar toggle (a panel icon), the mark as the version toggle (`logoVersion.ts`), search, position readout, prev/next, Compose (no Mark all read anywhere: opening a message marks it read), and the `FilterStrip`. It floats over the list, like the phone's dock: the bar is a rounded glass pill (`.wn-glass.wn-glass-bar`) inset from the pane, each chip its own glass pill (`FilterStrip` `floating`), no band behind either, and the selection bar takes the chips' slot (`replaceRail`) so the header keeps its height. `App.tsx` measures it (`data-list-chrome`) and passes the height to `MessageList` as `topInset` (top padding, `scroll-padding-top`, the pinned day below it, the cursor's reveal clearing it); the briefing is the list's in-flow `lead`, scrolled away with the mail. Its `searchRef` must be the same ref the keybind handler holds, or `/` silently does nothing. |
| `FilterStrip.tsx` | The rail of pills: sticky leading mark, `All`, edge fades and step chevrons. Fades are `pointer-events-none` — a gradient that eats clicks at the edge is the worst possible bug in a filter rail. With `touch` (the phone) it is the floating rail instead: no band, no fades, each chip its own frosted glass pill (`.wn-chip-glass`) at the dock's side insets, and taps between chips fall through to the list. |
| `MailNav.tsx` | The sidebar overlay: Inbox with its thread count, then the other five mailboxes in `MAILBOX_ORDER` (Drafts among them), an account footer carrying Settings, and the progressive scrim blur. On a phone it is the dock's pill grown upward (`data-morph`: same left edge, width and bottom as the pill, revealed by a `clip-path` from the pill's shape, in the dock's frost) with no app-name header, icon rows, the current mailbox on a pill and the list upside down (account + round Settings gear on top, a divider, then Spam, Trash, Drafts, Archive and Sent (`PANEL_ORDER`), Inbox last on the pill's line, stopping a cell short so the dock's Expand chevron sits beside it on top of the panel); the scrim uses the same four-layer recipe as the desktop, spreading from the middle of the panel's right edge. Always mounted so it can animate out; `role="dialog"` and `inert` only while open. |
| `SettingsPanel.tsx` | Settings. Sections: Google account, Reading, Appearance, Background, Google contacts, How Winnow sorts, hidden senders. |
| `Composer.tsx` | Reply, forward and new message: recipients, subject, body, ⌘⏎, Send and Discard, the Reply / Reply all toggle and the draft status. Three layouts: docked at the bottom of the reader pane (desktop reply and forward, not modal, its own Escape), a centred sheet (desktop new message), full screen (phone, everything). |
| `GoogleSetup.tsx` | The five-step BYO-client guide: console deep links, exact scopes and redirect URI with copy buttons, ticks and a resumable half-finished setup (`setupProgress.ts`), "Continue in demo" on every step; paste, import by file, drop or paste-into-field; test; save; connect. |
| `SetupTroubleshoot.tsx` | `SetupFix` (a Google error as a plain fix plus a link back to its step) and "Google showed an error?" on step 5, which explains text pasted off Google's own error pages. Both read `core/session/googleErrors.ts`. |
| `InboxClear.tsx` + `InboxClear.css` | The good-news empty states. Clear (Inbox empty, or only held-back junk left, or one smart filter worked to the end): the untouched `AppMark` at the end of a dashed trail in accent light, a time-of-day line, and a one-time motion plus a phone haptic when the last row goes (`useClearCelebration.ts`; nothing moves under reduced motion). Quiet (empty folder, or filters that match nothing): one line and the remedy. `inboxClear.ts` decides which and what they say; search keeps `MessageList`'s own remedy screen. |
| `ComposeFab.tsx` | `ComposeButton`: the phone's round compose pencil in the accent, a circle as tall as the dock's pill, beside it in the dock's bottom row (it used to float over the list and cover rows). `App.tsx` decides when it is offered. |
| `RecipientField.tsx` | The composer's To, Cc and Bcc fields: chips plus an ARIA 1.2 editable combobox. Nothing is highlighted until an arrow key, Tab only accepts after navigation (WCAG 2.1.1), Escape is consumed only while the list is open. |
| `Overlay.tsx` | `Sheet`, `ConfirmDialog`, `SheetHeader`. Focus moved in and restored on unmount, Tab trapped by `getClientRects()` (because `offsetParent` is null for a fixed element). `ConfirmDialog` exists because `window.confirm` is unimplemented in a Tauri webview. `backdrop="opaque"` (`.wn-backdrop-opaque`) paints chrome instead of the scrim, for a panel that replaces the screen: phone Settings, where the app also hides and inerts `main` (`data-covered`) so no frame of the entrance shows the inbox. |
| `Menu.tsx` | The WAI-ARIA menu pattern, including submenus. Every other key is swallowed so the app's global shortcuts cannot fire while a menu is open. |
| `menuPlacement.ts` | `placeMenu` and `MenuAnchor` as pure geometry, kept out of the component module so they test without React. |
| `NavigationPalette.tsx` | The `!` palette: inbox, spam, trash, sent, drafts, settings. It is a `menu`, not a `dialog`. |
| `PhoneChrome.tsx` | `PhoneTopBar` and `PhoneDock`. Below `sm` the masthead is replaced, not squeezed; all targets are 44 px. The top bar is one row, the mark then search (placeholder "Search <list>"); the list's name and count are a visually hidden `h1`, so mail starts higher. Since 1.2.3 it floats over the list like the dock (`data-phone-chrome`, the mark and search each their own glass, no band): `App.tsx` measures it and passes the height to `MessageList` as `topInset`, the demo strip moves into the list's `lead`, and the pull indicator comes down from under it. The mark is the version toggle (`logoVersion.ts`, shared with `Masthead`): it crossfades search for "Winnow <version>" (`PlatformInfo.version`, never a literal), `aria-pressed`, a haptic tick on the phone; search stays mounted, and `/` or focusing it brings it back. The dock floats over the list (after Linear's Android app): a glass pill with two icon-only tabs (Inbox with its unread badge, Sent) and an Expand chevron ("More mailboxes", `aria-expanded`), the compose circle beside it, the filter chips floating above, and a small glass "Top" pill ("Back to top") centred above the chips once the list is more than a screen down (`backToTopVisible`; hidden over the expanded panel, a selection or an overlay, and taking no taps while hidden; while shown it counts in `--wn-phone-dock`, so the last row clears it). Expand opens the menu panel; Inbox tapped while current scrolls the list to the top. It publishes `--wn-phone-tabs` (pill top, where Settings' sheet stops) and `--wn-phone-dock` (chrome top, the list's end padding in `index.css`). Geometry is `--wn-dock-*` in `index.css`, shared with the panel. |
| `PullRefresh.tsx` | Pull-to-refresh on the phone's list, which replaces the briefing strip once an account is connected (the demo and a disconnected phone keep a compact one-line strip with Connect Gmail). Past the threshold it ticks, then spins on the same action as Sync now and hands the result ("Synced just now · N waiting on you", or the error) to the status pill, which says it in the same place and glass. The rules live in `pullRefresh.ts`. |
| `StatusPill.tsx` | The one in-app notification surface: the pull's frosted pill (`.wn-glass.wn-glass-bar`, full round), fixed and centred over the list's pane just under its chrome (the phone's top bar or the desktop's floating header, `+16px`), or under the window's safe area when the list is hidden (a phone reading, a narrow window with the reader open), so it never meets the dock or its chips and pushes nothing down. It shows one notice, newest first: a send in its undo window (Undo, Send now, a countdown), the store's undo offer (Undo, Dismiss), a flash (Dismiss) or a pull's result; when an action notice ends it says the sync line for `SYNC_RETURN_MS`, then goes. One always-mounted polite live region says each notice once (never the countdown). It takes the list pane as an element (App's callback-ref state), not a ref, so it re-measures whenever the pane mounts again (sign-out → demo). Rules in `statusPill.ts`. |
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
| `swipe.ts` | Swipe actions as pure logic: `SwipeGesture` (edge zones `EDGE_PX = 24`, axis lock after `AXIS_LOCK_PX = 10`, commit past `COMMIT_FRACTION = 0.38` of the row or a fling ≥ `FLING_VELOCITY = 0.6` px/ms over ≥ 40 px) and `swipeActionsFor`, which says what each direction does per mailbox: left is Trash, right toggles read; in Trash left restores to the Inbox; in Drafts left discards (with Undo) and right does nothing. Touch only, phone layout only, off in select mode and under any menu, sheet or dialog; Settings → Reading → Swipe actions turns it off. |
| `pullRefresh.ts` | Pull-to-refresh as pure logic: `pullAllowed` (connected, list at the top, no dock panel, selection, overlay or sync under way), `pullIntent` on `swipe.ts`'s axis lock so a pull and a row swipe never both fire, the rubber band `pullDistance` (threshold `PULL_THRESHOLD = 70`, max `PULL_MAX`), the threshold tick and the phases. |
| `demoResume.ts` | The demo's way back to a stored session: the button's wording (`demoCtaLabel`: Connect Gmail, Back to your inbox, Sign in again) and what a failed resume means (`resumeFailure`: an expired grant shows `SESSION_EXPIRED` and the button signs in again; an unreachable Google keeps the session). App adopts the session without a Google sign-in or a revocation, checking it with a profile read first so an expired one never takes the store out of the demo. |
| `statusPill.ts` | The status pill as pure logic: `currentNotice` (newest wins; a tie goes to a waiting send, then an undo, a flash, the sync line; an older notice still on offer comes back when the newer goes), `returnsToSync`, `noticeKey`, the countdown text and the screen-reader announcement. |
| `windowing.ts` | Variable-height windowing arithmetic (`ESTIMATED_ROW_HEIGHT = 53`, `OVERSCAN = 6`). No fixed-height virtualiser, because rows are 53–82 px. |
| `syncStatus.ts` | The sync line and button text as one pure function, with a documented precedence order. |
| `bodyViews.ts` | Which "Show as" options exist for this message — two instead of four when there is no HTML part. |
| `filterColors.ts` / `filterIcons.tsx` | A hue and saturation per bucket (never a finished colour), and one icon + one reason. `important` is a Bookmark, not a star, because the row's star is a control. |
| `senderPictures.ts` / `avatar.ts` / `demoPictures.ts` | Avatar sourcing as a context, plus the pure hash that gives a sender a stable tone. |
| `sidebarOverlay.ts` | The idle-close policy (all seven conditions must be false) and the scrim recipe (one recipe for the desktop sidebar and the phone's menu panel; both spread from the middle of the panel's right edge). |
| `phoneDock.ts` | The dock's rules: the two tabs, Expand's name, a tab tap selecting or scrolling to the top (never opening the menu), the badge cap, the panel's reversed order, and the two published custom properties. |
| `glass.ts` | The floating frost per mode (the phone's dock, chips and panel; the desktop list's top bar, chips and selection bar): blur 22px + saturate 1.8 (`--wn-glass-filter`; every floating pill also eases its background, opacity and transform over ~200ms and presses to 0.97, off under reduced motion), a 62% rim, and the raised tint behind text (`text`, `textOn`) that `glass.test.ts` holds to AA for every chip over the worst backdrop that can scroll under it, plus `bar`, the desktop bars' tint, held so `inkMuted` ("of 39") is AA too, and the no-`backdrop-filter` fallback. Published as `--wn-glass-*` by `applyTheme`. Since 1.2.3 the blur is not on the pill itself but on its `::before`, reaching `GLASS_REACH` (44px, `--wn-glass-reach`) past it and clipped back to its shape: a backdrop-filter only samples what is behind its own box, so on a thin pill a line of row text stayed sharp. Nothing above a pill may be a backdrop root (opacity < 1, filter, mask, clip-path), and the chip rail pads itself by the reach so its scroller does not clip the layer. |
| `menus.ts` | Both menus' contents as data, so the rules are unit-tested rather than trapped in JSX. |
| `backLayers.ts` | Android's Back as data: which layer one press closes (popover → sheet → composer → sidebar → Settings → message → leave), so the order is a test, not whichever handler ran first. |
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
| `commands.rs` | 15 commands, each of which validates, delegates and converts errors to strings. |
| `oauth.rs` | The loopback listener: binds `127.0.0.1:0`, substitutes the real port into `__WINNOW_LOOPBACK_PORT__`, answers one request and stops. On Android the success page has a "Back to Winnow" button to `winnow://signed-in` (the manifest's `VIEW` intent filter), which brings the app forward; the web layer ignores that link beyond focusing. |
| `secrets.rs` | Keychain get/set/delete under service `app.winnow.desktop`, one user per secret name. |
| `scheduler.rs` | The tick, 30–3600 s, clamped, joined on retune so two threads can never overlap. |
| `files.rs` | Save dialog → sanitised filename → `spawn_blocking` write. Async is mandatory, not stylistic: blocking the calling thread deadlocks the dialog callback. |
| `tray.rs` | The tray icon and its three items (`sync`, `settings`, `quit`); there is deliberately no Mark all read. A left click reveals the window; there is deliberately no "Open Winnow" row duplicating it. |
| `google_signin.rs` | Android only at run time: the `google-signin` mobile plugin, registered from this crate with its Kotlin in `gen/android/app/src/main/java/app/winnow/android/signin/` (Play services' `AuthorizationClient` with offline access, the signing certificate, a Custom Tab). Validates the commands' arguments (a client id, Google API scopes, an `accounts.google.com` URL) and passes the plugin's JSON through. The plugin has no permission of its own, so the page reaches it only through the three commands below; off Android they answer "unsupported". |
| `deep_link.rs` | The `winnow://` scheme only. The old OAuth callback scheme was removed: a private-use redirect URI is not something Google hands a desktop client an authorization code for. |

### 8.1 The command surface

| Command | Takes | Gives back | Web side |
| --- | --- | --- | --- |
| `app_info` | — | `AppInfo` (camelCase, four explicit flags) | `info()` |
| `secrets_get` / `secrets_set` / `secrets_delete` | `name`, `value` | `Option<String>` / `()` | token and credential stores |
| `oauth_begin` | `authorize_url` | `{ port, authorize_url }` | `beginSignIn` |
| `oauth_await` | `port`, `timeout_ms?` | `AuthOutcome` (`kind: code \| error`) | `beginSignIn` |
| `oauth_cancel` | `port` | `()` | `cancelSignIn` |
| `google_signin_info` | — | `{ packageName, sha1, playServices }` or `null` | `appSigningInfo` |
| `google_signin_authorize` | `server_client_id`, `scopes` | `{ kind: code \| cancelled \| unavailable, … }`, never an error | `nativeGoogleSignIn` |
| `open_sign_in_tab` | `url` (accounts.google.com only) | `()` | `beginSignIn` on Android |
| `notify_messages` | `batch` (`NotificationBatch`, camelCase) | `()` | `notifyNewMail` (`notify_actions/`) |
| `notify_action_result` | `result` `{ messageId, title, text, failed }` | `()` | `confirmNotificationAction` |
| `notify_kept_replies` / `notify_release_kept` | — / `ids` | `Value[]` / `()` | `keptReplies` / `releaseKeptReplies` |
| `request_notification_permission` | — | `bool` | `requestNotificationPermission` |
| `open_external` | `url` | `()` | `openExternal` |
| `save_attachment` | `filename`, `bytes_base64` | `Option<String>` (path) | `saveFile` |
| `open_attachment` | `filename`, `bytes_base64` | `()` | `openFile` (desktop; PDFs only, written under the temp dir's `winnow-attachments/`, opened in the default app; Android saves instead) |
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

### 8.3 Notification actions (`src/notify_actions/`, `gen/android/.../notify/`)

One batch per sync from the web layer (`core/notify/notifications.ts`): only unread inbox
mail from senders neither muted nor hidden, newest first, five per-message notifications
at most plus a summary, the buttons the user left on, and the lock-screen preview switch.
There is no "only important" setting to respect yet; `notificationsEnabled`, muted and
hidden senders and the read state are what gate it.

| Host | Shown by | Reply | Delete / Mark read | Tap | Where the action runs |
| --- | --- | --- | --- | --- | --- |
| Android | `NotifyPlugin.kt`: MessagingStyle per message, InboxStyle group summary, `ic_stat_winnow` | Inline (RemoteInput) | Buttons; Delete then offers Undo for 6 s | Opens `winnow://message/<id>` | **Native**, app backgrounded or not: receiver → channel → `android.rs` → `plan::execute` with the keychain tokens; `Http.kt` does the HTTPS |
| Linux | `notify-rust` over D-Bus | Button opens the composer on the message (no inline reply: KDE's is a vendor extension `notify-rust` does not expose) | Buttons | Opens the message | Webview (hidden, not paused): `ACTION_EVENT` → store `setRead` / `moveWithUndo`; confirmation replaces the notification for 3 s |
| Windows | `notify-rust` WinRT toast | Button opens the composer (`tauri-winrt-notification` has no toast inputs) | Buttons | Opens the message | Webview, as Linux; only failures get a follow-up toast |
| macOS | `tauri-plugin-notification`, one grouped notification | — | — | Reveals the window (`RunEvent::Reopen`) | Fallback: actions need `UNUserNotificationCenter` categories; `notify-rust`'s path is the deprecated `NSUserNotificationCenter` blocking a thread per notification, untestable here |
| Browser | `Notification`, one per message | — | — | Opens the message | — (buttons need a service worker) |

How a press is done:

- **The reply is the composer's message.** At notification time the session builds the
  header block with `rawFor` → `buildMime` for `notificationReplyDraft` (to the sender
  only, `Re:`, `In-Reply-To`/`References`, thread id) with an empty body
  (`MailBackend.replyHeads`). `plan.rs` swaps in the current `Date:` and appends the text
  exactly as `buildMime` encodes a body; a test on each side pins that (`notifications.test.ts`
  builds both and compares, `plan.rs` checks the result).
- **Delete is never permanent**: `modify` add `TRASH` remove `INBOX`; Undo is the app's
  restore (remove `TRASH`, add `INBOX`). On the desktop it is `moveWithUndo`.
- **Failures** (`plan::execute` → `finish_for`): a 401 gets one refresh and one replay;
  a failed send is never resent but saved with `drafts.create` on the same thread
  ("Couldn't send. Open Winnow", "saved in Drafts"); if that fails too, or there is no
  token, or the process was restarted just to deliver the press (no Rust to ask), the
  text stays in `PendingReplies` (written *before* anything is attempted) and the web
  layer saves it to Drafts once signed in, releasing each only after Gmail has it.
- **Secrets on Android** cross JNI in-process for one action and are never stored by
  Kotlin; a refreshed access token is not written back (the web `TokenManager` owns it).
- **The Kotlin commands are Rust-only**: no `winnow-notify:` permission is granted to the
  window, so page script cannot reach `http`, and `Http.kt` refuses any host but
  `gmail.googleapis.com` and `oauth2.googleapis.com`.

What only a device can tell (untested here: no emulator, no macOS or Windows host):
RemoteInput on Android 12–15, the receiver with the process killed, the deep link from a
cold start (`get_current` may fire before the webview listens), `Channel` delivery after
the activity is recreated, the Undo window, D-Bus servers that draw no buttons, and WinRT
`on_activated` for an unpackaged build.

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
| `winnow.filterLearning.v1` | Smart-filter corrections (sender rules and clues are derived from them) | sign-out, another account connecting, Settings → Smart filters reset |
| `winnow.activeFilters.v1` | The active filter set | sign-out |
| `winnow.mailbox.v1` | Which mailbox was last open | — |
| `winnow.offlineQueue.v1` | Actions (and sends) waiting for the network, with the account they belong to | replay, sign-out |
| `winnow.drafts.v1:<account>` | Unsent composer drafts, one per context (`new`, `reply:<id>`, `forward:<id>`), for restore after a reload | send, discard |
| `winnow.gmail.cache.messages` | The mailbox, as plain JSON | sign-out |
| `winnow.gmail.cache.cursor` | Gmail `historyId` | sign-out |
| `winnow.google.contacts.v1` | The People API snapshot | sign-out, revocation |
| `winnow.brandLogos.v1` | Cached BIMI answers | sign-out, setting off |
| `winnow.gravatars.v1` | Cached Gravatar answers, by sender address | sign-out, setting off |
| `winnow.google.oauthClient` | The user's OAuth client (web only) | setup |
| `winnow.google.setupProgress` | A half-finished setup: step, ticks, client ID draft (never the secret) | saving or removing the client, Start over |
| `winnow.gmail.tokens` | Tokens (web only) | sign-out, which also revokes the grant at Google |
| `winnow.pendingAuth`, `winnow.pendingState` | PKCE verifier, sign-in state (`sessionStorage`) | read, or 15 min |
| keychain `gmail.tokens`, `google.oauth-client` | The same two, on desktop and Android | sign-out (revoked at Google first, from the web layer) / setup |
| `winnow.mutedFilters.v1` | Retired — deleted on launch | — |
| Android `SharedPreferences` `winnow.notify` / `pendingReplies` | Replies typed into a notification that are not yet sent or in Drafts | released by the web layer once saved to Drafts |

---

## 11. Tests, and the scripts that run them

| Suite | Command | What it is |
| --- | --- | --- |
| Unit | `npm test` | Vitest, **node** environment, `src/**/*.test.ts` plus `../proxy/**/*.test.ts`. There are no component tests, and the glob says `.ts` not `.tsx` so nobody infers there should be. |
| Gate | `npm run check` | typecheck + lint + lint:proxy + unit |
| Smart filters | `node scripts/smoke-filters.mjs` | Targeted smoke for "Change smart filters…", "Why it's here" and Settings → Smart filters. Own `vite preview` on 4350 (`WINNOW_PORT`); `WINNOW_SHOTS=dir` writes screenshots. |
| End-to-end | `npm run smoke` | Playwright + Chromium against the real production build: `smoke.mjs`, then the targeted `smoke-android.mjs`, `smoke-filters.mjs` and `smoke-notifications.mjs`. Owns its `vite preview` on port 4173 (`WINNOW_PORT`, or point `WINNOW_URL` at your own). A native `confirm`/`alert`/`prompt` is a tripwire failure. `WINNOW_SMOKE_ONLY=offline` runs only `scripts/smoke-offline.mjs` (undo send on a phone, the offline queue against a stateful fake Gmail); `WINNOW_SMOKE_ONLY=fixes` runs only `scripts/smoke-fixes.mjs` (phone Settings' opaque backdrop, the phone menu's last row, Undo on desktop/batch/reader actions and `z`/Ctrl+Z, the status pill after a remount on the Android app, the demo's Back to your inbox), whose signed-in pages use the shared fake Gmail in `scripts/fake-gmail.mjs`. |
| Theme sweep | `npm run sweep` | Manual, never in `npm run smoke` or CI. `scripts/sweep.mjs` photographs every mode (light, dark, OLED; `system` once each way) × every accent in `ACCENT_THEMES` (read from `core/model/appearance.ts`, so a new accent is swept for free) on a phone (390×844, Android UA, safe-area insets) and a desktop (1440×900): inbox, reader, drawer, Settings top and scrolled to the end, the Appearance picker, compose, the status pill with Undo, and inbox clear (the shared fake Gmail with an empty inbox). Then the settings and OS preferences that change the look (sort, remote images, brand logos, Gravatar, reduced transparency, forced colours, a small phone, a tablet) once each. Checks as it goes — page/console errors, text clipped without an ellipsis or pushed off-screen, sideways scroll, and WCAG AA for primary and pill/chip text measured against the pixels behind it (a second shot with text hidden, so glass counts) — and writes contact sheets per mode × device, `sweep.pdf` and `sweep-report.md`. Reports, never fails on a finding. `WINNOW_SWEEP_OUT` (default `web/.sweep`, git-ignored), `WINNOW_SWEEP_PHASE=capture\|sheets`, `WINNOW_SWEEP_MODES` / `WINNOW_SWEEP_DEVICES` for a subset, `WINNOW_SWEEP_JOBS` (3); port 4573 by default. |
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
- `smoke.mjs` — 34 sections. It asserts the rail renders exactly once below the
  search field with `aria-keyshortcuts` in order, that every pill is visible with
  ≥4.5:1 label contrast, that the sidebar scrim's blur falls off identically in
  all directions, that persistence survives a reload, that the theme survives a
  reload with the bundle blocked, that a phone layout has no sideways scroll, that
  swipe actions work through real CDP touches (left trashes with Undo, right toggles
  read, short springs back, vertical scrolls, edge zones and the setting turn it off),
  and that the console stayed empty.
- `sweep.mjs` — the theme sweep above. Each combination writes its own
  `results/<id>.json`, so it runs in chunks (`WINNOW_SWEEP_MODES=oled`) and the
  `sheets` phase stitches whatever is there; sheets and the PDF are drawn by
  Chromium itself, so it needs nothing beyond Playwright.
- `smoke-android.mjs` — the setup walkthrough's Android step and native sign-in's
  fallback, against the same build with a stand-in for Tauri's IPC reporting
  `os: "android"`: the step's package name and SHA-1, field validation, the Web
  client saved beside the Desktop one, and DEVELOPER_ERROR going on to the loopback
  flow. `npm run smoke` runs it after `smoke.mjs`; it runs alone too (port 4174).

The four tests worth reading first, because each exists because a real bug got
out and nothing else would have caught it:

| Test | The bug it pins |
| --- | --- |
| `platform.test.ts` | Tauri rewrites argument keys but never return values, so `authorize_url` read as `authorizeUrl` gave `undefined` and desktop sign-in was impossible — with Google's raw IPC error on screen. |
| `theme.test.ts` | A screenshot cannot tell you a grey is 3.14:1 on white, which is how `inkSubtle` shipped as every section header, row timestamp and status line at 11–13 px. |
| `mapper.test.ts` / `mime.test.ts` | Neither end of a send was tested: quoted-printable subjects rendered as mojibake and `In-Reply-To` went out as a bare Gmail id, so replies threaded in the sender's account and nowhere else. |
| `core/store/scale.test.ts` | A 2,500-message sync must not serialise the mailbox 100 times, a weight change must still reclassify, and archiving or binning one message must reclassify only the affected senders while matching a full pass. |

---

## 12. Environment and named constants

The environment surface is a handful of variables and one build-time constant. Every
numeric constant worth knowing is quoted in the section that owns it: quota and
retry in §5.5, sanitiser limits in §5.8, sync caps in §5.5, proxy limits in §9.

| Name | Where | Effect |
| --- | --- | --- |
| `VITE_RENDER_PROXY` | build time | Turns on the Proxied view and its client. http/https only, read once. |
| `__WINNOW_LOOPBACK_PORT__` | both hosts | Placeholder the web layer writes and Rust substitutes with a real ephemeral port. `oauth.rs` refuses a URL without it. |
| `PORT`, `HOST`, `ALLOWED_ORIGINS` | proxy runtime | Bind address and the exact-origin CORS allow list. |
| `WINNOW_PORT`, `WINNOW_URL`, `WINNOW_CHROMIUM`, `WINNOW_SMOKE_ONLY` | smoke | Point the suite at another port, an existing server, or a system browser; `offline` runs only the offline/undo-send checks. |
| `WINNOW_SWEEP_OUT`, `WINNOW_SWEEP_PHASE`, `WINNOW_SWEEP_MODES`, `WINNOW_SWEEP_DEVICES`, `WINNOW_SWEEP_JOBS` | sweep | Output directory, capture or sheets only, a subset of modes (or `extras`) and devices, parallel contexts. `WINNOW_PORT` (4573) and `WINNOW_CHROMIUM` apply too. |

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

## 13a. Attachments (and no labels)

**No labels.** Labels were removed from the UI after 1.3.0-beta: the owner's call is that
they are for people who stay on Gmail. There are no chips, no Labels section in the
sidebar or the dock menu, no label views and no Label as…. Winnow never changes the
account's labels: the Gmail client has no `labels.list`, `labels.create`,
`threads.modify` or `batchModify` (`core/session/draftFiles.test.ts` pins their absence),
and a label change an older build left in the offline queue is dropped, not replayed.
System labels (INBOX, SENT, TRASH, SPAM, STARRED, UNREAD, DRAFT, CATEGORY_*) still drive
the mailboxes, star, read state and categories through `addLabels`/`removeLabels`.

**Attachments in.** `AttachmentList.tsx`: type icon (`attachmentKind`), name, size, Save,
Open for a PDF (`platform.openFile`: a blob tab on the web, `open_attachment` on the
desktop, the save picker on Android), and raster pictures (never SVG) as thumbnails up to
8 MB with a `Lightbox` (portalled; it swallows the app's shortcuts). Bytes come from
`ui/attachmentBytes.ts`: Gmail, or `core/data/demoAttachments.ts` in the demo.

**Attachments out.** `Draft.attachments` (`DraftAttachment`: base64 `data`, or a Gmail
`source` for a draft reopened from Drafts, read once per session and kept, since a draft's
attachment ids die with its next save). `core/mail/attachments.ts` holds the 25 MB cap
(`planAttachments`, decided on sizes before anything is read) and the device copy's
budget (`forDeviceCopy`: ~1.5 MB of bytes kept in `localStorage`, the rest by name only;
`restoreLocalDraft` names what must be attached again). `ComposerAttachments.tsx` is the
composer's attach button, chips and refusal line; `Composer` only renders it and takes
drops (`onFiles`, desktop). A raw message over 4 MB goes to Gmail's media upload endpoint
(`/upload/gmail/v1`, `multipart/related`) for send and for drafts create/update/send.

Smoke: `scripts/smoke-attachments.mjs` (attachments, and labels staying gone), run by `smoke.mjs` and alone.

---

## 14. What is deliberately not here

- **No second platform implementation.** Three of `Platform` means a rule was
  wrong.
- **No rich text.** Compose, reply and forward send `text/plain` (plus attachments, below)
  through one builder (`core/gmail/mime.ts`); `core/mail/compose.ts` is the new-message
  half: the blank draft, the recipient check, `mailto:`. Forwarding does not carry the
  original's attachments.
- **No component tests.** The layers that are hard to get right (classification,
  the wire, sanitising, the store) are pure and heavily tested; the components
  are covered by the smoke pass against a real browser instead.
- **Drafts are not synced.** The composer autosaves to Gmail drafts (`core/mail/drafts.ts`,
  `DraftAutosaver`: device copy at once, Gmail ~2 s after typing stops, one id per
  draft, `drafts.send` on Send, `drafts.delete` on Discard). The Drafts mailbox lists
  them through the drafts API instead (`listDrafts`: `drafts.list`, then `drafts.get`
  only for a draft whose message id changed, capped at 100), only while Drafts is on
  screen. They live in `StoreState.drafts`, never in `all`, so a sync cannot drop them
  and nothing that reads mail (profile, contacts, notices, mutations) sees one. Opening
  a row reopens it in the composer (`reopenDraft`): a reply on the cached message its
  `In-Reply-To` or thread names, or — original not cached — a message that keeps those
  headers (`Draft.replyHeaders`) and its thread id, so it still threads. Delete in
  Drafts is `drafts.delete`.
- **No path aliases, no router, no state library, no CSS framework beyond
  Tailwind, no date library, no component library.** Each absence is a decision
  recorded in the file that would otherwise have imported it.

---

*Counts and constants in this file were taken from the tree at the time of
writing. Where a file states a reason for its own shape, the reason is quoted;
where this file states one, it is inferred and worth checking.*