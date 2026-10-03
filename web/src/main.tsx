/**
 * The entry point.
 *
 * Almost nothing happens here, and that is deliberate. It reads the platform,
 * asks the OS what it can do, restores what the last session persisted, and
 * renders. The product is in `core/`, the pixels are in `ui/`, and this file's only
 * job is to connect them to whichever host it was loaded by.
 *
 * The one decision worth stating: the app renders *immediately*, in demo mode,
 * before any network call. A mail client that shows a spinner on launch is a mail
 * client that cannot be opened offline, and the classification — the whole product —
 * is something the user should be able to see the moment they open the app. If a
 * Gmail session exists it is adopted in the background and the mailbox replaces the
 * demo.
 *
 * And the demo is not a dead end: the top bar offers "Connect Gmail" from it, which
 * is the only route to sign-in on a fresh install. The app boots with
 * `status: "ready"` and no backend, so it never shows the sign-in screen first — and
 * without that button, sign-in was unreachable until you had already signed in.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WinnowStore } from "./core/store/store";
import { DEMO_EMAILS, DEMO_NOW, DEMO_TRASH } from "./core/data/demo";
import { desktopPlatformExtras, isTauri, platform } from "./platform";
import { BUILTIN_FILTERS, filterKey, parseFilterKey } from "./core/model/signals";
import { MAILBOX_ORDER } from "./core/store/store";
import type { Preferences, StoreOptions } from "./core/store/store";
import type { LearningSnapshot } from "./core/learn/learning";
import type { Mailbox } from "./core/model/email";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("no #root element to mount into");

/**
 * Persistence keys.
 *
 * One object so the write path and the read path cannot drift — which they had:
 * `persist` wrote four keys and `restore` read one, so the learning model, the
 * active filters and the last mailbox were all saved to `localStorage` on every
 * change and never read back. A user who tuned the weights over a fortnight came
 * back to a factory-fresh classifier every morning, with nothing to indicate it.
 *
 * Versioned per key, because these are four independent blobs and only some of them
 * gain fields.
 */
const STORAGE_KEYS = {
  preferences: "winnow.preferences.v1",
  learning: "winnow.learning.v1",
  filters: "winnow.activeFilters.v1",
  mailbox: "winnow.mailbox.v1",
  muted: "winnow.mutedFilters.v1",
} as const;

/**
 * Read one key, or `null` for anything unusable.
 *
 * Every read is individually guarded rather than the whole restore being wrapped in
 * one `try`: a corrupt *learning* snapshot is no reason to also lose the user's
 * appearance, their sort order, and their blocked-sender list. Storage being
 * unavailable — private mode, a full quota — lands here too, and returns `null` for
 * every key, which is the correct answer for all five.
 */
function read<T>(key: string, revive: (raw: unknown) => T | null): T | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    return revive(JSON.parse(raw));
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // A full quota or a private-mode browser throws here. The app keeps working from
    // memory; only the *next* launch loses the settings, which is a much better
    // failure than an exception during a star toggle.
  }
}

/** `string[]` of bucket names, filtered to buckets that still exist. */
function reviveBucketNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(BUILTIN_FILTERS);
  return raw.filter((name): name is string => typeof name === "string" && known.has(name));
}

/** The mailbox the user last looked at, if it is one of the four. */
function reviveMailbox(raw: unknown): Mailbox | null {
  return typeof raw === "string" && (MAILBOX_ORDER as readonly string[]).includes(raw)
    ? (raw as Mailbox)
    : null;
}

/** Preferences, keeping only the keys the current build knows about. */
function revivePreferences(raw: unknown): Partial<Preferences> | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const out: Partial<Preferences> = {};

  if (source.sortBy === "date" || source.sortBy === "sender" || source.sortBy === "score") {
    out.sortBy = source.sortBy;
  }
  if (source.appearance === "system" || source.appearance === "light" || source.appearance === "dark") {
    out.appearance = source.appearance;
  }
  if (typeof source.loadRemoteContent === "boolean") out.loadRemoteContent = source.loadRemoteContent;
  if (typeof source.notificationsEnabled === "boolean") {
    out.notificationsEnabled = source.notificationsEnabled;
  }
  if (typeof source.backgroundSync === "boolean") out.backgroundSync = source.backgroundSync;
  if (typeof source.backgroundSyncInterval === "number" && source.backgroundSyncInterval > 0) {
    out.backgroundSyncInterval = source.backgroundSyncInterval;
  }
  // Addresses are matched case-insensitively everywhere they are read, so the
  // comparison is on the lowercased form — but the *stored* form is kept, because it
  // is what the settings panel shows and it is the address the user recognised.
  if (Array.isArray(source.blockedSenders)) {
    out.blockedSenders = source.blockedSenders.filter(
      (sender): sender is string => typeof sender === "string" && sender.includes("@"),
    );
  }
  return out;
}

