# Winnow

Your inbox, intelligently sorted. Winnow is a native macOS email client built with SwiftUI that classifies every message the moment it arrives — surfacing what matters, bucketing bulk mail, and flagging anything unsafe.

> **Status:** Winnow runs on mock data out of the box (the login screen simulates OAuth). Add Gmail credentials (below) and it becomes a live client: real OAuth sign-in, incremental sync, starring, and replying — all through the official Gmail API with one scope.

## Features

- **Smart filters** — one-tap buckets for Important, Urgent, Action needed, Security, Receipts, Starred, Top contacts, Quiet contacts, Newsletters, Promos, Read later, and Unsafe.
- **Smart Score sorting** — a 0–100 relevance score per email from intent signals (security language, deadlines, receipts vs. sale/unsubscribe phrasing), sender standing, stars, and a spam drag so unsafe mail never floats to the top.
- **Spam detection without ML** — keyword lists, regex heuristics, sender-shape checks, and per-sender trash history combine into a junk likelihood; messages at or above `0.4` are hidden by default.
- **Learning loop** — starring or unstarring nudges tunable signal weights up or down (small, clamped steps), and every action is logged as a `FeedbackEvent` for future training.
- **Fast, incremental classification** — keyword/regex matchers are compiled once at startup; data changes reclassify only the affected messages, and Settings slider drags are debounced into a single re-sweep, so the UI never stalls.
- **Tunable weights** — Settings exposes all ten classification signals as sliders with live "learned drift" indicators; reset to factory defaults anytime.
- **Search & sort** — multi-word AND search across sender/subject/body; sort by date, sender, or smart score. Esc closes the reader, ⌘F focuses search, ⌘R refreshes.
- **Keyboard-first** — home-row triage: `j/k` move, `o`/`Enter` opens, `s` stars, `e` archives (auto-advancing to the next message), `#`/`⌫` trashes, `r` replies, `/` searches, `1–9` toggle filter pills, `?` shows the cheat sheet. Single keys never hijack typing — while any text field has focus they pass straight through (Esc blurs). Plus ⌘F/⌘R.
- **Native Mac app** — sidebar navigation, filter pill rail, light/dark/system appearance, and a proper Cmd-, Settings window.

## Connecting a real Gmail account

