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
      avatars/      Contact photos, Gravatar, BIMI logos, the local picture caches (answers and bytes).
      data/         The demo mailbox seed.
      offline/      The offline action queue (§5.10); saving mail offline and the IndexedDB store (§5.10a).
      updates/      Update checks: versions, release assets per runtime, release notes, latest.json;
                    the stable/Beta channels and the pre-release rule (releaseFlags.ts);
                    CHANGELOG.md → release notes (releaseNotes.ts).
    platform/       The boundary. Two implementations (web.ts, desktop.ts), one interface.
    ui/             React components and the pure helpers beside them.
  scripts/          check-version.mjs, bump-version.mjs, smoke.mjs, sweep.mjs, bundle.mjs — see §11.
native/src-tauri/   Tauri v2 shell. Rust. Native bits only. README.md there explains
                   the IPC naming rule, the loopback port and why the build is a
                   script.
proxy/              Optional render proxy. Separate Node service, see §9 and its README.
                   proxy/Dockerfile is its image.
docker/             The Docker images' start-up scripts, see §9a. Dockerfile (web image),
                   docker-compose.yml and docker-compose.proxy.yml are at the root.
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

Four honest exceptions, all deliberate:

| Exception | Why |
| --- | --- |
| `core/session/*` takes a `Platform` as a constructor argument | The session is the seam: it is handed the host's implementation and cannot ask what host it is on. These imports are `import type` and erase at compile time. |
| `core/session/errors.ts` imports `isTauri()` from `platform` | One runtime import, and it is a pure predicate over `window.__TAURI_INTERNALS__`. It exists so an OAuth failure message can say "wrong client type for this build" instead of something generic. |
| `core/mail/proxy.ts` imports `platform/runtimeConfig.ts` | One runtime import of a pure module: it parses the Docker image's `<meta name="winnow-config">` and has no host behind it. Where the render proxy is belongs to the deployment, which is the platform layer's business. |
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
     the account's IndexedDB database (winnow-offline@<id>, core/offline/offlineStore.ts;
     localStorage only on a host without IndexedDB), written in idle time in chunks
     (idleWrite.ts) and at once on pagehide or flush(); a loaded body is never
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
8. rail ranked, counts computed (faceted on    core/classify/filters.ts
   the active filters once one is on)
9. one snapshot                                 core/store/store.ts (derive)
10. React                                       web/src/App.tsx → useStore → components
```

Opening it takes a second path: `store.loadBody` → `backend.fetchBody` →
`client.messageBodyHtml`, written back into the mirror so the message reads
offline afterwards. Bodies are only fetched for what is on screen, plus a
prefetch window — `BODY_RETENTION = 500` messages, the newest 50 unread, and
±2 rows around the open one — unless the mailbox is saved offline (§5.10a), when the
background download has already put every body in the offline store and
`loadMessage`/`fetchBody`/`fetchAttachment` read it from there with no request.

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
The *ranking* stays that way; only the *numbers* on the pills facet on the active
filters and the search once either is on (1.4.0, `railFacets`, see `filters.ts` below).

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
| Snooze and send later (1.4.0, §13b) | `snooze`, `unsnooze`, `wakeDue`, `isSnoozed`, `snoozeFor`, `scheduleSend`, `cancelSchedule`, `updateScheduled`, `claimScheduled`, `permitScheduled`, `forgetAccountRecords`, `keepAccountRecords`, `scheduledSend`, `scheduledSends`, `accountKey` |

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

`preferences.ts` holds the `localStorage` codec for the shared preferences: the
`revivePreferences` reader, and the read-merge-write pair (`loadPreferences`,
`persistPreferences`) that keeps a partial patch from replacing the whole blob (1.4.0:
`accent` may be `"custom"`, and `accentCustom` is the picked colour, normalised by
`normalizeHexColor` and dropped if it is not a hex; blobs from before keep every value
as it was, and `theme-boot.js` names `custom` on `<html>` but leaves its colours to the bundle);
`retiredKeys.ts` deletes keys from older builds on launch (currently
`winnow.mutedFilters.v1`) so a stale list cannot linger.

### 5.2 `classify/` — what a message is

| File | Job |
| --- | --- |
| `classify.ts` | `classifyEmail(email, profile, weights) → EmailSignals`. Pure and synchronous, so a cached classification stays valid across restarts. Also exports `contentBag`, `inboxSearchBag`, `matchesSocialDomain`, `senderRankBonus`, `classifyAll`. |
| `heuristics.ts` | The vocabulary: ten `KeywordTable`s, one `SOCIAL_DOMAINS` table, and the regexes (`promoRegex`, `phishingRegex`, `coercionRegex`, `clickHereRegex`, `financeRegex`, `needsActionRegexes`, `replyRequestRegex`). |
| `text.ts` | `PhraseMatcher` and `KeywordTable`. Word-bounded, never `String.includes` — `otp` inside `hotel` is the reason. |
| `filters.ts` | `matchesBuiltin` / `matchesFilter` / `countAllFilters` / `rankFilters` / `countFacets`. One predicate, shared by the list, the rail ranking and the badge renderer, so a filter and its badge cannot disagree. **Faceted counts (1.4.0):** with nothing on and no search, a pill counts its bucket in the open mailbox (`countAllFilters`, spam-guarded), as before. With one or more filters on, or a search running, `countFacets` (store: `MailboxView.railFacets`) gives each *off* pill the number of messages the list would show if it were turned on too — active filters AND with each other and with the search in `runInboxQuery`, so that is the current result it also matches — and each *on* pill the current result; both use the list's own test (`listedFiltersFor`, no spam guard, so under a search with nothing on an unsafe match still counts in Security, as tapping it lists it). **Under a search** the store (`facetsFor`) first narrows the open mailbox with the list's own search test (`searchTokens` / `matchesSearch` in `pipeline.ts`, over the pass's `searchBags`), then facets (`countFacets(..., searching = true)`), so a chip's number is exactly what tapping it gives under that query. Unsafe is exclusive (`toggleFilter` replaces the filters, the query stays), so an off Unsafe counts Unsafe alone under the search. `railCounts` and the drawer/triage `inboxCounts` never see the search. Memoised per message object (`listedHits`) and per pass (`facetCache`: same active set, search tokens, profile, message and signal objects reuse the result, so a clock tick, a selection or a whitespace/case-only edit rescans nothing, and a keystroke is one pass). `buildPills` takes the facets for the number only; which pills stay on the rail is still decided by the plain counts (the mailbox ranking, so typing a search never reshuffles the rail), so a pill narrowed to 0 by filters or search is dimmed (`data-empty`), never removed, and the digits do not move. `All` has no count and still clears. |
| `scoring.ts` | The **Smart Score**, 0–100, used only for ordering. Fixed, not learned. `recencyWindow` + `relativeRecencyBonus` measure against the newest message in the set, never the wall clock. |
| `weights.ts` | The ten learnable weights, their clamped ranges, and `nudgeWeight`, which returns the *same object* when a move would clip so callers can use identity to detect change. |
| `pipeline.ts` | `runInboxQuery` (search → filter → sort) and `groupThreads`. `searchTokens` / `matchesSearch` are its search test, exported so the rail's faceted counts search exactly as the list does. The hottest function in the app; the classifier never runs inside it. |
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
  built-in line names only what pushed it over the line. Words only, unless Dev
  Options → Show filter scores passes `scores: true` (`store.explainSmartFilters(id,
  { scores })`): then each reason also carries `scores`, from `filterScoreLines` — the
  built-in answer before and after learning, Important's score against
  `IMPORTANT_THRESHOLD`, Unsafe's spam likelihood, and for a corrected filter
  `FilterLearning.scoreDetail` (the decision path, your answer for the message, the
  sender rule and its count, and the naive Bayes working: prior, each clue's capped
  log-likelihood ratio, the words' sum and cap, total log-odds as P(in), support of
  `MIN_SUPPORT`). Read-only: `decide` is unchanged. Tests: `filterScores.test.ts`.
- Storage: `winnow.filterLearning.v1`, `{ version: 1, owner, corrections }`, capped at
  300 corrections, 20 clues each and 1,200 distinct clues (rarest words dropped first).
  Local only, never synced. Per account since 1.4.0 (`winnow.filterLearning.v1@<id>`,
  §5.6 *Accounts*): erased with that account's sign-out; a correction set whose `owner`
  is another address is still dropped (the demo's corrections are dropped on the first
  real connect).
- The demo has two Evri deliveries (`demo-missed-delivery-1/2`) the built-in rules miss
  on purpose; correcting the first moves the second by the sender rule.
- Targeted smoke: `node web/scripts/smoke-filters.mjs` (port 4350 by default).

### 5.4 `model/` — the vocabulary

| File | Holds |
| --- | --- |
| `email.ts` | `Email` (product view) vs `RawEmail` (wire view), `Mailbox = "inbox" \| "archive" \| "sent" \| "drafts" \| "trash" \| "spam" \| "snoozed" \| "scheduled"` (the last two are views, `VIEW_MAILBOXES`, never a message's own `mailbox`; `MAILBOXES` is the six places), `MAILBOX_LABEL`, `EmailCategory`, `Contact`, `Attachment`, `Draft`, plus the loaded-body helpers (`isBodyLoaded`, `keepLoadedBody`, `withLoadedBody`) and `withCode`. |
| `signals.ts` | `BUILTIN_FILTERS` (21, in rail-catalog order), `FILTER_LABELS`, `PERMANENT_FILTERS = ["important", "shipping"]`, `NAVIGATION_ITEMS`, `UNSAFE_THRESHOLD = 0.4`, `IMPORTANT_THRESHOLD = 56`, `isUnsafe`, `isImportant`, `badgeFilters` (the chips in a reader) and `rowIndicators` (the at-most-one word a list row carries). |
| `profile.ts` | `buildUserProfile(inbox, trash)`, also built incrementally (`profileStats` → `updateProfileStats` → `profileFromStats`, integer counts per category so both paths agree exactly; `sendersReclassifiedBy` names the senders a profile change reclassifies): per-sender trash bias (unbounded in the profile, clamped to `MAX_TRASH_BIAS = 0.35` where used), top six correspondents, the quiet tail, and first-time senders. Deterministic, and ties break on the sender name — a ranking that hides mail cannot be a shuffle. |
| `appearance.ts` | `APPEARANCES` (`system \| light \| dark \| oled`; `oled` is the stored value whatever the picker calls it) and `ACCENT_THEMES` (1.4.0: `space \| plum \| rose \| ember \| green \| aurora \| blue \| graphite`, round the wheel, Space the default, Graphite the neutral last), plus `CUSTOM_ACCENT` (`"custom"`, the `accent` preference's ninth value, `AccentPreference`, `isAccentPreference`), `DEFAULT_ACCENT_CUSTOM` (Space's `#5028E2`) and `normalizeHexColor` (`#RGB`/`#RRGGBB`, with or without `#`, to upper-case `#RRGGBB`; anything else null). Names live in `core` because the store persists them and `core` does not import from `ui`. |
| `ids.ts` | `hashId` (FNV-1a/64 truncated to 53 bits, deterministic so a cached classification survives a restart), `threadKey`, `localId`. |

### 5.5 `gmail/` — the wire