/**
 * What the last session persisted, or `null` for a first run.
 *
 * Five independent reads, each guarded on its own — see `read`. The result is passed
 * to `store.restoreState` rather than applied key by key, so the store derives once
 * against a fully-restored world instead of reclassifying the mailbox three times on
 * the way there.
 */
function loadPersisted(): PersistedState {
  return {
    preferences: read(STORAGE_KEYS.preferences, revivePreferences) ?? undefined,
    // Round-tripped through the store's own `filterKey`, rather than a second
    // spelling written here. The persisted form is a string; the in-memory form is a
    // `FilterId`; and the function that maps between them lives in exactly one place
    // in `core`, which is the only place it can be kept correct.
    activeFilters: read(STORAGE_KEYS.filters, (raw) =>
      Array.isArray(raw)
        ? raw
            .map((key) => (typeof key === "string" ? parseFilterKey(key) : null))
            .filter((filter): filter is NonNullable<typeof filter> => filter !== null)
            .map(filterKey)
        : null,
    ) ?? [],
    removedFilters: read(STORAGE_KEYS.muted, reviveBucketNames) ?? [],
    mailbox: read(STORAGE_KEYS.mailbox, reviveMailbox),
    learning: read(STORAGE_KEYS.learning, (raw) => raw as LearningSnapshot),
  };
}

/** What the last session persisted, as `store.restoreState` wants it. */
type PersistedState = {
  preferences?: Partial<Preferences>;
  activeFilters: string[];
  removedFilters: string[];
  mailbox: Mailbox | null;
  learning: LearningSnapshot | null;
};

/**
 * The store, seeded with the demo mailbox and restored from the last session.
 *
 * `attach` breaks the construction cycle: the session bridge needs the store, and
 * the store needs the session's backend. Neither is built here — the bridge is
 * created inside `App` on mount, once the platform has been read.
 */
const persisted = loadPersisted();

const store = new WinnowStore({
  seed: DEMO_EMAILS,
  seedTrash: DEMO_TRASH,
  // The seed is built around this instant, so the list's day sections are computed
  // against it. Live mail replaces it with the wall clock on connect.
  now: DEMO_NOW,
  // Preferences go through the constructor rather than `restoreState`, because they
  // are part of the initial state: a store constructed with the demo seed and then
  // told to use dark mode has to render dark on its first paint, not flash light and
  // correct itself a frame later.
  preferences: persisted.preferences,
});

// One render against a fully-restored world, before the first paint.
store.restoreState(persisted);

/**
 * Persist whatever the store says changed.
 *
 * Only the keys present in the patch are written, and each is written whole. The
 * subtlety is that `preferences` arrives as a *partial* — `{ blockedSenders: [...] }`
 * from a block action — so writing the patch verbatim would replace the stored
 * preferences object with that one field, silently reverting appearance, sort order
 * and everything else on the next launch. That is what happened: hiding one spammer
 * from the reader's button and reloading reset the entire settings panel.
 *
 * So a partial preferences patch is merged into what is stored.
 */
function persist(patch: Parameters<NonNullable<StoreOptions["onPersist"]>>[0]): void {
  if (patch.preferences) {
    const current = read(STORAGE_KEYS.preferences, revivePreferences) ?? {};
    write(STORAGE_KEYS.preferences, { ...current, ...patch.preferences });
  }
  if (patch.learning) write(STORAGE_KEYS.learning, patch.learning);
  if (patch.activeFilters) write(STORAGE_KEYS.filters, patch.activeFilters);
  if (patch.mailbox) write(STORAGE_KEYS.mailbox, patch.mailbox);
  if (patch.removedFilters) write(STORAGE_KEYS.muted, patch.removedFilters);
}

/**
 * The platform bridge.
 *
 * `notifyNewMail`, `setUnreadBadge` and `setBackgroundSync` are what the store calls
 * — it holds product state and asks the OS to reflect it. `openExternal` and
 * `saveAttachment` are *not* on this bridge: both are one-shot reads a component
 * performs directly, and routing them through the store would mean reaching past it
 * for a non-mutation. They were declared on `PlatformBridge` and never called.
 */