1. In [Google Cloud Console](https://console.cloud.google.com/): create a project, enable the **Gmail API**.
2. *APIs & Services → OAuth consent screen*: External, add yourself as a test user.
3. *Credentials → Create credentials → OAuth client ID* → type **Desktop app**.
4. Copy `winnow/GmailCredentials.example.plist` to `winnow/GmailCredentials.plist` (git-ignored) and paste the client ID. The client secret is optional for installed apps — Winnow uses PKCE.
5. Build and run; sign in with Google. Sign-out wipes tokens and the local cache.

## How the Gmail layer is secured

- **One scope**: `gmail.modify` — read, star, archive, trash, send. Nothing broader is requested.
- **PKCE (S256)** on every authorization; the verifier never leaves the device except in the direct token exchange with Google over TLS. `state` is a per-flow random nonce; callbacks with a mismatched state are rejected.
- **Tokens live only in the login Keychain** (`ThisDeviceOnly`, so they never sync via iCloud). UserDefaults never sees a credential. A rejected refresh token clears the Keychain immediately.
- **Minimal transport**: ephemeral `URLSession` with no cookie jar and no URL cache. Logging in the Gmail layer is status codes only — never headers, bodies, or tokens.
- **Local cache** of fetched mail lives in the app sandbox and is wiped on sign-out.
- No third-party dependencies: the OAuth flow is hand-rolled on `ASWebAuthenticationSession` + `URLSession`, so the whole security surface is in this repo and covered by fixture tests.

## How classification works

There is no machine learning model — classification is a pure rule engine (`Classification/`):

1. **Profile** — `buildUserProfile` derives per-sender stats from inbox + trash: trash bias, top senders (volume + stars, penalized by discards), and quiet senders.
2. **Signals** — `classifyEmail` runs keyword and regex passes over each message to produce booleans (security, newsletter, promotional, urgency, needs-action, finance), a spam likelihood, and a weighted importance score starting from a base of 50.
3. **Filter & rank** — active filters AND together; buckets that mean "worth your attention" never overlap the Unsafe threshold. The pill rail reorders itself by current match count (`rankFilters`, cached in the store alongside the signals).

The only adaptive part is `SignalWeights`, tuned by hand in Settings or nudged automatically by the star-feedback loop in `Learning/LearningModel.swift`.

## Project structure

```
winnow/
├── App/                        # Entry point; owns the shared store
│   └── WinnowApp.swift
├── Models/                     # Domain types, one per file
│   ├── WinnowEmail.swift       #   Email thread + trashed row
│   ├── SmartFilter.swift       #   Built-in buckets + filter identity
│   ├── SortBy.swift            #   Toolbar sort options
│   ├── UserProfile.swift       #   Per-sender engagement stats
│   ├── EmailSignals.swift      #   Cached classification + badge buckets
│   └── EmailRowModel.swift     #   Ready-to-render list row
├── Classification/             # The rule engine (pure functions)
│   ├── Heuristics.swift        #   Keyword tables, regexes, text helpers
│   ├── ProfileBuilder.swift    #   buildUserProfile (inbox + trash → profile)
│   ├── Classifier.swift        #   classifyEmail (signals + importance)
│   ├── Scoring.swift           #   Smart Score ranking
│   ├── FilterMatching.swift    #   Bucket predicates
│   ├── FilterCatalog.swift     #   Canonical filter set + rail ordering
│   └── InboxPipeline.swift     #   signalsForInbox + filterAndSortInbox
├── Learning/                     # Tunable weights and the star-feedback loop
│   ├── SignalWeights.swift       #   SignalKey + weight snapshot
│   ├── FeedbackEvent.swift       #   Logged training example
│   └── LearningModel.swift       #   Online updates + persistence
├── Gmail/                        # Live backend (absent credentials ⇒ demo mode)
│   ├── GmailCredentials.swift    #   Plist credentials; scope + redirect derivation
│   ├── Auth/                     #   PKCE, Keychain token store, refresh, sign-in
│   ├── API/                      #   DTOs + the only component that talks to Google
│   ├── MIME/                     #   RFC 5322/2045 message assembly for send
│   ├── Mapping/                  #   Gmail payload → WinnowEmail
│   ├── Sync/                     #   Full + history-based incremental sync
│   └── Persistence/              #   SwiftData cache (wiped on sign-out)
├── Store/
│   └── WinnowStore.swift       # Single @Observable source of truth; caches derived data
├── Views/                      # SwiftUI screens
│   ├── ContentView.swift       # Main canvas: header, list, floating reader
│   ├── LoginScreen.swift       # Simulated Google sign-in
│   ├── EmailRow.swift          # Inbox list row
│   ├── EmailViewer.swift       # Floating message card + reply composer
│   ├── MailboxMenu.swift       # Fixed mailbox pill + pull-up card menu
│   ├── FilterRail.swift        # Bottom pill rail
│   ├── SettingsView.swift      # Preferences: appearance, weights, feedback log
│   └── Components/             # Reusable pieces (pills, badges, avatars, wheel overlay)
├── Support/                    # Theme colors/palettes, avatar hues, date formatting
├── MockData/                   # Demo inbox and trash
└── Previews/                   # Xcode preview support
```

## Requirements

- macOS 26.5+
- Xcode with the Swift 6 toolchain (project builds with Swift 5 language mode)

## Building

Open `winnow.xcodeproj` in Xcode and press **⌘R**, or from the command line:

```sh
xcodebuild -project winnow.xcodeproj -scheme winnow -configuration Debug build
```

## Testing

Unit tests cover the classifier, profile builder, filtering/sorting pipeline, and the learning model (with an isolated `UserDefaults` domain). Run them with **⌘U** in Xcode or:

```sh
xcodebuild -project winnow.xcodeproj -scheme winnow test
```

## Privacy note

Winnow reads your email locally to classify and sort it — nothing is sent to any server other than Google's own API endpoints, and only under the single `gmail.modify` scope you consented to. Without credentials configured, all data is mock data living in memory.