| File | Job |
| --- | --- |
| `dto.ts` | The API's JSON and nothing else, plus `GMAIL_API`, `GOOGLE_TOKEN_URL`, `GOOGLE_AUTH_URL`, the base64url codec, `GMAIL_SCOPE`, and `LABEL`. API changes land here and in `mapper.ts`, nowhere else. |
| `client.ts` | The typed `fetch` wrapper. Owns quota pacing and retries. Every verb Winnow uses: `profile`, `list`, `message`, `messageBodyHtml`, `history`, `addLabels`/`removeLabels`, `archive`, `markRead`, `setStarred`, `trash`, `restore`, `markNotSpam`, `deletePermanently`, `send`, `attachment`, `draft`, `listDrafts`, `createDraft`, `updateDraft`, `sendDraft`, `deleteDraft`, and (1.4.0, §13b) `modify` (add and remove labels in one call) and `ensureLabel`, which only ever finds or makes `Winnow/Snoozed`. |
| `sync.ts` | `GmailSyncEngine`: full vs incremental, the cursor, the five capped views, batching, partial publishing. Also defines the two interfaces everything else is written against: `MailboxCache` and `CursorStore`. |
| `mapper.ts` | Gmail message → `Email`. Parses `From` rather than trusting it, prefers plain text over HTML, keeps attachments as metadata, and uses `internalDate` over the `Date:` header. |
| `mime.ts` | RFC 822 out: `buildMime`, `messageIdFor`, `replyReferences`. Getting `Message-ID` / `In-Reply-To` / `References` wrong threads the reply in the sender's account and nowhere else. |
| `tokens.ts` | `TokenManager` over a `TokenStore`. Single-flight refresh, a generation counter so a refresh landing after sign-out is dropped, and `invalid_grant` handled as re-auth rather than retry. Sign-out also revokes the grant at Google (`revokeGrant`): fire and forget with a 5 s timeout, never on an `invalid_grant` clear or in the demo. |
| `pkce.ts` | RFC 7636 PKCE plus `state`, `buildAuthorizeUrl`, `parseRedirect`, `stateMatches`. The verifier never leaves the app; only the challenge does. |
| `pool.ts` | `mapPool` and `TaskQueue` — bounded concurrency, in place of Gmail's `/batch` endpoint (a pool reuses the ordinary request path, including the quota bucket). |
| `people.ts` | The People API client for the two contact listings, with its own quota bucket (60/min) and typed errors: `ExpiredSyncToken`, `PeopleScopeMissing`, `PeopleApiDisabled`. |
| `drive.ts` | Drive v3 for big files as links (`drive.file` only): resumable upload, permissions read/share/revoke, Drive links found in a body (text and HTML), `shareForSend` / `revokeShares`, the demo's `DemoDriveClient`. See §13a. |
| `driveSend.ts` | The decision around Drive at dispatch: `needsDriveGrant` (Send-tap, no network), `prepareDriveDispatch` (share, or hold for the user), `prepareQueuedShare` (the offline queue's replay). See §13a. |
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
| `bridge.ts` | `SessionBridge`: a flat façade the UI uses, plus the two side effects the session cannot do (`store.signOut` when the client changes or the user signs out). Since 1.4.0 it holds one `GmailSession` per account (each over its own scoped cache, cursor, contacts and token store) and `bridge.accounts` (`switchTo`, `add`, `signOut(id)`, `signOutAll`, `setColor`, `setNotify`, `checkInactive`); every other method acts on the open account. `accountEmail` falls back to a placeholder so a launch still opens the cached mail; `verifiedAccountEmail` throws instead, for the demo's "Back to your inbox", which must know the session works before the store leaves the demo. |
| `credentials.ts` | The user's own OAuth client: validation, the two stores (web `localStorage`, desktop keychain), and `testConnection`, which posts a deliberately invalid code and reads the verdict. |
| `clientJson.ts` | Import of Google's downloaded `client_secret_….json`. 64 KB cap, and the exact list of refusals and warnings below. |
| `redirect.ts` | Web-only redirect parsing as pure functions over a query string. A code with no `state` returns `null`. |
| `pendingAuth.ts` | The PKCE verifier in `sessionStorage`, as an array keyed by `state` so two tabs cannot clobber each other. Single-use: `take` removes. |
| `errors.ts` | `describeFailure` — the message and hint for each failure kind. |
| `googleErrors.ts` | Google's setup errors (redirect_uri_mismatch, not a test user, API disabled, invalid_client, missing secret, org_internal, admin policy, …) mapped to a plain title, the fix, and the setup step that makes it. `explainGoogleText` reads a code out of pasted text. |
| `nativeSignIn.ts` | Native Android sign-in's pure decisions. Two clients can own a session now: the main (Desktop app) client, or the Web application client native sign-in names as `serverClientId`, which `TokenSet.clientId` records. `refreshClientFor` picks the one to refresh under; `sessionStrandedBy` says when saving a client must sign out; `browserFallbackScope` re-asks for the session's scopes when the browser's client is not the one that granted them. `GmailSession.authorize` tries `platform.nativeGoogleSignIn` first when a Web client is stored, and falls back to the browser on anything but a code or a cancel, the exchange included. |
| `accounts.ts` | Multi-account (1.4.0): the registry `winnow.accounts.v1` (`{ version: 1, active, accounts: [{ id, email, color, notify, addedAt }] }`, `AccountRegistry`, `MAX_ACCOUNTS = 5`), the namespace rule `accountKey(key, id)` = `<key>@<id>` with `id` a random `[a-z0-9]{4,24}` never derived from the address, `ACCOUNT_SCOPED_KEYS` (every key one account owns), `scopedStorage` (a `Storage` view that reads and writes the scoped copy and passes shared keys through), `tokenSecretName` / `webTokenKey`, and the colour palette (`ACCOUNT_COLORS`: `space`, `plum`, `ember`, `aurora` and the danger hue's `rose`, so five accounts can all differ; written out since 1.4.0, when the accents grew to eight and gained a Rose of their own, so a stored account colour keeps its meaning). |
| `accountMigration.ts` | The one-time move from 1.3.5's single unscoped account, run by `bridge.prepare()` before anything reads an account's data. See *Accounts* below. |
| `lightSync.ts` | The light sync of an account that is not open: its unread count and the new mail to notify about, nothing else. See *Accounts* below. |
| `exchangeRetry.ts` | The end of a native sign-in on a WebView that may be paused (Android, behind the browser): before the code exchange and the profile read, wait for `platform.waitForForeground`, and resend only an attempt that got no HTTP response (`GoogleUnreachable`, or a bare fetch `TypeError` for the profile), backing off 0.5/1.5/3 s. `invalid_grant` and every other answer from Google are never resent. Out of attempts → `SignInUnreachable`: "Couldn't reach Google to finish signing in. Check your connection and try again." |

**The offline cache** (`localCache`). A `Map<GmailId, Email>` mirror in memory,
with storage treated as a *sink*, not a store: mutations coalesce into one
idle-time write. Since 1.5.6 the sink is the account's IndexedDB database
(`core/offline/offlineStore.ts`, §5.10a) wherever the host has IndexedDB (every browser
and WebView Winnow supports); a 1.5.5 mailbox still in `localStorage` is read once, written
to the database, and only then removed from `localStorage`. `localStorage` stays the sink
only without IndexedDB (and in the node test runner). `remove`, `keepOnly` and `replace`
also drop the downloaded bodies and attachments of the messages that went, and `clear`
deletes the database. The rest of this paragraph is the `localStorage` history: The alternative — read, merge and re-serialise the whole mailbox
per upsert — measured 1.36 s and 6.15 MB of allocation over a 100-upsert sync.
Writes are individually guarded because private mode and a full quota *throw*
rather than return; a failure is recorded and surfaced by `flush()` instead of
being swallowed. Past roughly 2,000 messages the origin's ~5 MB quota is the
ceiling, and `persistCache()` is the answer: it asks for persistent storage and
reports honestly when the write still did not stick.

**Accounts (1.4.0).** Up to five Google accounts on one device, one open at a time.

- **Namespacing.** Everything an account owns is stored as `<key>@<id>`
  (`ACCOUNT_SCOPED_KEYS`: the message cache and cursor, the offline queue, Google
  contacts, brand logos, Gravatars, learning, smart-filter corrections, active filters,
  last mailbox, light-sync state). Drafts were already one key per address
  (`winnow.drafts.v1:<address>`). Tokens live in the platform's token store under
  `gmail.tokens@<id>` (keychain, same service) or `winnow.gmail.tokens@<id>` (web). No
  account's data can be read through another's keys. `null` as the id is the device
  itself: the demo, and anything learned with nobody signed in, under the old unscoped
  keys (`store/accountState.ts`, `keyFor`).
- **Shared on purpose:** the OAuth client (one client, many grants), the preferences
  (appearance, sort, notification settings, hidden and muted senders: they describe the
  person, not an account), the setup guide's progress and the reader split.
- **Migration from 1.3.5** (`migrateToAccounts`): with no registry and a stored session,
  the account gets an id (recorded first in `winnow.accounts.migration`, so an
  interrupted run resumes into the same namespace), each scoped key is copied to
  `<key>@<id>`, the tokens are written to the account's own entry, the registry is
  written naming it active, and only then are the old copies deleted. The id, the
  tokens and the registry are each read back first (`persistAccounts` for the
  registry; the normal write-through, `saveAccounts`, stays best effort): any that did
  not stick defers the migration, deleting nothing, so the legacy session is intact and
  the next launch retries into the same id. Nobody signs in
  again; the address is filled in from the learning's owner or the queue's account, or
  on the first profile read. A locked keychain or a failed token write defers it to the
  next launch, moving and deleting nothing. A mail cache too big to copy within the
  quota is dropped with its cursor instead of deferring (copy-then-delete needs it twice
  over, so a big mailbox would defer on every launch); the first sync is then a full one.
  Signed out under 1.3.5: an empty registry (unwritten: deferred, nothing deleted), and
  the learning stays the device's until the first account added adopts it
  (`adoptDeviceLearning`, which removes the device copy only once the account's reads back).
- **Light sync** (`LightSync`): an account that is not open keeps nothing in memory and
  writes nothing to its cache. `bridge.accounts.checkInactive()` runs on every
  background tick: one `messages.list` for `in:inbox is:unread` per account (5 quota
  units), compared with the unread ids the last check saw (`winnow.lightSync.v1@<id>`);
  new ids get one metadata read each, newest first, at most five, for the notification.
  An id counts as seen once its read settles (read, 404, or `MAX_LOOKUP_ATTEMPTS` = 3
  failed checks); a read that fails otherwise stays new (`retry` counts in the record),
  so the next check notifies it, once. One check at a time per account.
  The first check after an account is added or left only records what is there (`seed`),
  so mail already waiting is not news. The count feeds the switcher; failures stay quiet
  until the account is opened.
- **Switching** loads the account's own state (`WinnowStore.enterAccount`: learning,
  filters, mailbox) and cache; a sync of an account that has since been left paints
  nothing.
- **Adding** asks Google's chooser (`prompt=select_account consent`) after the first
  account; adding an account already here switches to it; a sixth is refused.
- **Sign-out of one account** revokes its grant and erases exactly its namespace,
  learning included, and its device drafts (`wipeAccountStorage`), and its snoozes and
  scheduled sends in the shared records, by address, plus sends going out from it by id
  (`WinnowStore.forgetAccountRecords`); every publish of the registry also drops records
  of addresses it no longer has (`keepAccountRecords`); the next account
  opens, or the app is signed out when it was the last. Sign out of all does each.
- **Owner decisions, 1.4.0:** at most five accounts (`MAX_ACCOUNTS`); notifications
  for accounts that are not open are on by default; each account is told apart by a
  colour dot (switcher, Accounts page), changeable; there is no "All inboxes" view, one
  account is open at a time; signing out of an account erases its whole namespace,
  learning and smart-filter corrections included; preferences are shared.
- **Replies go out from the account that received the message** (`mail/fromAccount.ts`,
  the composer's From picker); a reply sent from another account goes as a new message
  carrying the original's `In-Reply-To`/`References` (thread ids belong to one mailbox).

**`signOut()` order matters:** tokens → contacts → pending auth → message cache
(the account's offline database: mailbox, downloaded bodies, attachments) → cursor →
the offline-save answer and the reconciliation clock. The bridge deletes the database
again after the session (`deleteOfflineData`), whatever the sign-out managed. The cursor is last for a specific reason — a cursor left over an empty
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
| `sanitize.ts` | The allowlist sanitiser. 1,400 lines: a hand-written scanner, a CSS walker, and the document builder. `MAX_DEPTH = 64`, `MAX_OUTPUT = 2 MiB`, `MAX_DIMENSION = 4096`. Drops `<script>`, `position: fixed\|sticky`, `z-index` and `@font-face`; `allowRemote` defaults to false. `recolour` (1.4.0, absent = byte-identical output) re-maps colours in `style`, `bgcolor` and `color` through `emailDark.ts` during the walk; `inlineEmailDarkCss(palette)` is the dark baseline under `[data-wn-email][data-wn-dark]`. |
| `emailDark.ts` | Email dark mode (1.4.0). `detectOwnDarkStyles` (an `@media (prefers-color-scheme: dark)` block, `[data-ogsc]`/`[data-ogsb]` hooks, a `color-scheme` meta or property) and `emailDarkMode` → `off` \| `own` (the sender's dark block is honoured, nothing recoloured) \| `adaptive`. Adaptive is partial inversion in OKLCH, hue kept: light paper → the theme surface (`DARK_EMAIL_PALETTE` #252525, `OLED_EMAIL_PALETTE` #000), light greys a step above it (capped at L 0.46); vivid light backgrounds keep hue/chroma at L ≤ 0.48; dark backgrounds kept; text lightness-flipped and lifted to ≥ 4.5:1 on the surface and on its own element's background (same block or `bgcolor`); light borders become dark hairlines. `url()` is masked, images are never filtered. Pure, node-tested. |
| `html.ts` | HTML → text (`plainTextFromHtml`, which cleans: drops `<head>`/`<style>`/`<script>` with their contents, trims lines, collapses blank lines, then `tidyPlainText`; and `literalTextFromHtml`, Pure Plain Text's: tags out, block ends to newlines, entities decoded, nothing else), `tidyPlainText` (invisible preheader filler and its entities, whitespace-only lines, runs of blank lines, leading/trailing blank lines), `decodeEntities`, `sanitizeDisplayName` (strips C0/C1, zero-width, bidi; 128 chars), `parseAddressHeader`, and `remoteReferences` — the remote-image counter the reader offers to show. |
| `plainView.ts` | What the reader's Plain text form shows: `tidyPlainText(body)` normally; with Settings → Dev Options → **Pure Plain Text** (`ui/devOptions.ts`) the `text/plain` part verbatim, or for an HTML-only message `literalTextFromHtml(bodyHtml)`, or a metadata row's snippet as it is. Which one is read from `Email.bodySource` (`plain` / `html` / `snippet`, set by the mapper and carried by `loadedBodyOf`, `withLoadedBody`, `keepLoadedBody`); a cache row from before it existed counts as extracted when `body === plainTextFromHtml(bodyHtml)`. Still a text node and still fetches nothing; only the reader's plain form changes (list previews, the thread's first lines, reply quoting and the classifier are untouched). Tests: `plainView.test.ts`. |
| `rawSource.ts` | Dev Options → **View Original**: `decodeRawMessage` (Gmail's `format=raw`, base64url → UTF-8, tolerant), `mimeOutline` (one line per MIME entity: path, type, charset, transfer encoding, disposition, file name, Content-ID, size; parts are never decoded), `rawSourceText` (outline + the whole source, display capped at `RAW_DISPLAY_LIMIT` = 2 MB; Copy copies everything) and `demoRawSource` (the demo's stand-in, a real `multipart/alternative` marked `X-Winnow-Demo`). Fetched by `GmailClient.messageRaw` → the backend's optional `fetchRaw` → `store.loadRawSource`; shown by `ui/components/RawSourceSheet.tsx` in a `<pre>` text node, never rendered, never cached. Tests: `rawSource.test.ts`; smoke: `smoke.mjs` "dev options: view original". |
| `reply.ts` | `buildReply`, `buildForward`, `quotedBody`, `stripQuote` (a quote is stripped only while it is still an untouched *suffix*). |
| `datetime.ts` | `dayBucket` counted from calendar fields so a 23- or 25-hour DST day is still one day; `formatRowTime`, `daySections`, `formatRelative`, memoised formatters and a 4096-entry cache. |
| `otp.ts` | `detectCode(subject, text)` with explicit false-positive rules for dates, times, prices, percentages, phone numbers, years, postcodes and order numbers. `CODE_CHIP_MS = 5 min`. |
| `unsubscribe.ts` | RFC 2369 + RFC 8058. Keeps at most one https URL and one mailto; `oneClick` is only set when the POST header says so, and Winnow never sends the POST (CORS would refuse it from a web page). |
| `censor.ts` | Blur sensitive info (Settings → Privacy), the pure half. `CensorLevel` is a cumulative step: `off`, `emails`, `passwords` (a value after a password/passcode/PIN label and a separator, or the first word of the next text when markup splits them), `addresses` (street lines, UK postcodes, US state + ZIP), `names` (whole-word matches of `nameTerms`: display names and their capitalised parts). `Scrambler` turns each value into `STAND_IN_LENGTH` (12) random letters, the same for the whole session (case-insensitive, drawn at random rather than hashed), never matching a pattern again and never taken for a password itself, so censored text is never censored twice. `censorParts` splits text for a renderer that blurs each value; `censorNotice` censors a notification's readable fields only. Best effort and display only: nothing here feeds what is sent. |
| `imageConsent.ts` | `ImagePolicy = "ask" \| "always" \| "never"` and `resolveImageConsent`. Three states because there are three intentions, and a grant is for one message id only. |
| `proxy.ts` | The optional render proxy client. The base URL is read once from the **build-time** `VITE_RENDER_PROXY` constant, http/https only — a runtime setting pointing the app at an arbitrary URL is a remote-administration hole. The returned document is mounted in `sandbox=""`. |
| `when.ts` | The times snooze and send later offer, in local time (`whenPresets`: Later today = +3 h rounded up to the half hour, Tomorrow 9:00, This weekend = Saturday 9:00, Next week = Monday 9:00, each left out when it would lie), `formatWhen` ("Today, 18:00"), the date/time fields' codec and `wentLate` (`LATE_AFTER_MS` = 2 min). |
| `snooze.ts` | Snooze records (`SNOOZED_LABEL = "Winnow/Snoozed"`), what is due, early wakes on a reply, abandoned snoozes, woken places (`WOKE_TTL_MS` = 7 days) and `SnoozeOverlay`. §13b. |
| `scheduledSend.ts` | Scheduled-send records (device copy of the draft via `forDeviceCopy`), due/claim (`CLAIM_MS`), and the Scheduled view's rows (`scheduledRow`). §13b. |
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
- `pictureBytes.ts` keeps the pictures themselves (not just their URLs) on the device,
  so a recent sender's avatar draws at once and offline. IndexedDB
  `winnow-pictures@<id>` (one per account; store `pictures`, keyPath `key`, index
  `kind`), keyed by the picture URL (`pictureKey`: https only, Gravatar's size query
  dropped), each a 96px (`PICTURE_BYTES_PX`) WebP/PNG data URL ≤ 24,000 chars (sources over 2048px not captured), tagged
  `contact` / `gravatar` / `logo`. The 200 most recently drawn (`MAX_PICTURE_BYTES_ENTRIES`,
  LRU by `usedAt`, written back at most hourly); fresh for the hit TTL (7 days), a stale
  copy is still drawn and refreshed in the background when drawn online; dropped after
  30 days without a refresh. Warmed into a `Map` at startup (`ready`), so `get` is
  synchronous. Captured by `ui/pictureCapture.ts` (`canvasCapture`: anonymous,
  no-referrer `<img>` → canvas, two at a time); a host without CORS taints the canvas
  and is simply not kept (retried after a day), offline nothing is captured. The avatar
  (`Avatar.tsx` via `usePictureBytes`/`pictureTries` in `ui/senderPictures.ts`) tries the
  copy first, then the URL; a URL already on screen is not swapped for its new copy.
  Gated by `gatedPictureBytes` (inside `senderPictureSources`): with Remote images =
  Never, or Gravatar / brand logos off, those copies are never served or captured.
  Cleared: sign-out (database deleted), account removal (`deletePictureBytes` in the
  bridge), a switch off (`clearKind`), the contacts grant `not_granted` (contact photos).
  None in the demo. Native notifications fall back to the kept copy when the picture
  cannot be loaded (`nativePictures`' `cachedPicture`). IndexedDB helpers shared with
  the offline store live in `core/offline/idb.ts`.
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
cannot undo a waiting change on screen. A send whose Drive links were not shared yet
(`Draft.driveShare` `pending`) shares them just before its replay, and a queued send Gmail
refused takes back the permissions it created (§13a, Big files as Drive links). A label change queued by 1.3.0-beta is dropped
on load, never replayed (§13a). A waiting send's files are written
under the drafts' device-copy budget (`forDeviceCopy`), so one big file cannot overflow
`localStorage` and leave the queue unsaved; this session keeps every byte. Permanent delete is not queued. Sign-out clears
it; a queue saved for another account is discarded. The queue's state shows
as the sync indicator (`ui/components/SyncIndicator.tsx`, rules in `ui/syncIndicator.ts`,
state in `ui/useSyncIndicator.ts`): a small fixed disc in the status pill's row, beside
the pill or where it rests, a spinner while changes go (a still dot under reduced motion),
a still cloud while they wait; its words ("Syncing 1 change…", "Offline: N changes
waiting", `ui/offlineStatus.ts`) are its tooltip and a polite live region. It takes no
room in the layout, waits `SHOW_DELAY_MS` before showing and fades in and out.

A sync that cannot reach Gmail never takes a mailbox off screen (1.6.0): when the store
holds the account's own mail (its offline copy or a sync's result, never the demo seed)
and the failure is not an account problem (`accountProblem`: `reauth_required`, `config`,
`invalid_client`, or a 401/403), `runSync` stays `ready`, sets `connectionLost`, and the
app draws the red "Failed to connect to Gmail. Check your connection." bar
(`data-connection-lost`, also shown whenever the device is offline) over the local copy
while changes wait in the queue. The next sync that gets through clears it. Only a real
account problem, or a first sign-in with nothing cached, still reaches the full-screen
"Couldn't reach Gmail".

Undo send (`core/mail/undoSend.ts`, Settings → Compose → **Undo send window**, Off/5/10/20 s,
10 s by default; a saved 30 s from ≤ 1.2.2 reads as 20 s; "Sending in Ns… Undo · Send now"
in the status pill): if the app closes in the window
the message is **kept as a draft, not sent** — the safe choice, reasoned in that file.
Drive links are shared only when the window ends (§13a), so nothing in the window has
shared anything yet.

### 5.10a `offline/` — saving the mailbox offline, and mail deleted on the server

**The bug this replaced (1.5.5 and before).** The large-mailbox question (`STORAGE_PROMPT`,
"This is a large mailbox, Winnow requires them to be saved, are you sure you would like to
save this?") appears when the mirror cannot be written. The whole mailbox was one JSON
string in one `localStorage` key, and `localStorage` is capped at ~5 MB per origin
(Chromium and the Android WebView: ~5 million UTF-16 characters), a cap that
`navigator.storage.persist()` does not raise. Save asked for persistence and wrote the
same string to the same key, which threw the same `QuotaExceededError`: "Still couldn't
save this mailbox offline." And even a mailbox that fitted held only metadata plus the
bodies someone had opened (sync is metadata-first); attachments were never stored. Because
the cache never landed, the cursor was never written either, so every launch was a full
re-download. Separately, history's `messagesDeleted` was read as `entry.id` while Gmail
sends `{ message: { id } }`, so a permanent deletion was only noticed by the next full
rebuild.

| File | Job |
| --- | --- |
| `offlineStore.ts` | `OfflineStore`: one IndexedDB database per account, `winnow-offline@<id>` (v1; stores `mailbox` — the mirror's JSON under `"messages"` —, `bodies` keyPath `gmailId`, `index` `{ gmailId, bytes }` for counts without reading bodies, `files` keyPath `[gmailId, attachmentId]` with index `gmailId`). A body and its files are written in one transaction. `clearDownloads` (bodies and files only) vs `clear` (deletes the database; a database another page holds open resolves after 3 s with the delete queued). `memoryOfflineStore` for tests, `gatedOfflineStore` (writes dropped after sign-out, like `gatedCache`), `deleteOfflineData(id)`. On desktop and Android the WebView keeps IndexedDB in the app's data directory, as it did `localStorage`. |
| `downloader.ts` | `OfflineDownloader`: walks the local set (every message the cache holds — the whole inbox, the newest 500 of each other view) newest first; per message one `format=full` (or the cache's copy when it was opened already: no second download) and each attachment with an id up to `ATTACHMENT_DOWNLOAD_CAP` = 10 MB, inline pictures included; bigger ones stay on demand. Every request goes through `schedule` — the store's `bodyQueue` at `low`, one at a time, so an opened message (`high`) waits behind at most one download. Resumable by construction: the store's `index` is what is saved. Asks `conditions()` before each message (`offline`, `hidden` on a phone, `metered`, `battery`) and pauses until the next `start()` (every sync). A 404 calls `gone` (removed everywhere); a network/auth/429/5xx error pauses with `reason: "error"` and deletes nothing; any other error skips that message for the session. Batches of `DOWNLOAD_BATCH` = 25 write `offline batch` lines to the Debug log. `stop()` (sign-out, switch, Remove downloads) makes a request already on the wire write nothing. |
| `offlineSave.ts` | The decision: `LARGE_MAILBOX` = 2,000. `offlineNextStep`: an answered account keeps its answer; otherwise a mailbox of 2,000+ messages, or one whose mirror could not be written, is asked the existing question; a smaller one is saved without asking. "Not now" asks again next launch (unchanged). `OfflineBackend` (what the session offers: the store, `decision`/`setDecision` in `winnow.offlineSave.v1@<id>`, `body`, `attachment`, `gone`), `OfflineView` (the snapshot's `offline`), `offlineSummary` ("Saved 1,234 of 1,500 · 312 MB", plus "· up to date" or why it is paused). |

**The store** (`store.ts`, "Offline saving"): `afterSyncOffline` runs after every sync
(ask / save / carry on, then `runOffline`); Save (`saveMailboxOffline`) persists, records
`on` and starts the download; `setOfflineSave` and `removeOfflineDownloads` are Settings'.
`dropBodyWork` stops the downloader, so signing out, switching account and the demo stop
it. Settings → Notifications & sync → **Save mail offline** (`offlineMail`: the same answer,
progress as its hint, `data-offline-mail` / `data-offline-saved` / `data-offline-total`)
and **Remove downloads** (`removeDownloads`, `data-offline-remove`: deletes bodies and
files, keeps the list, turns saving off). The host's conditions come from
`platform/downloadConditions.ts` (`navigator.onLine`, `visibilityState` on Android or a
coarse-pointer phone-width screen, `connection.saveData` / `type === "cellular"`, the
Battery Status API under 20% unplugged; Android's metered-Wi-Fi flag and Battery Saver are
not visible to a WebView).

**Mail deleted on the server** — what counts as gone, and nothing else:

- history `messagesDeleted` (Gmail's `{ message: { id } }`; the bare `{ id }` is still read);
- a re-fetch (sync, or the download) answering **404**;
- absence from a **complete** id listing: `GmailSyncEngine.reconcile` lists every id
  (`messages.list?includeSpamTrash=true`, ids only, 500 a page, `client.listAllIds`) and
  removes local messages that are not in it. It runs after a sync at most once a day
  (`RECONCILE_EVERY_MS`, clock in `winnow.reconcile.v1@<id>`; so also on the first sync
  after a launch when the last is older); a full sync (no cursor, or a history id Gmail no
  longer has, which answers 404 and falls back to `full`) counts as one. It deletes nothing
  on any listing error, past `RECONCILE_MAX_PAGES` = 400 pages, or when more than half of
  20+ local messages would go unless each of `RECONCILE_PROBES` = 3 of them answers 404.
  Only ids the cache held before the listing began are judged.

Trash is a label (a message in Trash is still listed and still synced); deleting from
Trash is a `messagesDeleted`. A network or auth error never deletes. Removal drops the
mirror row, the body, the attachments (`localCache` → `OfflineStore`), the row on screen
(the sync result, or `forgetGone` for a download's 404), and the notification
(`PlatformBridge.withdrawNotifications` → browser `Notification.close()` by tag; Android
`notify_withdraw` → `MailNotifier.cancel`; the desktop leaves its notification to time out).

### 5.11 `debug/` — Dev Options → Debug log

`debugLog.ts`: an in-memory ring of at most `DEBUG_LOG_CAP` = 2,000 lines (oldest dropped),
recording only while Settings → Dev Options → **Debug log** is on (`setDebugLogEnabled`,
set by App from `DevOptions.debugLog`; Hide Dev Options turns it off). Never stored, never
sent, gone when the app closes; Copy and Clear in the viewer are the only ways out. Each
line is `<ISO time> <area> <event> key=value…`, areas `sync` (store `runSync`: start, done
with ms/counts, failed, `removed`; the session's `reconcile` / `reconcile-skipped`),
`offline` (the download: `batch` with saved/gone/failed/bytes/ms/done/total, `paused` with
its reason, `removed` for Remove downloads), `updates` (`useUpdates`: check, result, install, install-failed)
and `notify` (`announce` posted, `routeNotificationAction` action and outcome). Every value
goes through `redactValue`: email addresses become `[email]`, token/key shapes `[token]`,
content-named fields (`subject`, `body`, `snippet`, `from`, …) only their length, and free
text over 80 characters `[text: N chars]`. Viewer: `ui/components/DebugLogPanel.tsx`.
Tests: `debugLog.test.ts`; smoke: `smoke.mjs` "dev options: debug log" (`settings` part,
signed in to `fake-gmail.mjs`).

---

## 6. `web/src/platform` — the boundary

`types.ts` is the whole contract. Fourteen methods (plus three optional notification
helpers, `confirmNotificationAction`, `keptReplies`, `releaseKeptReplies`, that only the
native host has), and a browser cannot do seven
of them properly:

| Method | Browser | Desktop |
| --- | --- | --- |
| `info()` | constant `WEB_INFO` | `invoke("app_info")`, memoised |
| `tokenStore(id?)` | `localStorage["winnow.gmail.tokens@<id>"]` (no id: 1.3.5's `winnow.gmail.tokens`, read only by the migration) | keychain `gmail.tokens@<id>` (no id: `gmail.tokens`, likewise) |
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
- `runtimeConfig.ts` — what a deployment tells the app at run time: a
  `<meta name="winnow-config" content="key=value; …">` in `index.html` (absent in the
  repository, so dev, static hosts and Tauri fall back to the build; a tag, not a script,
  so no inline script and no extra request). The Docker image writes it on start:
  `distribution: "docker"`, `updates` (`auto` | `pinned` | `image`) and `renderProxy`
  (`self` or a URL). `resolveRenderProxy` takes the runtime value first, then
  `VITE_RENDER_PROXY`; `web.ts`'s `updateRuntime` reports the `docker` update channel
  from it. `docker.test.ts` runs the image's scripts against `csp.ts` and this parser.
- `web.ts` adds `readRedirectFromLocation()` and `pendingSignInState()`;
  `desktop.ts` adds `onDeepLink()`, `onTrayAction()`, and Android's `onBackButton()` /
  `exitApp()`.

**Accounts at the boundary (1.4.0).** `notifyNewMail` carries the batch's account
(`{ id, label }`, the label only with more than one account signed in), every
`winnow://notification-action` event names its account, `desktop.ts`'s `keptReplies`
reads anything that is not an array as none, and `deep_link_launch` returns the links the
OS launched the app with so a cold start from a notification's tap is not lost (`main.tsx`
asks once it is listening; an older shell answers nothing).

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
| `MessageList.tsx` | The windowed, day-sectioned list. Flat item union, memoised rows, heights in a `Map` plus a `ResizeObserver`, pinned day headers painted outside the scroller, drag/⌘/shift selection, long-press, sender and row menus, code chips, and the phone's swipe actions (the row is moved by hand with `translate3d`, a backdrop is mounted for the swiped row only, and `touch-action: pan-y pinch-zoom` on the list leaves sideways motion to it). At most one signal word per row; "Urgent" is drawn in the Urgent chip's hue (`.wn-signal-ink`: `FILTER_HUES.urgent` at the mode's `pill.textLightness`, AA-checked by `pillInk` in `theme.test.ts`), the rest grey. Under floating chrome (`topInset`) the rows start below the measured chrome plus a 6px gap (`TOP_GAP`), published on the scroller as `--wn-top-chrome` (padding) and `--wn-top-clear` (`scroll-padding-top`, with the first day's height). The first message is always revealed at scroll 0; a new view (`listView`: mailbox, filters, sort, search) starts at its top; a switch of mailbox or smart filters (`switchView`, `viewKey` alone, so never a sync, a search or a sort) animates across (`useFilterSwitchMotion`); a `j`/`k` while the list is hidden behind the reader is revealed on the way back (`revealIndex`, since the phone shows no cursor). Smoke: `scripts/smoke-top-email.mjs`, run by `smoke.mjs` and alone. |
| `Reader.tsx` | The message pane: back bar, header (avatar → sender menu, sender `h2`, subject as the document `h1`), filter tags, the three-way image offer, body, attachments, then (since 1.3.3) "Why it's here" grouped with the "Not where it belongs? / Change smart filters…" footer at the bottom of the email (`data-reader-filters-footer`; the phone article's bottom padding keeps it clear of the reader pill), the conversation, and the phone dock. |
| `MessageBody.tsx` | Renders the body in the chosen `BodyView`: `rich` (sanitised, inline), `plain` (`core/mail/plainView.ts`, `whitespace-pre-wrap`, `data-plain-text="tidy\|pure"`; `purePlainText` from App via `Reader` is Dev Options → Pure Plain Text), `sent` (`sandbox=""` iframe), `proxied`. The view is per message and is not persisted. **Email dark mode (1.4.0):** given `emailDark` (App passes the palette when the theme is dark/OLED and `Preferences.emailDarkMode`, default on; Settings → Appearance → Email dark mode), the rich card is the theme surface, the container carries `data-wn-dark="own\|adaptive"`, the sanitiser recolours (adaptive) and `scopeSenderCss` unwraps the sender's dark block (own) or recolours its rules (adaptive). A per-message sun/moon button (`data-wn-dark-toggle`, "Show original colours" / "Show in dark", reset per message) restores the white card. Light mode, "As sent" and the proxy frames are unchanged; no per-sender memory. |
| `Masthead.tsx` | Sidebar toggle (a panel icon), the mark as the version toggle (`logoVersion.ts`), search, position readout, prev/next, Compose (no Mark all read anywhere: opening a message marks it read), and the `FilterStrip`. It floats over the list, like the phone's dock: the bar is a rounded glass pill (`.wn-glass.wn-glass-bar`) inset from the pane, each chip its own glass pill (`FilterStrip` `floating`), no band behind either, and the selection bar takes the chips' slot (`replaceRail`) so the header keeps its height. `App.tsx` measures it (`data-list-chrome`) and passes the height to `MessageList` as `topInset` (top padding, `scroll-padding-top`, the pinned day below it, the cursor's reveal clearing it); the briefing is the list's in-flow `lead`, scrolled away with the mail. Its `searchRef` must be the same ref the keybind handler holds, or `/` silently does nothing. |
| `FilterStrip.tsx` | The rail of pills: sticky leading mark, `All`, edge fades and step chevrons. Fades are `pointer-events-none` — a gradient that eats clicks at the edge is the worst possible bug in a filter rail. With `touch` (the phone) it is the floating rail instead: no band, no fades, each chip its own Liquid Glass pill (`.wn-chip-glass.wn-liquid`, its frost on the chip itself since 1.4) at the dock's side insets, over `.wn-rail-haze` (PhoneChrome: a 5px blur with no tint, masked to fade out above and below, so the gaps soften what is behind and show no band), and taps between chips fall through to the list. Switching a pill on or off eases (~190ms, `--wn-chip-motion`/`--wn-chip-ease`): its tint, ring and a soft glow in its own hue are registered numbers in `index.css` (`@property --pill-a`, `--pill-ring-a`, `--pill-glow-a`, `--wn-chip-plate`), because the glass chip's tint is a gradient layer, which CSS cannot interpolate; every chip state shares one shadow list for the same reason. No press scale (1.3.3). |
| `MailNav.tsx` | The sidebar overlay: Inbox with its thread count, then the other mailboxes in `MAILBOX_ORDER` (`ui/mailboxNav.ts`: Snoozed, Archive, Sent, Scheduled, Drafts, Trash, Spam; the two 1.4.0 views count what they hold), an account footer carrying Settings, and the progressive scrim blur. On a phone it is the dock's pill grown upward (`data-morph`: same left edge, width and bottom as the pill, revealed by a `clip-path` from the pill's shape, in the dock's frost) with no app-name header, icon rows, the current mailbox on a pill and the list upside down (account + round Settings gear on top, the gear in the Expand chevron's column: the touch account row is the dock pill's own three-cell grid inside `px-1.5`, the account spanning two cells and the 48px gear centred in the third, so its centre is the chevron's to the pixel in either hand (the panel shares the pill's edge, width and border; `smoke.mjs` and `smoke-thumb.mjs` measure it within 1px), a divider, then the desktop order upside down: Spam, Trash, Drafts, Scheduled, Sent, Archive and Snoozed (`PANEL_ORDER`, derived from `MAILBOX_ORDER`), Inbox last on the pill's line, stopping a cell short so the dock's Expand chevron sits beside it on top of the panel); the scrim uses the same four-layer recipe as the desktop, spreading from the middle of the panel's right edge. Always mounted so it can animate out; `role="dialog"` and `inert` only while open. |
| `SettingsPanel.tsx` | Settings. Sections: Google account, Reading, Appearance, Background, Google contacts, How Winnow sorts, hidden senders, and last **Dev Options** (`dev`, hidden until unlocked: ten taps on About's version label (`data-version-label`, a button that does nothing else on a tap; the top bar's version shortcut and update button are untouched), a `role="status"` toast counting down from the seventh tap ("3 taps away from Dev Options" … "Dev Options unlocked"); **Hide Dev Options** at the bottom of the section re-locks it and turns every switch off. Maintainers only: not in the README or user docs. Native builds (`updateButtonShown`) also get **Send test notification** (`testNotification`, `data-dev-test-notification="idle|sending|sent|denied|failed"`, the result as its hint; see §8.3) and **Check now** (`devCheckNow`, `data-dev-check-now="idle|checking|offer|current|failed"`: About's `updates.checkNow`, so it ignores the timer and the automatic-check switch and resets the load count; the answer inline from `ui/devCheckNow.ts` `devCheckView`: "Update available: X (you have Y)", "No updates available", "Couldn't check[: reason]"; it never installs) and the **Beta updates** switch (`betaUpdates`, `betaAvailable`: `macos`, `appimage`, `deb`, `android` only; see §9b). Switches: Debug log (`debugLog`: records sync, update and notification events in memory, redacted, with a viewer below it; `core/debug/debugLog.ts`, `DebugLogPanel.tsx`), Show filter scores (`filterScores`: "Why it's here" in the reader and the filter picker also shows each line's numbers, `data-filter-scores`; `core/learn/filterExplain.ts` `filterScoreLines`), View Original (`viewOriginal`: the reader's ⋯ menu gains View Original, `data-reader-view-original`, which opens `RawSourceSheet`; see `core/mail/rawSource.ts`), and **Pure Plain Text**, `setting="purePlainText"`, its one-line hint named by the switch's `aria-describedby`; smoke: `smoke.mjs` "dev options" in the `settings` part). Keyboard shortcuts is left out on a touch-only device until a hardware key is pressed (`physicalKeyboard.ts`, kept for the session). Since 1.5 Google account keeps one **Accounts** row (`setting="accounts"`: a count and Manage) that opens the Accounts page; the per-account controls moved there. `initialCategory` opens a category (on a phone, straight to its page). |
| `DebugLogPanel.tsx` | Dev Options → Debug log's viewer, under its switch: "N of 2,000 lines, recording / not recording", **Copy** (`data-debug-log-copy`, the whole log via `ui/clipboard.ts`) and **Clear** (`data-debug-log-clear`), and the lines in a `<pre data-debug-log-text>` text node, newest last. Reads `core/debug/debugLog.ts` through `useSyncExternalStore`. |
| `AccountSwitcher.tsx` | The switcher sheet (1.4.0) from the avatar in the phone top bar and the desktop sidebar header: each account (avatar, address, colour dot, unread), one tap switches; Add account with the Testing-mode note, Open demo inbox, and Manage accounts (`data-account-manage`), which opens the Accounts page. `AccountButton` and `AccountDot` live here too. |
| `AccountsPage.tsx` + `accountsPage.ts` | The Accounts page (1.5): `store.setOverlay("accounts")`, opened by the switcher's Manage accounts and Settings → Google account → Accounts. Phone: a full-screen opaque sheet behind the floating dock (App hides and inerts `main` as for Settings, and the dock treats it as Settings), 44px+ rows; desktop: a centred 520px panel. A list of every account (avatar, address, dot, unread or "Open now") → one account's page: Switch to this account (closes the page), Colour (one radio group, arrow keys), Notify when not open, Sign out of this account (App's `confirmSignOutAccount`: asked first on a phone, revokes). Then Add account / Connect Gmail (`MAX_ACCOUNTS`, `ACCOUNTS_FULL` / `ADD_ACCOUNT_HELP`), Open demo inbox, the Google client (Set up / Change → the Google account sheet), Google account settings (Settings on that category), and Sign out of all (two or more accounts). In the demo it lists the demo's two accounts with Connect Gmail and nothing to sign out of. Escape and Android's Back step from an account's page to the list, then close. The rules (`accountsPageModel`, `accountStatusLine` (shared with the switcher), `accountDetail`, `resolveView`, `accountsBack`, `accountsSummary`) are tested in `accountsPage.test.ts`; the catalog's `accountColor` / `accountNotify` copy shows in its (?) popovers. Smoke: `smoke-accounts.mjs` part 6, desktop and phone. |
| `SelectMenu.tsx` + `selectMenu.ts` | The Settings dropdown for many-valued settings (sort, undo send, remote images, mode, sync interval): a pill trigger (`role="combobox"`) and a listbox on the menu surface, placed by `placeMenu`; ↓↑ Home End, type-ahead, Enter/Space, Escape (closes the list, not Settings). On/off stays a switch, Accent stays swatch cards (`RadioCards`, which wrap since 1.4.0: cells of at least 6.25rem, so nine accents are three rows of three on a phone). |
| `WhenPicker.tsx` | "Pick date & time…" for snooze and send later (`WhenPicker`: native date and time fields, refused in words when past) and `ScheduledSheet`, a Scheduled row opened (Edit, Send now, Cancel schedule). |
| `Composer.tsx` | Reply, forward and new message: recipients, subject, body, ⌘⏎, Send (with Send later beside it since 1.4.0: a split chevron on the desktop, a clock and a long press on the phone's Send circle; the menu says Winnow must be open) and Discard, the Reply / Reply all toggle and the draft status. Three layouts: docked at the bottom of the reader pane (desktop reply and forward, not modal, its own Escape), a centred sheet (desktop new message), full screen (phone, everything). |
| `GoogleSetup.tsx` | The five-step BYO-client guide: console deep links, exact scopes and redirect URI with copy buttons, ticks and a resumable half-finished setup (`setupProgress.ts`), "Continue in demo" on every step; paste, import by file, drop or paste-into-field; test; save; connect. |
| `SetupTroubleshoot.tsx` | `SetupFix` (a Google error as a plain fix plus a link back to its step) and "Google showed an error?" on step 5, which explains text pasted off Google's own error pages. Both read `core/session/googleErrors.ts`. |
| `CustomAccentField.tsx` | The custom accent's field under the accent cards (1.4.0): the native `<input type="color">` (drawn round, `.wn-color-well`) and a hex text field (committed on Enter or blur; not a colour puts the old value back), plus the "Adjusted slightly for contrast" note when the mode on screen moved the colour. The Custom card opens the native picker in the same click (`openRef` → `showPicker()`), so the field stays in the page visually hidden (`sr-only`, `aria-hidden`, out of the tab order) until Custom is the accent. Until then the card's swatch is a soft conic wheel of the curated hues (`CUSTOM_SWATCH_IDLE`). |
| `InboxClear.tsx` + `InboxClear.css` | The good-news empty states. Clear (Inbox empty, or only held-back junk left, or one smart filter worked to the end): `AppMark single` (only the leading plane, recentred) at the end of a dashed trail in accent light, a time-of-day line, and a one-time motion plus a phone haptic when the last row goes (`useClearCelebration.ts`; nothing moves under reduced motion). Quiet (empty folder, or filters that match nothing): one line and the remedy. `inboxClear.ts` decides which and what they say; search keeps `MessageList`'s own remedy screen. |
| `ComposeFab.tsx` | `ComposeButton`: the phone's round compose pencil in the accent (Liquid Glass since 1.4: `.wn-liquid-accent`), a circle as tall as the dock's pill, beside it in the dock's bottom row (it used to float over the list and cover rows). `App.tsx` decides when it is offered. |
| `RecipientField.tsx` | The composer's To, Cc and Bcc fields: chips plus an ARIA 1.2 editable combobox. Nothing is highlighted until an arrow key, Tab only accepts after navigation (WCAG 2.1.1), Escape is consumed only while the list is open. |
| `Overlay.tsx` | `Sheet`, `ConfirmDialog`, `SheetHeader`. Focus moved in and restored on unmount, Tab trapped by `getClientRects()` (because `offsetParent` is null for a fixed element). `ConfirmDialog` exists because `window.confirm` is unimplemented in a Tauri webview. `backdrop="opaque"` (`.wn-backdrop-opaque`) paints chrome instead of the scrim, for a panel that replaces the screen: phone Settings, where the app also hides and inerts `main` (`data-covered`) so no frame of the entrance shows the inbox. |
| `Menu.tsx` | The WAI-ARIA menu pattern, including submenus. Every other key is swallowed so the app's global shortcuts cannot fire while a menu is open. |
| `menuPlacement.ts` | `placeMenu` and `MenuAnchor` as pure geometry, kept out of the component module so they test without React. |
| `NavigationPalette.tsx` | The `!` palette: inbox, spam, trash, sent, drafts, settings. It is a `menu`, not a `dialog`. |
| `PhoneChrome.tsx` | `PhoneTopBar` and `PhoneDock`. Below `sm` the masthead is replaced, not squeezed; all targets are 44 px. The top bar is one row, the mark then search (placeholder "Search <list>"); the list's name and count are a visually hidden `h1`, so mail starts higher. Since 1.2.3 it floats over the list like the dock (`data-phone-chrome`, the mark and search each their own glass, no band): `App.tsx` measures it and passes the height to `MessageList` as `topInset`, the demo strip moves into the list's `lead`, and the pull indicator comes down from under it. The mark is the version toggle (`logoVersion.ts`, shared with `Masthead`): it crossfades search for "Winnow <version>" (`PlatformInfo.version`, never a literal), `aria-pressed`, a haptic tick on the phone; search stays mounted, and `/` or focusing it brings it back. The dock floats over the list (after Linear's Android app): a glass pill with two icon-only tabs (Inbox with its unread badge, Sent) and an Expand chevron ("More mailboxes", `aria-expanded`), the compose circle beside it, the filter chips floating above, and a small glass "Top" pill ("Back to top") centred above the chips once the list is more than a screen down (`backToTopVisible`; hidden over the expanded panel, a selection or an overlay, and taking no taps while hidden; while shown it counts in `--wn-phone-dock`, so the last row clears it). Expand opens the menu panel; Inbox tapped while current scrolls the list to the top. It publishes `--wn-phone-tabs` (pill top, where Settings' sheet stops) and `--wn-phone-dock` (chrome top, the list's end padding in `index.css`). Geometry is `--wn-dock-*` in `index.css`, shared with the panel. |
| `PullRefresh.tsx` | Pull-to-refresh on the phone's list, which replaces the briefing strip once an account is connected (the demo and a disconnected phone keep a compact one-line strip with Connect Gmail). Past the threshold it ticks, then spins on the same action as Sync now and hands the result ("Synced just now · N waiting on you", or the error) to the status pill, which says it in the same place and glass. The rules live in `pullRefresh.ts`. |
| `StatusPill.tsx` | The one in-app notification surface: the pull's frosted pill (`.wn-glass.wn-glass-bar`, full round), fixed and centred over the list's pane just under its chrome (the phone's top bar or the desktop's floating header, `+16px`), or under the window's safe area when the list is hidden (a phone reading, a narrow window with the reader open), so it never meets the dock or its chips and pushes nothing down. It shows one notice, newest first: a send in its undo window (Undo, Send now, a countdown), the store's undo offer (Undo, Dismiss), a flash (Dismiss) or a pull's result; when an action notice ends it says the sync line for `SYNC_RETURN_MS`, then goes. One always-mounted polite live region says each notice once (never the countdown). It takes the list pane as an element (App's callback-ref state), not a ref, so it re-measures whenever the pane mounts again (sign-out → demo). The sync indicator (`SyncIndicator.tsx`) rides in its row: a 28px disc 8px right of the pill, or centred where the pill rests. Rules in `statusPill.ts`. |
| `SelectionBar.tsx` | The batch bar, using the same `archiveLabel` and `moveTargets` helpers as the row menu so the two cannot disagree. |
| `Avatar.tsx` | Contact photo → Gravatar → BIMI logo → monogram, each from its kept copy (`core/avatars/pictureBytes.ts`) when there is one, then its URL. Every picture is an `<img>`; the monogram stays present under a loaded logo so a transparent logo does not let the letter through. |
| `ShortcutSheet.tsx` | The cheat sheet, rendered from `BINDINGS`. |
| `CodeCopy.tsx` | The code chip in a row and the code bar in the reader. |
| `ErrorText.tsx` | Selectable failure copy, collapsed under a disclosure when long — the one text in the app a user needs to copy. |
| `ReaderSplitHandle.tsx` | The list/reader divider at `lg` and up: pointer-captured drag, arrow keys, double-click reset. It writes `--wn-reader-split` on `main` so a drag never re-renders the app; `index.css` clamps the pane's width from it. |

### 7.2 Pure helpers worth knowing exist

| File | Why it is separate |
| --- | --- |
| `theme.ts` | Every colour and the machinery that mirrors it to `--wn-*`, plus the contrast functions `theme.test.ts` uses. The accent rule (1.4.0, Notion-like): an accent theme changes only `ACCENT_TOKENS` (`accent`, `focusRing`, `onAccent`, and `danger`/`dangerWash` for Ember, whose danger is a crimson, and Rose, whose danger is an orange-red: each keeps danger a red 40° of hue from the accent), so it colours what you act on and emphasis (primary buttons, compose, Send, links, switches, the selected segment and swatch, focus, unread dots and badges) and never the neutrals: planes, inks, lines, scrims and the selected row (`surfaceSelected`, a neutral step between hover and pressed) are the mode's own, identical across accents and near-neutral in every mode; `theme.test.ts` holds both. Smart-filter chip hues are signal colours, not the accent. A screenshot cannot tell you a grey is 3.14:1 on white, which is how `inkSubtle` shipped. The eight curated accents (1.4.0 added Rose, Green, Blue, Graphite) are hand-tuned per mode in `ACCENTS`; the chromatic ones stay 30° of hue apart and Graphite, the near-neutral, is held apart by saturation and a slate tint instead. `paletteFor(mode, "custom", hex)` / `applyTheme(root, mode, "custom", hex)` paint a picked colour through `customAccentFor` (memoised `deriveCustomAccent` over `customAccentContext()`: the planes, inks, wash cap, compose tint, the curated accents' luminance band, the three dangers, and `glassReadsOver`, the glass arithmetic of `glass.test.ts` as a predicate). The colour maths itself (`relativeLuminance`, `contrastRatio`, `composite`, HSL, OKLCH with chroma-reducing gamut mapping, `oklabDistance`) lives in `color.ts`, re-exported here, so `customAccent.ts` can use it without an import cycle. |
| `customAccent.ts` | The custom accent (1.4.0) as one pure function, `deriveCustomAccent(hex, context)`: per mode, the picked colour moved in OKLCH lightness only (hue and chroma kept, chroma lowered only where sRGB cannot hold it) to the nearest lightness where it is text on every plane at 5:1 (the curated floor; bare AA measured 4.25:1 on the drawer as painted), its label (white or the mode's near-black, whichever is stronger) reads on it, the compose circle's icon keeps 3:1, the wash keeps the row inks AA, its luminance sits inside the curated accents' band and the glass reads over it (`backdropOk`). Danger: the mode's own red, or the farther of Ember's crimson and Rose's orange-red, 40.5° of hue away; a red pick turns its hue the least it must. `adjusted[mode]` (OKLab distance > 0.02) drives the picker's "Adjusted slightly for contrast". `customAccent.test.ts` walks 663 colours (the cube's corners, #FFFF00/#000000/#FFFFFF, greys, every curated accent, a 6×6×6 grid, 400 seeded random) × three modes against the full AA set, glass included. |
| `rail.ts` | `buildPills` (plain counts decide which pills stay; `railFacets`, when a filter is on or a search is running, the number shown), `digitFor`, scroll geometry. Separate from `FilterStrip.tsx` because exporting a plain function from a component module breaks fast refresh. An active sender pill is never hidden. |
| `selection.ts` | Selection arithmetic and the `LongPress` state machine (`LONG_PRESS_MS = 450`, `TOUCH_SLOP = 10`, `EDGE_SCROLL_ZONE = 40`). |
| `swipe.ts` | Swipe actions as pure logic: `SwipeGesture` (edge zones `EDGE_PX = 24`, axis lock after `AXIS_LOCK_PX = 10`, commit past `COMMIT_FRACTION = 0.38` of the row or a fling ≥ `FLING_VELOCITY = 0.6` px/ms over ≥ 40 px) and `swipeActionsFor`, which says what each direction does per mailbox: left is Trash, right toggles read; in Trash left restores to the Inbox; in Drafts left discards (with Undo) and right does nothing. Touch only, phone layout only, off in select mode and under any menu, sheet or dialog; Settings → Reading → Swipe actions turns it off. |
| `pullRefresh.ts` | Pull-to-refresh as pure logic: `pullAllowed` (connected, list at the top, no dock panel, selection, overlay or sync under way), `pullIntent` on `swipe.ts`'s axis lock so a pull and a row swipe never both fire, the rubber band `pullDistance` (threshold `PULL_THRESHOLD = 70`, max `PULL_MAX`), the threshold tick and the phases. |
| `demoResume.ts` | The demo's way back to a stored session: the button's wording (`demoCtaLabel`: Connect Gmail, Back to your inbox, Sign in again) and what a failed resume means (`resumeFailure`: an expired grant shows `SESSION_EXPIRED` and the button signs in again; an unreachable Google keeps the session). App adopts the session without a Google sign-in or a revocation, checking it with a profile read first so an expired one never takes the store out of the demo. |
| `readerPill.ts` | The phone reader's floating action pill as pure logic: when it folds to the ••• circle (reading down) and opens again (scrolling up, at the end, on a tap), and the left-handed mirror (Settings → Appearance → Left-handed moves it and the compose button to the left). |
| `readerSwipe.ts` | A sideways swipe on the phone reader pill as pure logic (STRM-324): left steps to the next (older) message, right to the previous, by `store.moveCursor` like the masthead arrows and `j`/`k`. `PillSwipe` reuses `swipe.ts`'s edge zones, axis lock and who may swipe (finger, stylus tip); a step needs `STEP_COMMIT_PX = 64` or a flick ≥ 0.5 px/ms over ≥ 28 px; the pill follows 40% of the finger (max 36 px) and gives at most 8 px at either end (no wrap). A press that became a swipe swallows its click. |
| `updateButton.ts` | The update button beside the version shortcut (1.5.5; `components/UpdateButton.tsx` draws it in the phone top bar and the desktop floating bar) as pure logic: one button walking Check for updates → Checking… → Update (a newer release) or No updates available / Couldn't check, back to Check for updates after `NOTICE_MS = 3000`; Update runs `useUpdates().install` (Updating… while it works). `updateButtonShown`: native builds only (`macos`, `appimage`, `deb`, `android`, `manual`), never the web build or the Docker image. |
| `loadCheck.ts` | The every-tenth-load update check as pure logic. Every load of the app counts (cold launch, Android's resume reload, a page reload), once per bundle run, in `winnow.updates.loads.v1`; the load that brings it to `LOAD_CHECK_EVERY = 10` runs `useUpdates`' usual background check, which never blocks startup, fails silently, and on a newer release puts the version shortcut's button in Update and announces it once in the status pill (nothing installs by itself). Native builds only (`updateButtonShown`), only with "Check for updates automatically" on, online, and with no check already running; a due load that cannot check keeps the count (capped at 10). Any check that runs, "Check for updates" included, resets it. Automation never checks by itself unless the page sets `window.__WINNOW_LOAD_CHECK__` (`smoke-android.mjs` 1c). |
| `statusPill.ts` | The status pill as pure logic: `currentNotice` (newest wins; a tie goes to a waiting send, then an undo, a flash, the sync line; an older notice still on offer comes back when the newer goes), `returnsToSync`, `noticeKey`, the countdown text and the screen-reader announcement. |
| `filterMotion.ts` | The list's half of a mailbox or smart-filter switch as pure logic: `shouldAnimateSwitch` (a real switch, the list shown, no reduced motion, Web Animations present), `leavers` (on screen before, not mounted after), `arrival` (slide by the difference, fade in if new or if it would cross more than a screen, else leave alone), `staggerDelays` (≤ 20ms a step, capped so everything is done by 250ms), the keyframes and the timings: leave 130ms + ≤ 40ms stagger with a 2px blur, slide 200ms after a 20ms beat, enter 140ms from 30ms at 16ms a row. `components/useFilterSwitchMotion.ts` is the DOM side: a snapshot of the mounted rows' boxes and ghosts taken in the switching render (the only moment the old rows are still there), played in a layout effect once the window has caught up with the jump to the top, all Web Animations, and a new switch cancels the last one's before measuring. |
| `rowExit.ts` | A row leaving by archive, delete or a move: `exitRows` lays a fading ghost over it (180ms) while the store removes it at once. `ghostOf` builds the ghost (a clone stripped of ids, `data-*`, `aria-*` and titles, `inert`, fixed and clipped to the list), shared with the filter switch so row queries never find one. |
| `windowing.ts` | Variable-height windowing arithmetic (`ESTIMATED_ROW_HEIGHT = 53`, `OVERSCAN = 6`). No fixed-height virtualiser, because rows are 53–82 px. |
| `syncStatus.ts` | The sync line and button text as one pure function, with a documented precedence order. |
| `bodyViews.ts` | Which "Show as" options exist for this message — two instead of four when there is no HTML part. |
| `filterColors.ts` / `filterIcons.tsx` | A hue and saturation per bucket (never a finished colour), and one icon + one reason. `important` is a Bookmark, not a star, because the row's star is a control. |
| `senderPictures.ts` / `avatar.ts` / `demoPictures.ts` | Avatar sourcing as a context, plus the pure hash that gives a sender a stable tone. |
| `sidebarOverlay.ts` | The idle-close policy (all seven conditions must be false) and the scrim recipe (one recipe for the desktop sidebar and the phone's menu panel; both spread from the middle of the panel's right edge). |
| `phoneDock.ts` | The dock's rules: the two tabs, Expand's name, a tab tap selecting or scrolling to the top (never opening the menu), the badge cap, the panel's reversed order, and the two published custom properties. |
| `mailboxNav.ts` | `MAILBOX_ORDER`, the desktop sidebar's top-to-bottom row order. Presentation, so it lives in `ui`: the store validates restored navigation against the model's set of mailboxes and views (`isMailboxOrView`), not against this order. |
| `glass.ts` | The glass, one universal recipe since 1.4. Lean glass (`.wn-glass`, `.wn-glass-bar`, `.wn-chip-glass`): a translucent tint of the mode's glass base with a light frost straight on the element, blur 6px + saturate 1.8 (`GLASS_BLUR`, `--wn-glass-filter`; every floating pill also eases its background, opacity and transform over ~200ms and presses to 0.97, off under reduced motion), a 62% rim, and the raised tint behind text (`text`, `textOn`) that `glass.test.ts` holds to AA for every chip over the worst backdrop that can scroll under it, plus `bar`, the desktop bars' tint, held so `inkMuted` ("of 39") is AA too (the reader pill, over a message, takes it too, so its icons hold 3:1 over a solid photo), and the no-`backdrop-filter` fallback. Liquid Glass (`.wn-liquid`, `LIQUID`) on the small floating chrome (dock pill, compose circle (`.wn-liquid-accent`, the accent at `COMPOSE_TINT`), filter chips and All, reader pill, the desktop's floating top bar, status pill): the same tint, plus a lit rim, a sheen (`::after`, light mode only: in the dark modes any white over the words would cost AA) and, in Chromium only, an edge refraction through the SVG filter `#wn-liquid` in `index.html` (`LIQUID_FILTER`: one displacement, no chromatic fringe, which cost three passes and stalled frames; the edge map is built in px from the glass's own box, so within ~10px of each side the backdrop bends inward on any size of glass; an `feImage` map in `objectBoundingBox` units stretched with the box and bent outward). Apple's `-apple-visual-effect` material replaces it where WebKit offers it (a guarded `@supports`). Large panels (the phone's menu panel, sheets) stay lean. The accent's wash (`WASH`, `.wn-backdrop` on the list pane and the pinned day; the scroller and day headers are see-through): two barely-there radial glows of the accent over the surface (light 7%/6%, dark 6%/5%, OLED 5%/4%; capped in `glass.test.ts`), held so every row ink stays AA: the one large area the accent reaches. `WORST_BACKDROPS` lists every curated accent per mode by hand (`theme.ts` imports this file); `glass.test.ts` checks it against `ACCENTS`, and a custom accent must pass `glassReadsOver` in `theme.ts`. Published as `--wn-glass-*`, `--wn-liquid-*`, `--wn-wash-*` by `applyTheme`. Nothing above a glass may be a backdrop root (opacity < 1, filter, mask, clip-path). A glass that opens a fixed-position menu from inside itself (the reader pill's More, the desktop selection bar's Move to) is `.wn-glass-behind`: its tint and frost sit on an inset-0 `::before`, since a `backdrop-filter` on the element would make it the containing block of the menu. The two deliberate outliers: the desktop sidebar's progressive blur and the phone rail's haze. (1.2.3–1.3.4 put the frost on an oversized `::before` reaching 44px past each pill; gone.) |
| `menus.ts` | Both menus' contents as data, so the rules are unit-tested rather than trapped in JSX. |
| `backLayers.ts` | Android's Back as data: which layer one press closes (popover → sheet → composer → sidebar → Settings → message → leave), so the order is a test, not whichever handler ran first. |
| `devCheckNow.ts` | Dev Options → Check now's inline answer, `devCheckView(asked, status, offer, message)`: nothing until pressed, then Checking…, Couldn't check (with the reason; ahead of an older offer), Update available, No updates available. Tests: `devCheckNow.test.ts` (including that the row never installs); smoke: `smoke-android.mjs` 1d. |
| `devOptions.ts` | Settings → Dev Options: `loadDevOptions` / `saveDevOptions` for `winnow.devOptions.v1` (`{ version: 1, unlocked, ...DEV_SWITCHES }`, this device only, shared by every account; locked reads every switch as off, and locked is saved as no entry), `devUnlockTap` (the ten-tap unlock and its toasts), `hiddenDevOptions` (Hide Dev Options; it turns Beta updates off too), held in App's state (followed across windows by the `storage` event) and passed to Settings and the reader. Tests: `devOptions.test.ts`. |
| `readerSplit.ts` | The reader's share of the width as a fraction (default 0.38, saved under `winnow.readerSplit.v1`), its 280 px list / 360 px reader minimums resolved per width, and the handle's key steps. |
| `censorDom.ts` / `useCensor.ts` | Blur sensitive info on the page: one `MutationObserver` over the document scrambles what the level covers in text nodes in place (by `nodeValue`, so React's own nodes stay valid) and in `title`/`aria-label`/`alt`/`placeholder`/`href`/`data-tip`, marks an element whose text is only a sensitive value `data-wn-censored` (blurred in `index.css`), wraps each value in a message body's rich HTML in its own blurred span, and never edits an input, textarea or `contenteditable`. Turning it off restores what it changed. `originalAttribute` hands a click handler a link's real target; `censorHtmlDocument` censors the sandboxed frames' `srcdoc`; `censorNameTerms` gathers the names for the `names` step from the mailbox and address book; `useCensorActive` (a key that changes with the level and names) re-renders the plain-text body and those frames. Smoke: `scripts/smoke-censor.mjs` (part `censor`), including a reply sent while censored reaching the real address. |
| `useStore.ts` / `useOnline.ts` / `usePhoneLayout.ts` | The three hooks. `useStore` caches the snapshot against the store's key; `usePhoneLayout` publishes the on-screen-keyboard inset as `--wn-keyboard`. |

**1.3.3 additions.** `emailFit.ts` scales a fixed-width HTML email (a table or body wider
than the reader) down to the reader's width, as mail clients do, instead of clipping it
on a phone. Remote images = **Never** also pauses Gravatar and brand-logo lookups (in the
app and in notification pictures; Settings shows a "Paused" hint on both rows). Smart
filters apply to the open mailbox (Trash, Spam, Archive count and list their own mail;
an empty chip steps back to All). The filter strip has no motion blur while scrolling,
and a held chip stays a pill (a sheen, no press scale). Native notifications draw the
sender's picture (desktop writes it to a cache file; Android Kotlin decodes the bytes).

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
| `notify_withdraw` | `gmailIds`, `account` | `()` | `withdrawNotifications` (Android cancels; elsewhere a no-op) |
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

Each message carries `picture`: the sender's picture resolved by the avatar's own rules
(`resolveSenderPicture` in `ui/senderPictures.ts`, sharing `pictureWants`/`orderPictures`
with `useSenderPictures`, over the sources `App` publishes): contact photo, then Gravatar
only if "Gravatar photos" is on, then the brand logo only if "Show brand logos" is on,
nothing for a relayed sender, and always `null` (no lookup) while lock-screen previews are
hidden. The browser uses it as the notification's `icon`. Native notifications never get
a URL: `nativePictures` (`ui/notificationActions.ts`) has the webview rasterise each one
(`canvasRasterise`) to a `NATIVE_PICTURE_PIXELS` (192 px, twice
`NOTIFICATION_PICTURE_SIZE`) square PNG data URL (a JPEG if the PNG would pass
`NATIVE_PICTURE_MAX_CHARS`, 200,000, the same cap as Rust's and Kotlin's
`MAX_PICTURE_CHARS`), drawn as the avatar shows it (`drawPicture`): covering the square,
centred, over the avatar's backdrop (`--wn-surfaceActive`), so a transparent logo is
opaque and round-friendly. It is drawn by destination rectangle (`pictureDrawRect`),
never a source crop: a BIMI logo is an SVG with a `viewBox` and no size, whose natural
size the engine makes up (Chromium 150×150, others 0×0) and draws at another, so the old
source crop sent Reddit's logo as a corner or as nothing; a draw that leaves every pixel
transparent is no picture. The load is `crossOrigin="anonymous"` (the canvas must stay
readable), so a logo host that sends no `Access-Control-Allow-Origin` still gets no
picture in a notification while the in-app avatar (a plain `<img>`) shows it; the CSP's
`connect-src` rules out fetching the bytes, and neither Rust (no TLS client) nor
`Http.kt` (Google hosts only) may. Rust carries the bytes (dropping them when previews
are hidden): Android draws them as the large icon, the desktop from a cache file.

| Host | Shown by | Reply | Delete / Mark read | Tap | Where the action runs |
| --- | --- | --- | --- | --- | --- |
| Android | `NotifyPlugin.kt` → `MailNotifier`: BigTextStyle per message, Gmail's layout (sender as title, subject as text, subject + preview expanded: `MessageText`, JVM-tested in `MessageTextTest`; picture as the large icon; account address as subtext), InboxStyle group summary, `ic_stat_winnow` | Inline (RemoteInput) | Buttons; Delete then offers Undo for 6 s | Opens `winnow://message/<id>` | **Native**, app backgrounded or not: receiver → channel → `android.rs` → `plan::execute` with the keychain tokens; `Http.kt` does the HTTPS |
| Linux | `notify-rust` over D-Bus | Button opens the composer on the message (no inline reply: KDE's is a vendor extension `notify-rust` does not expose) | Buttons | Opens the message | Webview (hidden, not paused): `ACTION_EVENT` → store `setRead` / `moveWithUndo`; confirmation replaces the notification for 3 s |
| Windows | `notify-rust` WinRT toast | Button opens the composer (`tauri-winrt-notification` has no toast inputs) | Buttons | Opens the message | Webview, as Linux; only failures get a follow-up toast |
| macOS | `tauri-plugin-notification`, one grouped notification | — | — | Reveals the window (`RunEvent::Reopen`) | Fallback: actions need `UNUserNotificationCenter` categories; `notify-rust`'s path is the deprecated `NSUserNotificationCenter` blocking a thread per notification, untestable here |
| Browser | `Notification`, one per message | — | — | Opens the message | — (buttons need a service worker) |

The Android buttons and their order (Delete, Mark read, Reply, left to right: Gmail's,
with Winnow's labels) are `NotifyActions.kt` (`NotifyActions.shown(flags, canReply)`,
plain Kotlin, JVM-tested in `NotifyActionsTest`); `MailNotifier` adds them in that order.

Every host puts the sender first: Android's title, the desktop's summary
(`notify_actions/desktop.rs`), with the subject (and preview) under it. Android dropped
MessagingStyle in 1.4.0 because One UI and stock Android draw its conversation title (the
subject) as the headline and the message as "Sender: text". The inline reply never relied
on it: a press replaces the notification with a status ("Sending…", then the result, or
the message again via `message()` for `restore`), so no "You: …" line is appended. A
notification rebuilt from a press's extras has no picture (the broadcasts leave it out to
spare the binder).

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

**Accounts (1.4.0).** A batch names its account (`NotificationAccount`, an id that fails
`plan::valid_account_id` is dropped), and the address is appended to the body when more
than one account is signed in. Notifications for accounts that are not open are on by
default (Settings → Google account, per account: `AccountRecord.notify`); they come from
the light sync. Native presses act with that account's tokens only
(`plan::tokens_secret_for`: `gmail.tokens@<id>`; no account means 1.3.5's entry, which the
migration empties, so an old notification fails as signed out rather than acting on
whichever account is there). On Android each account has its own group and summary
(`MailNotifier.groupFor` / `summaryIdFor`) and a message's notification id includes the
account. Deep links (`parseDeepLink` / `messageLink` in `core/notify/notifications.ts`,
`messageUri` / `inboxUri` in Kotlin):

- `winnow://message/<id>?account=<acct>&gmail=<gmailId>`: a tap switches to that
  account, fetches the message if it is not cached and opens it (on a phone in the
  full-screen reader; Back returns to that account's inbox).
- `winnow://open?account=<acct>&view=inbox`: a summary opens that account's inbox.
- 1.3.5's links (no account) still open in the open account. An action on an account
  that is not open runs there (natively, or by switching) and its light sync catches up;
  an account no longer on the device gets "That account isn't signed in on this device
  any more."

**Test notification (Dev Options → Send test notification, native builds only).**
`sendTestNotification` (`ui/notificationActions.ts`) posts the sample from
`core/notify/testNotification.ts` through `announce`, the real path, with all three buttons,
its picture or monogram, and a reply head addressed to `.invalid` (whatever the user's
notification settings say; it asks for permission first). Its Gmail id `TEST_GMAIL_ID`
(`winnowtestnotification`) is not hex, so it is never a real message, and every press is a
no-op against mail: Android's `plan::execute` returns `Outcome::Test` before reading a token
or making a request ("Test notification · Nothing was changed"); `routeNotificationAction`
answers desktop and Android presses alike with a status-pill flash (`testPressText`) and,
on the desktop, the same confirmation on the notification; `saveKeptReplies` lets a kept
reply to it go without saving it. `testNotification.test.ts` pins the id and reply head to
`plan.rs`; smoke: `smoke-android.mjs` 1d (and `smoke.mjs` checks the web build has no button).

Linux and Windows summaries emit an `inbox` action with the account. macOS still shows one
grouped notification whose tap only reveals the window: it carries no account or message,
so it cannot deep-link (unverified on a Mac).

What only a device can tell (untested here: no emulator, no macOS or Windows host):
RemoteInput on Android 12–15, the receiver with the process killed, the deep link from a
cold start (`get_current` may fire before the webview listens), `Channel` delivery after
the activity is recreated, the Undo window, D-Bus servers that draw no buttons, and WinRT
`on_activated` for an unpackaged build.

---

## 9. `proxy/` — the optional render proxy

Off unless built with `VITE_RENDER_PROXY` or named by a Docker deployment (§9a). It fetches a message's images and
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

## 9a. Docker (`Dockerfile`, `proxy/Dockerfile`, `docker/`)

Two images, `ghcr.io/hxmbl/winnow` (nginx-unprivileged, port 8080) and
`ghcr.io/hxmbl/winnow-proxy` (node:24-alpine, port 8787), both non-root, both able to
run with a read-only root and no capabilities (`docker-compose.yml`). Restarting a
container is its update:

```
docker/fetch-release.sh   On start: releases/latest (or WINNOW_VERSION) → if not the
                          baked or a cached version, download winnow-<kind>-<v>.tar.gz
                          and .sha256, check both the sum and GitHub's asset digest,
                          refuse links and `..` in the archive, unpack to
                          /var/lib/winnow/<kind>/<tag>. https only, redirects followed
                          by hand, hosts github.com / api.github.com / GitHub's asset
                          hosts only. Any failure: last download, else the baked copy
                          (whichever is newer). WINNOW_AUTO_UPDATE=false: baked only.
docker/bundle.sh          The one file list: web/dist, or proxy/*.ts + the sanitiser
                          and what it imports, plus VERSION. The Dockerfiles bake it;
                          release.yml's web-bundle job tars it as the release assets.
docker/web/configure.sh   Copies the chosen bundle to /tmp/winnow/www, writes
                          the winnow-config tag into index.html, adds a cross-origin
                          proxy to connect-src (meta and
                          header), and writes nginx's headers.conf and proxy.conf.
docker/web/nginx.conf     SPA fallback; /assets/ immutable, index.html no-cache,
                          a deep link's relative files map to the
                          top-level ones; /render and /asset/ forwarded to
                          WINNOW_PROXY_UPSTREAM with a same-host Origin dropped.
```

`.github/workflows/docker.yml` builds both on PRs that touch these files (a smoke run
of the containers, then amd64+arm64 without pushing) and pushes `vX.Y.Z`, `X.Y` and
`latest` when release.yml dispatches it after publishing (or a release is published by
hand). Release publishing requires the four `winnow-{web,proxy}-<v>.tar.gz{,.sha256}`
assets.

## 9b. Pre-releases and Beta updates

**Rule: any tag with a `-` (`v1.6.0-beta.1`) is a pre-release**, whatever GitHub's flag says.

- **Release workflow** (`release.yml`, through `web/scripts/release-flags.mjs` → `core/updates/releaseFlags.ts`): a `-` tag is created and published as a GitHub pre-release and never Latest; a draft ticked as a pre-release stays one. After publishing, a guard checks `releases/latest`: if it names the pre-release, Latest goes back to the newest stable release and the run fails.
- **Stable channel** (everyone; the default): reads `releases/latest` only and refuses a pre-release by GitHub's flag *or* a `-` in the tag, at every layer: `updates.ts` (`parseRelease`, `planUpdate`, `checkForUpdate`, which answers "current"), `changelog.ts` (What's new), `updater.rs` (`release_download` checks the URL's tag segment; the stable self-update refuses a manifest whose version or download tag is a pre-release), `UpdateLogic.kt` / `UpdatePlugin.kt` (`isReleaseApk`, `isPrereleaseDownload`), and `docker/fetch-release.sh` (`stable_tag`; only a `WINNOW_VERSION` pin may run a pre-release).
- **Beta channel** (Settings → Dev Options → **Beta updates**, `DevOptions.betaUpdates`; off by default, saved in `winnow.devOptions.v1`, turned off by Hide Dev Options; native builds only, `betaChannel`): `checkForUpdate` reads `/releases` (`RELEASES_LIST_URL`) and `newestRelease` takes the newest non-draft release by semver, pre-releases included. The offer carries `beta: true`, which `desktop.ts` passes to the shell (`update_download_deb` / `update_install_apk` `beta`) so the native checks accept that release's files; the APK and `.deb` are still checked against that release's own `SHA256SUMS`. macOS/AppImage self-update from that release's own `latest.json` (`UpdateAction.manifest` → `update_install { manifest }` → `updater::manifest_url`, never `releases/latest`); a release without one falls back to its page. What's new lists pre-releases too (`includePrereleases`).
- **Never a downgrade:** both channels offer only versions newer than the running one. Turning Beta off withdraws a pre-release offer on screen (`useUpdates`) and the user stays on the beta until a stable release newer than it.

Tests: `updates.test.ts` ("update channels"), `changelog.test.ts`, `releaseFlags.test.ts`, `devOptions.test.ts`, `platform/updates.test.ts`, `platform/docker.test.ts`, `updater.rs` tests, `UpdateLogicTest.kt`.

---

## 10. Where state lives

Since 1.4.0, every key below marked *per account* is stored as `<key>@<id>` (§5.6,
*Accounts*); the unscoped spelling is 1.3.5's, which the migration moves, and for the
learning, filter and mailbox keys it is also the device's own copy (the demo, nobody
signed in). "Sign-out" means signing out of that account, which erases its namespace.

| Key | Holds | Cleared by |
| --- | --- | --- |
| `winnow.accounts.v1` | The registry: active id, and each account's id, address, colour, notify flag, added time (max 5) | an account's sign-out removes its entry |
| `winnow.accounts.migration` | The id a 1.3.5 migration is moving into, while it runs | the migration's end |
| `winnow.lightSync.v1` *(per account)* | The unread inbox ids the last light sync saw | sign-out |
| `winnow.preferences.v1` | Appearance, sort, image policy, notification settings, blocked/muted senders: shared by every account | never, by design |
| `winnow.learning.v1` *(per account)* | Weights + the 400-event log | that account's sign-out (owner decision, 1.4.0: learning goes with the account) |
| `winnow.filterLearning.v1` *(per account)* | Smart-filter corrections (sender rules and clues are derived from them) | sign-out, a snapshot owned by another address, Settings → Smart filters reset |
| `winnow.activeFilters.v1` *(per account)* | The active filter set | sign-out |
| `winnow.mailbox.v1` *(per account)* | Which mailbox was last open | — |
| `winnow.offlineQueue.v1` *(per account)* | Actions (and sends) waiting for the network, with the account they belong to | replay, sign-out |
| `winnow.snooze.v1` *(shared; records carry their account)* | Snoozed conversations (account, message ids, wake time) and woken places, `core/mail/snooze.ts` via `core/store/keyedStorage.ts` | wake / unsnooze; an account's on its sign-out or removal |
| `winnow.scheduledSend.v1` *(shared; records carry their account)* | Messages to send later (account, time, Gmail draft id, device copy of the draft), `core/mail/scheduledSend.ts` via `keyedStorage` | sent / cancelled / Edit; an account's on its sign-out or removal |
| `winnow.drafts.v1:<account>` | Unsent composer drafts, one per context (`new`, `reply:<id>`, `forward:<id>`), for restore after a reload | send, discard |
| `winnow.gmail.cache.messages` *(per account)* | The mailbox, as plain JSON — only on a host without IndexedDB since 1.5.6; otherwise read once, moved into `winnow-offline@<id>` and removed | sign-out |
| IndexedDB `winnow-offline@<id>` *(per account)* | The mailbox mirror (`mailbox`), downloaded bodies (`bodies`, `index`) and attachments ≤ 10 MB (`files`), `core/offline/offlineStore.ts` | sign-out / account removal (database deleted); Remove downloads (bodies and files) |
| `winnow.offlineSave.v1` *(per account)* | The large-mailbox question's answer: `on` / `off` (absent until answered; a mailbox under 2,000 is saved without asking) | sign-out |
| `winnow.reconcile.v1` *(per account)* | When the last full id reconciliation (or full sync) finished, ms | sign-out |
| `winnow.gmail.cache.cursor` *(per account)* | Gmail `historyId` | sign-out |
| `winnow.google.contacts.v1` *(per account)* | The People API snapshot | sign-out, revocation |
| `winnow.brandLogos.v1` *(per account)* | Cached BIMI answers | sign-out, setting off |
| `winnow.gravatars.v1` *(per account)* | Cached Gravatar answers, by sender address | sign-out, setting off |
| IndexedDB `winnow-pictures@<id>` *(per account)* | Sender pictures as small data URLs (contact photos, Gravatars, brand logos), the 200 most recently drawn, `core/avatars/pictureBytes.ts` | sign-out / account removal (database deleted); a source's switch off, contacts grant gone (that kind) |
| `winnow.google.oauthClient` | The user's OAuth client (web only) | setup |
| `winnow.updates.v1` | Update checks: automatic on/off, the last check's time and outcome, the version whose notice was let go (`ui/useUpdates.ts`) | never, by design |
| `winnow.devOptions.v1` | Settings → Dev Options: `{ version: 1, unlocked, purePlainText, viewOriginal, filterScores, debugLog, betaUpdates, … }` (`ui/devOptions.ts`, `DEV_SWITCHES`); this device only, shared by every account, absent until unlocked | Hide Dev Options |
| `winnow.updates.loads.v1` | Loads since the last update check, native builds only (`ui/loadCheck.ts`) | any update check |
| `winnow.google.setupProgress` | A half-finished setup: step, ticks, client ID draft (never the secret) | saving or removing the client, Start over |
| `winnow.gmail.tokens@<id>` | An account's tokens (web only; 1.3.5's unscoped key is migrated) | that account's sign-out, which also revokes the grant at Google |
| `winnow.pendingAuth`, `winnow.pendingState` | PKCE verifier, sign-in state (`sessionStorage`) | read, or 15 min |
| keychain `gmail.tokens@<id>`, `google.oauth-client` | The same two, on desktop and Android (one token entry per account) | sign-out (revoked at Google first, from the web layer) / setup |
| `winnow.mutedFilters.v1` | Retired — deleted on launch | — |
| Android `SharedPreferences` `winnow.notify` / `pendingReplies` | Replies typed into a notification that are not yet sent or in Drafts | released by the web layer once saved to Drafts |

---

## 11. Tests, and the scripts that run them

| Suite | Command | What it is |
| --- | --- | --- |
| Unit | `npm test` | Vitest, **node** environment (IndexedDB from the `fake-indexeddb` dev dependency, imported explicitly by `core/offline/offlineStore.test.ts`, never installed globally), `src/**/*.test.ts` plus `../proxy/**/*.test.ts`. There are no component tests, and the glob says `.ts` not `.tsx` so nobody infers there should be. |
| Gate | `npm run check` | typecheck + lint + lint:proxy + unit |
| Smart filters | `node scripts/smoke-filters.mjs` | Targeted smoke for "Change smart filters…", "Why it's here", Settings → Smart filters, and the faceted chip counts (with filters on, and under a search on desktop and phone: the chips stay put, their numbers change, and each tapped chip lists exactly its number; `WINNOW_SHOTS` adds `phone-search-counts.png`). Own `vite preview` on 4350 (`WINNOW_PORT`); `WINNOW_SHOTS=dir` writes screenshots. |
| Accounts | `node scripts/smoke-accounts.mjs` | Targeted smoke for multi-account against a fake Google that knows two accounts by bearer token: a 1.3.5 session migrating with no sign-in (data moved into its namespace), Add account through Google's chooser (and a duplicate switched to), one-tap switching, a reply going out from the account that received the message, and on the Android app (a stand-in for Tauri's IPC) a notification's deep link switching account, fetching an uncached message into the full-screen reader, Back to that inbox, a summary's inbox link and a cold start from a tap (`deep_link_launch`). Own `vite preview` on 4362 (`WINNOW_PORT`). |
| End-to-end | `npm run smoke` | Playwright + Chromium against the real production build: `smoke.mjs`, then the targeted `smoke-android.mjs`, `smoke-filters.mjs`, `smoke-notifications.mjs` and `smoke-accounts.mjs`. Owns its `vite preview` on port 4173 (`WINNOW_PORT`, or point `WINNOW_URL` at your own). A native `confirm`/`alert`/`prompt` is a tripwire failure. `WINNOW_SMOKE_ONLY=offline` runs only `scripts/smoke-offline.mjs` (undo send on a phone, the offline queue against a stateful fake Gmail); `WINNOW_SMOKE_ONLY=fixes` runs only `scripts/smoke-fixes.mjs` (phone Settings' opaque backdrop, the phone menu's last row, Undo on desktop/batch/reader actions and `z`/Ctrl+Z, the status pill after a remount on the Android app, the demo's Back to your inbox), whose signed-in pages use the shared fake Gmail in `scripts/fake-gmail.mjs` (which can also delete a message for good, `state.expunge(id)`, with or without a history record, and answers the reconciliation's id listing); `WINNOW_SMOKE_PARTS=offline-save` runs `scripts/smoke-offline-save.mjs` (the mailbox and every body in IndexedDB rather than `localStorage`, newest first, Settings' "Saved N of N", an unopened newsletter opening offline, a launch with Google unreachable, a message deleted on the server leaving the list and the offline store via history and via the daily reconciliation, Remove downloads, and on the Android app the download plus `notify_withdraw` for the deleted message); `WINNOW_SMOKE_ONLY=thumb` runs only `scripts/smoke-thumb.mjs` (the status pill clear of the demo strip, forced-colours chrome, the phone compose top bar and its Delete/Save Draft sheet, Trash and Sign out confirmations, the reader pill folding on the demo newsletter and its left-handed mirror, pill/circle shapes, the shortcuts table and one-line category names, and email dark mode: the demo newsletter's body dark in dark/OLED on phone and desktop with every text element ≥ 4.5:1 against what is behind it, its @media phone rule intact, no image filtered, the sun/moon toggle round trip, and the white card with the setting off or in light). |
| Smoke shards | `node scripts/smoke-shards.mjs <shard>` | How CI runs `npm run smoke`: as a matrix of parallel shards (`smoke-shard` in `ci.yml`, aggregated into the one `Smoke test` check). `smoke.mjs` is cut into parts gated by `part("…")` — `core` (the shared-page sequence, boot through deep links) and the self-contained sections and modules after it — selected with `WINNOW_SMOKE_PARTS=a,b` (unset runs all). `smoke-shards.mjs` maps parts and the standalone scripts to shards; `--check` (run by `npm-checks`) fails unless every part and every script in `npm run smoke` is in exactly one shard and the CI matrix lists exactly those shards. A new section after `core` gets its own `part("…")` gate and a shard entry. |
| Theme sweep | `npm run sweep` | Manual, never in `npm run smoke` or CI. `scripts/sweep.mjs` photographs every mode (light, dark, very dark (`oled`); `system` once each way) × every accent in `ACCENT_THEMES` (read from `core/model/appearance.ts`, so a new accent is swept for free), plus the custom accent once per mode with one fixed colour (`SWEEP_CUSTOM_HEX`, a honey light mode has to darken, so the adjusted note is in the shots), on a phone (390×844, Android UA, safe-area insets) and a desktop (1440×900): inbox, reader, drawer, Settings top and scrolled to the end, the Appearance picker, compose, the status pill with Undo, and inbox clear (the shared fake Gmail with an empty inbox). Then the settings and OS preferences that change the look (sort, remote images, brand logos, Gravatar, reduced transparency, forced colours, left-handed on a phone, a small phone, a tablet) once each, a Settings dropdown open (phone and desktop, light and dark), and the phone reader scrolled partway down the long demo newsletter with its pill folded (both hands × light/dark/OLED). Checks as it goes — page/console errors, text clipped without an ellipsis or pushed off-screen, sideways scroll, and WCAG AA for primary and pill/chip text measured against the pixels behind it (a second shot with text hidden, so glass counts) — and writes contact sheets per mode × device, `sweep.pdf` and `sweep-report.md`. Reports, never fails on a finding. `WINNOW_SWEEP_OUT` (default `web/.sweep`, git-ignored), `WINNOW_SWEEP_PHASE=capture\|sheets`, `WINNOW_SWEEP_MODES` / `WINNOW_SWEEP_DEVICES` for a subset, `WINNOW_SWEEP_JOBS` (3); port 4573 by default. |
| Secrets | `minesweep --config .minesweep.yml --fail-on high .` | CI job 1, and the pre-commit hook. |
| Dependency advisories | `node web/scripts/audit-advisories.mjs` | CI job `advisories`: `npm audit` (full and `--omit=dev`) and `cargo audit` on the committed lockfiles; fails only on a new high/critical shipped advisory. Accepted ones in `.github/advisory-allowlist.json`; policy in `SECURITY.md`. |

`web/scripts/`:

- `check-version.mjs` — six manifests must agree (`package.json`,
  `package-lock.json` twice, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`), all
  plain `MAJOR.MINOR.PATCH`, because a suffix lives only in the tag and WiX
  rejects anything else. `tauri.conf.json` is the authority.
- `audit-advisories.mjs` — the dependency advisory gate (CI's `advisories` job): runs
  `npm audit` and `cargo audit` against the lockfiles, never installs or updates, and
  fails only on an unaccepted high/critical advisory in what ships. The allowlist is
  `.github/advisory-allowlist.json`; the policy, `SECURITY.md`.
- `bump-version.mjs` — sets one version in all six manifests (`patch`, `minor`,
  `major` or exact), editing in place so formatting survives, then re-runs
  `check-version.mjs`. Also moves `CHANGELOG.md`'s `## [Unreleased]` under the new
  version, and refuses (before touching a manifest) a version that would have no
  notes. Used by the Cut release workflow.
- `release-notes.mjs` — a tag's `CHANGELOG.md` section (`notes`, `whats-new`), the
  notes in a release body (`from-body`), `promote` and `lint` (CI's npm-checks).
  Rules in `core/updates/releaseNotes.ts`: exact version, then a pre-release's plain
  version, never generic text. `release.yml` opens the release body with it ("What's
  new" above Downloads) and fills `latest.json`'s `notes` from it; a tag without a
  section fails Prepare. See `native/README.md`, "Release notes".
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
  flow; also the update button, the every-tenth-load check and Dev Options → Send test
  notification and Check now in the app. `npm run smoke` runs it after `smoke.mjs`; it runs alone too (port 4174).
- Smokes that seed a signed-in session write 1.3.5's unscoped `winnow.gmail.tokens`
  (and the Android stand-in's keychain `gmail.tokens`) on purpose: every signed-in run
  goes through the migration. Anything they *read back* about an account is under the
  namespaced key: look up `winnow.accounts.v1`'s `active` and read `<key>@<id>`.

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

The environment surface is a handful of variables, one build-time constant, and its run-time counterpart for Docker (the `winnow-config` meta tag). Every
numeric constant worth knowing is quoted in the section that owns it: quota and
retry in §5.5, sanitiser limits in §5.8, sync caps in §5.5, proxy limits in §9.

| Name | Where | Effect |
| --- | --- | --- |
| `VITE_RENDER_PROXY` | build time | Turns on the Proxied view and its client. http/https only, read once. |
| `__WINNOW_LOOPBACK_PORT__` | both hosts | Placeholder the web layer writes and Rust substitutes with a real ephemeral port. `oauth.rs` refuses a URL without it. |
| `PORT`, `HOST`, `ALLOWED_ORIGINS` | proxy runtime | Bind address and the exact-origin CORS allow list. |
| `WINNOW_AUTO_UPDATE`, `WINNOW_VERSION`, `WINNOW_REPO`, `WINNOW_DATA` | Docker containers | Fetch the newest release on start (default) or not, pin one, a fork's releases, where downloads are kept. |
| `WINNOW_PROXY_UPSTREAM`, `WINNOW_RENDER_PROXY` | web container | Forward `/render` and `/asset/` to a proxy container (the app then uses `self`), or name a proxy elsewhere; written into `index.html`'s `winnow-config` tag. |
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
| Token colours are CSS variables, so Tailwind's `/opacity` never applies to them | Under Tailwind 3 `rgb(var(--wn-veil) / 0.5)` was not a colour and rendered nothing; Tailwind 4 mixes it with `color-mix`, which bypasses the per-mode contrast tuning (and `veil`, `sheen`, `scrim` are already translucent). `theme.test.ts` asserts this over every token. |
| The type scale and radii are **reset** (`--text-*: initial`, `--radius-*: initial` in `@theme`), not extended | So `text-sm` does not exist and an arbitrary `text-[13px]` is caught by a test. |
| The app's own CSS in `index.css` sits in `@layer utilities`, after Tailwind's | Tailwind 4 layers its output, and unlayered CSS beats every layer regardless of specificity, so `:where(:focus-visible)` would override `focus-visible:-outline-offset-2` and the like. Same layer, later in order, is how Tailwind 3 behaved. |
| Focus rings are `outline`, never Tailwind's `ring` | `ring-2` composes `box-shadow` out of custom properties and silently resolves to `none`. |
| `base: "./"` in `vite.config.ts` | A Tauri window requesting `/assets/…` from the filesystem root renders blank. |
| One entry point, no route code splitting | A lazy chunk that has not been written yet fails at runtime with no error message. |
| No path aliases anywhere | The project has none; an import that needs one is a signal. |
| `theme.ts` and the `@theme` block in `index.css` list the same colour names, by hand | A name in one and not the other silently produces an unstyled element rather than a build error. |
| Rust serialises camelCase explicitly | Tauri rewrites argument keys but never return values. |
| New Rust code goes in a module, not in `commands.rs` | The command layer is meant to stay readable in one sitting. |

---

## 13a. Attachments (and no labels)

**No labels.** Labels were removed from the UI after 1.3.0-beta: the owner's call is that
they are for people who stay on Gmail. There are no chips, no Labels section in the
sidebar or the dock menu, no label views and no Label as…. Winnow never changes the
account's labels, with one exception since 1.4.0: snoozing puts Winnow's own
`Winnow/Snoozed` on (made on first use) so snoozed mail is visible and recoverable in any
client (§13b). The client's only label calls are `ensureLabel`, which refuses any other
name, and `modify`; there is no general `labels.list`/`labels.create` wrapper,
`threads.modify` or `batchModify` (`core/session/draftFiles.test.ts` pins both), and a
label change an older build left in the offline queue is dropped, not replayed.
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

Smoke: `scripts/smoke-attachments.mjs` (attachments, Drive links — sharing only at dispatch, a chipless Drive line shared from the body, someone else's link skipped, the missing-permission dialog — and labels staying gone), run by `smoke.mjs` and alone.

**Big files as Drive links (1.3.3).** Gmail caps a message's attachments at 25 MB and its
API has no Drive fallback, so `core/gmail/drive.ts` is one. Scope: `drive.file` only (the
files Winnow itself creates; nothing else in the Drive), requested by incremental consent
(`GmailSession.grantDrive`: `include_granted_scopes`, `login_hint`, the wrong-account
refusal and web redirect shared with the drafts/contacts opt-ins) the first time the user
presses **Send as a Drive link**, after `DriveConsent.tsx` has said in plain words what it
allows and doesn't (`DRIVE_CONSENT`); never at sign-in. `driveAccess()` is read off the
token, so sign-out's revoke takes it with everything else. Flow: `ComposerAttachments`
keeps the files `oversizedFiles` refused and offers the button → App uploads (resumable:
metadata POST, then the bytes to Google's `Location`) → `Draft.driveFiles` plus a
"File name (size) — link" line in the body (`insertDriveLinks`; the Drive chip's × takes
the line out, the Drive copy stays) → shared with To/Cc/Bcc as **reader**,
`sendNotificationEmail=false`, when the message is dispatched (below). Google's
API-disabled 403 becomes `DriveApiDisabled`
with a **Turn on the Drive API** link. The demo uses `DemoDriveClient` (no network; an
`.invalid` address fails to share) and shows the consent dialog once. Settings → Privacy →
**Big files as Drive links** (`driveLinks` preference, on) shows the grant and Stop; Google
revokes only whole grants, so **Remove at Google** links to the account page. CSP adds
`https://www.googleapis.com` (Drive v3 lives there; the Tauri CSP already had it). The
setup guide and `docs/google-setup.md` have the optional Drive API step.

*What is shared: the body.* The composer's `driveFiles` is not part of a Gmail draft, so
Send reads the links off the body that goes out (`driveLinksForSend`): `driveFiles` whose
line is still there, Winnow's own "File name (size) — link" lines, and any other Drive
file URL (`driveFileId`: `/file/d/<id>`, `open?id=`, `uc?id=`, Docs' `/d/<id>`,
`drive.usercontent…?id=`; not folders). `findDriveLinks` reads plain text and HTML (its
text and every `href`); `reopenDraft` rebuilds `driveFiles` from the saved message's own
lines (`recoverDriveFiles`, text and HTML) so the chips come back. `shareForSend` reads a
file's permissions first and shares only the addresses missing, so it knows exactly which
permission ids *this* send created. `drive.file` reaches only files Winnow made, so a
403/404 (or any refusal) on a link that is **not** one of Winnow's lines — someone else's
pasted link — is skipped silently; a refusal on Winnow's own line is the "can't open the
Drive link" warning (Send anyway / Keep editing). Whole-grant failures (API off, scope
gone, signed out) on Winnow's links are thrown, never per-address.

*Missing grant.* At Send-tap, with no network, `needsDriveGrant`: Winnow's own links and
no `drive.file` on the token (or the demo not yet allowed) opens `DriveGrantNeeded` before
anything is scheduled — **Allow Google Drive** (the same incremental consent as the first
upload; on the web the page leaves and the user presses Send again), **Send anyway**
(warned in so many words that recipients may not be able to open the link; nothing is
shared, `driveShare.state = "waived"`), or Keep editing. A token that loses the scope
between tap and dispatch holds the send at dispatch with the same dialog. Someone else's
link alone never asks.

*Sharing order (chosen).* Sharing happens at **actual dispatch**, never at Send-tap:
`App.deliver` calls `prepareDriveDispatch` (`core/gmail/driveSend.ts`) when the undo
window ends (or Send now, or at once with Undo send Off), before the Gmail send. So Undo,
a close in the window (kept as a draft) or a discard has shared nothing. A share
warning or a lost grant at dispatch *holds* the send (`DriveSendHold`): the message comes
back to the composer (one opened since is parked, as Undo does) with the dialog; Send
anyway there sends at once (the window already ran). Offline (or Drive unanswered) at
dispatch, the draft goes to the offline queue with `Draft.driveShare` `pending`, and the
queue has the app share it (`OfflineQueue.setDriveHooks` → `prepareQueuedShare`) just
before replaying the send and **before** marking it attempted, so a share with no answer
backs off like any request and never makes a raw send "unsafe to replay". Nobody is there
to ask at replay, so refusals become a notice and the message goes.

*Revocation (chosen).* Each send carries the permission ids it created
(`DraftDriveShare.created`, `ComposerState.driveShares`), persisted with a queued send.
Taken back (`revokeShares`, best effort, never an error): Keep editing on either Drive
dialog; the composer discarded or put away as a draft after an attempt; Undo (defensive:
only an earlier attempt's kept shares can exist then); a failed send parked because
another composer was open; a queued send Gmail **refused** with nobody waiting; a
sign-out with sends still waiting (`revokeQueuedShares`, up to 3 s, before the tokens
go). Kept: a send that fails and is retried (the composer keeps them, the retry adds only
what is missing and takes back those for a recipient or link no longer on the message);
a queued send retried after a transient failure; a queued send that may have gone out (a
lost answer, a 404 on its draft) — a link in a delivered message must open; a newer
queued send of the same draft inherits an older one's. Changing the Google account
(credentials removed) wipes the tokens first, so nothing can be taken back then. The
demo uses `DemoDriveClient` throughout (own files are `demo-drive-…`, anything else 404s)
and never calls Google; CSP and leak rules are unchanged.

---

## 13b. Snooze and send later (1.4.0)

Gmail's API exposes neither of Gmail's own features, so both are built from what it does
have, and **both keep their times on this device**: nothing on Google's side knows, so
**Winnow has to be running** at the time. If it is closed, a wake or a send happens on the
next open, and the status pill says it went late. The Send later menu, the custom-time
picker and Settings → Compose → **Send later and snooze** (`settingsCatalog.ts`) say so.

*Storage.* `core/store/keyedStorage.ts`: one key per feature (`winnow.snooze.v1`,
`winnow.scheduledSend.v1`), built in `storageKey`, the one place an account scope goes
for multi-account. Every record also names its account (`WinnowStore.accountKey()`: the
address, or `demo`), so the demo's never act on a real account (a demo message must never
reach Gmail) and one account's never list in another's. Sign-out drops the leaving
account's records (the mail stays archived under its label; a scheduled message stays a
Gmail draft); the demo's stay. **Two windows** share the keys (STRM-290): every save is a
three-way merge (`core/store/mergeRecords.ts`, `mergeSnoozes`, `mergeSchedules`) of what
the window last read, what it wants to write, and what storage holds now, so neither
window drops the other's new entries; a removal wins over a change, so a send another
window sent or cancelled never comes back. `WinnowStore.syncDeviceRecords` takes the
other window's changes in (`App`: on a `storage` event for either key, and in `runDue`),
and `claimScheduled` refuses a send storage no longer has.

*Snooze* (`core/mail/snooze.ts`, `WinnowStore.snooze`/`unsnooze`/`wakeDue`). Snoozing a
row takes its whole conversation's Inbox messages out (archived optimistically through
`mutate`) and calls `MailBackend.setSnoozed` (session: `Winnow/Snoozed` on, `INBOX` off,
one `messages.modify`; the label id looked up or made once per session). If that fails
(offline, refused) it falls back to a plain archive, which the offline queue carries; if
even that is refused the record goes and the rollback runs. One Undo in the status pill
("Snoozed until Tomorrow, 09:00."). From the Inbox, the Archive, or Snoozed (a new time).
`SnoozeOverlay` is laid over every `all` that enters the store (in `set`, the one door),
so a sync that still lists a snoozed message in the Inbox cannot bring it back, and a
woken message in the Inbox is dated by when it woke, so it sorts at the top and the row
shows that time (for up to `WOKE_TTL_MS`, while it stays in the Inbox). Snoozed mail is
listed in Snoozed only, not in Archive. Waking (`wakeDue`: on start, after every sync
including the 10 s poll, on focus/visibility, and on `App`'s 15 s timer, which is the
demo's only clock) re-adds `INBOX` and `UNREAD`, takes the label off, marks the rows
new, and flashes "A snoozed conversation is back in your Inbox." (with "It was due …,
while Winnow was closed." when late). A new message in a snoozed conversation wakes it
early; a snooze whose messages all went to Trash/Spam elsewhere is dropped. Moving a
snoozed message anywhere ends its snooze; in Snoozed, `e`/Archive is **Unsnooze** (to the
Inbox now, read state kept, Undo snoozes again). Entry points: row menu **Snooze ▸**
(`menus.ts` `snoozeEntries`), the reader bar's Snooze, the selection bar, `b`, and the
phone reader pill (`readerPill.ts`: Archive, Delete, Reply, Snooze, Forward, More).

*Send later* (`core/mail/scheduledSend.ts`, `App.scheduleDraft`/`dispatchScheduled`).
The composer's Send later (presets or a custom time) runs Send's checks (subject, Drive
grant), saves the Gmail draft (`DraftAutosaver.settle`), records `{ sendAt, draftId,
draft, replyTo, … }`, parks the saver and drops the device copy (so no "Restore your
unsent draft?"). A scheduled draft is kept out of Drafts and listed in Scheduled.
A send scheduled with another signed-in account in From keeps it (`from`, the account
id; its Gmail draft is that account's) and goes out through that account.
At the time `App.runDue` (same moments as waking, once the session is ready) checks the
send again (`permitScheduled` / `scheduleVerdict`: only the open account's; one whose
account, or `from` account, is no longer here is dropped, never sent), claims the
send (`claimScheduled`, so a second window does not send it too) and hands it to
`deliver` with `draftId`: Drive links shared at dispatch, `drafts.send` (keeping the
reply's thread), the offline queue when offline. The undo window is not run again: the
time was the user's choice and Cancel schedule is its undo. The pill says "Sent “…” as
scheduled." or "… late: it was due …, while Winnow was closed." A failure keeps the
schedule with its reason (the row says Not sent) and stops retrying until Send now or
Edit; a 404 on the draft (sent or deleted elsewhere) ends it with a notice. Scheduled
rows open `ScheduledSheet`: **Edit** cancels the schedule and reopens the draft as a
sheet on the same Gmail draft; **Send now**; **Cancel schedule** (it stays a draft; in the
demo it is put into Drafts). A send with another account's From (`scheduleDraftOwner`,
STRM-289) reopens with that From, saving to that account's Gmail draft and device copies,
and Cancel leaves it in that account's Drafts ("It's in …'s Drafts."), never in the open
account's; if that account was signed out since, Edit opens it as a new draft here. The demo simulates the send (filed into Sent, on its thread).
Files beyond the drafts' device budget survive only in this session's memory; after a
restart such a send stops with "… too big to keep on this device. Open it with Edit…".

Tests: `core/mail/{when,snooze,scheduledSend}.test.ts`, `core/store/{keyedStorage,mergeRecords}.test.ts`,
`core/store/snoozeSchedule.test.ts`, the label calls in `core/session/draftFiles.test.ts`,
menus/reader/pill/keybind tests; smoke: `scripts/smoke-schedule.mjs`.

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