const platformBridge = {
  notifyNewMail: async (emails: readonly { id: number; sender: string; name?: string; subject: string }[]) => {
    const first = emails[0];
    if (!first) return;
    // One message gets the sender as the title; several get a count, with the
    // senders as the body. A notification that reads "Ada Lovelace — Re: the plan"
    // is actionable; one that reads "Winnow" is not.
    const title = emails.length === 1 ? first.name ?? first.sender : `${emails.length} new messages`;
    const body =
      emails.length === 1
        ? first.subject
        : emails
            .slice(0, 3)
            .map((email) => email.name ?? email.sender)
            .join(", ");
    await platform.notifyNewMail({ title, body, messageIds: emails.map((email) => email.id) });
  },
  setUnreadBadge: (count: number) => platform.setUnreadBadge(count),
  setBackgroundSync: (interval: number | null) => platform.setBackgroundSync(interval),
};

/**
 * Ask the OS what this build can do, then wire everything that depends on knowing.
 *
 * `info()` is best-effort. The wiring below used to live inside this callback with no
 * `.catch`, so a rejection left the store with *no* platform bridge at all: no
 * notifications, no badge, no background sync, no tray, no deep links — and, because
 * `onPersist` is wired in the same block, no persistence either. Every preference
 * silently stopped being saved, with nothing on screen to say so.
 *
 * `App` renders the same `null` while the answer is in flight as it does when the
 * answer never comes, which is the honest reading: a build that cannot report its
 * capabilities is a build with none of the extras.
 */
void platform
  .info()
  .catch((error: unknown) => {
    console.warn("winnow: could not read platform capabilities:", error);
    return null;
  })
  .then(() => {
    store.attach({ platform: platformBridge, onPersist: persist });

    // The background ticker. Registered here rather than in `App` because it is not
    // UI: a tick means "check the account", and the store already knows how.
    // Subscribing once at startup also means a tick that fires while the user is on
    // the sign-in screen is not silently dropped.
    //
    // The unsubscribe is kept and released on `pagehide`. The desktop listener holds
    // a closure over the store for the life of the process, and `desktop.ts`
    // documents that a leaked listener is what it avoids internally — so the caller
    // should not leak it too.
    const unlistenTick = platform.onBackgroundTick(() => {
      void store.refresh();
    });

    // The list's reference clock, so relative timestamps and day headings stay true
    // in a window that has been open since yesterday. Owned by the store because the
    // store owns `now`.
    const stopClock = store.startClock();

    globalThis.addEventListener?.("pagehide", () => {
      unlistenTick();
      stopClock();
    });

    wireDesktopEvents();
  });

/**
 * The desktop-only event subscriptions.
 *
 * Tray and deep-link handling needs a live store, so it lives here where the store
 * exists rather than in a component. Guarded by `isTauri()` so a browser build never
 * subscribes to events it will never receive.
 */
function wireDesktopEvents(): void {
  if (!isTauri()) return;

  // A `winnow://` link is either a message to open or just "wake up". Either way the
  // window has to come forward: a link that opened the app behind the frontmost
  // window reads as nothing happening at all.
  const unlistenLink = desktopPlatformExtras.onDeepLink((url) => {
    void platform.focusWindow();
    const messageId = messageIdFromDeepLink(url);
    if (messageId !== null) {
      void store.focusMessage(messageId);
    } else {
      void store.refresh();
    }
  });

  // The ids here must match `tray.rs`'s menu items exactly. They are strings across
  // an IPC boundary with no shared type, so this switch is the only place the two
  // halves can drift apart — an unrecognised id falls through to nothing, which is
  // why the default arm is a deliberate no-op rather than a guess.
  const unlistenTray = desktopPlatformExtras.onTrayAction((action) => {
    switch (action) {
      // `open` is handled entirely in Rust (`tray::reveal`), so it is never emitted
      // on macOS, where the tray menu has no such item. The arm is kept so a future
      // platform that does emit it behaves, and `tray.rs`'s comment points here.
      case "open":
        void platform.focusWindow();
        break;
      case "sync":
        void store.refresh();
        break;
      case "mark_all_read":
        // The tray says "Mark all read", and it means the mailbox on screen, not every
        // mailbox: marking spam read too would be a surprise.
        store.markAllRead();
        break;
      case "settings":
        store.setOverlay("settings");
        void platform.focusWindow();
        break;
      default:
        // "quit" is handled by Rust itself and never reaches the webview.
        break;
    }
  });

  globalThis.addEventListener?.("pagehide", () => {
    unlistenLink();
    unlistenTray();
  });
}

/**
 * Pull a message id out of a `winnow://message/<id>` link.
 *
 * Returns `null` for a link that is not a message link — a bare `winnow://open`,
 * say — because "show me the app" is a legitimate deep link that carries no id.
 */
function messageIdFromDeepLink(url: string): number | null {
  const match = /^winnow:\/\/message\/(\d+)$/.exec(url.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

createRoot(container).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
