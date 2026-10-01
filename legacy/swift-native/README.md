# Legacy Swift implementation

The original native Winnow, kept as a **behaviour reference**. It is not built,
not shipped, and not a dependency of anything in `web/` or `native/`.

## What it is good for

Two things, and only two:

1. **Answering "why does it bucket this way?"** The classifier here is the
   origin of every heuristic in `web/src/core/classify/`. When a TypeScript
   comment says a keyword table is "deliberately narrow", the Swift is where
   that narrowness came from — and it is frequently a deliberate anti-feature
   worth preserving. A mail classifier that buckets on the word "invoice" is
   right often enough to be annoying.

2. **Checking whether a behaviour was intentional.** A few decisions look like
   bugs and are not:

   - The keyword tables are narrow on purpose. Broadening them during the port
     was the single most damaging "improvement" avoided.
   - Phrase matching is word-boundary anchored. Substring matching was a real
     divergence in the port and is fixed.
   - Security and one-time codes are separate buckets, because "your account was
     accessed" and "your code is 419203" are different urgencies even though
     both are transactional.
   - Sender prominence gets a recency bonus, so a correspondent you reply to
     often stays prominent after a gap.

## What was deliberately *not* ported

Not everything in here is worth carrying forward, and some of it is only
survivable because it was never exercised.

| Kept as reference | Not carried over |
| --- | --- |
| The heuristics and their thresholds | The SwiftUI view layer, entirely |
| The signal model and weights | The store's `@Published` cascade |
| The learning model | The `EmailCacheStore` file format |
| Keybinds | Mock data — `web/src/core/data/demo.ts` replaces it |
| PKCE, the loopback server, the sync engine | |
| Reply quoting | |

The store was the part that could not survive translation: an observable-object
cascade re-derived on every mutation, which is fine for a handful of messages
and quietly wrong for thousands. `web/src/core/store/store.ts` is one hand-rolled
store with a single `derive()` pass, so the list, the counts and the reader
cannot disagree about what is on screen.

The view layer went because a browser has to run it anyway. Writing the UI once
in React meant the desktop app and the web app are the same program, and the
only thing Tauri adds is the seven things in the platform table in the root
README.

## The one real defect found during the port

The Swift `low_priority` bucket compared `importanceScore < 50` against a base
score of exactly 50, so the bucket could only ever be reached by a *penalised*
sender. It reads as intentional ("only the very bottom counts as skippable") and
may well have been the intent — but as written it was unreachable in the common
case, which is indistinguishable from a bug to anyone using the app.

The port made it `<= 50` and named the constant `SKIPPABLE_SCORE` in
`web/src/core/classify/filters.ts`, so the next person to read it can see that
the boundary was chosen rather than stumbled on.

## Do not resurrect this

If something here looks better than what `web/` does, port the *decision*, not
the file. The reason this code stopped being the product is not that it was bad
— the classification is genuinely good — it is that two implementations of the
same judgement would drift, and then the app would disagree with itself.