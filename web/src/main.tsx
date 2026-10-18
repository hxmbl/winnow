/**
 * The entry point.
 *
 * Reads the platform, asks the OS what it can do, restores what the last session
 * persisted, and renders. The product is in `core/`, the pixels are in `ui/`, and this
 * file's only job is to connect them to whichever host loaded it.
 *
 * The app renders *immediately*, in demo mode, before any network call: a mail client
 * that shows a spinner on launch cannot be opened offline, and the classification is
 * something the user should see the moment they open the app. A Gmail session, if one
 * exists, is adopted in the background and replaces the demo.
 *
 * The demo is not a dead end: it offers "Connect Gmail", the only route to sign-in on a
 * fresh install, since the app boots `ready` with no backend and never shows the sign-in
 * screen first.
 */

import { startForegroundSync } from "./platform/foregroundSync";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WinnowStore } from "./core/store/store";
import { DEMO_CONTACTS, DEMO_LABELS, DEMO_TRASH, demoMailbox } from "./core/data/demo";
import { desktopPlatformExtras, isTauri, platform } from "./platform";
import { filterKey, parseFilterKey } from "./core/model/signals";
import { MAILBOX_ORDER } from "./core/store/store";
import { revivePreferences } from "./core/store/preferences";
import { dropRetiredKeys } from "./core/store/retiredKeys";
import type { Preferences, StoreOptions } from "./core/store/store";
import { applyTheme, resolveScheme } from "./ui/theme";
import { DEFAULT_ACCENT_THEME, DEFAULT_APPEARANCE } from "./core/model/appearance";
import type { LearningSnapshot } from "./core/learn/learning";
import type { Mailbox } from "./core/model/email";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("no #root element to mount into");

/**
 * Persistence keys.
 *
 * One object so the write path and the read path cannot drift. Versioned per key,
 * because these are independent blobs and only some of them gain fields.
 */
const STORAGE_KEYS = {
  preferences: "winnow.preferences.v1",
  learning: "winnow.learning.v1",
  filters: "winnow.activeFilters.v1",
  mailbox: "winnow.mailbox.v1",
} as const;

/**
 * Read one key, or `null` for anything unusable.
 *
 * Each read is individually guarded rather than wrapping the whole restore in one
 * `try`: a corrupt *learning* snapshot is no reason to also lose the user's appearance,
 * sort order, and blocked-sender list. Storage being unavailable — private mode, a full
 * quota — lands here too.
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
    // memory; only the *next* launch loses the settings.
  }
}

/** The mailbox the user last looked at, if it is one of the four. */
function reviveMailbox(raw: unknown): Mailbox | null {
  return typeof raw === "string" && (MAILBOX_ORDER as readonly string[]).includes(raw)
    ? (raw as Mailbox)
    : null;
}

/**
 * What the last session persisted, or `null` for a first run.
 *
 * Four independent reads, each guarded on its own — see `read`. Passed to
 * `store.restoreState` whole rather than applied key by key, so the store derives once
 * against a fully-restored world.
 */
function loadPersisted(): PersistedState {
  return {
    preferences: read(STORAGE_KEYS.preferences, revivePreferences) ?? undefined,
    // Round-tripped through the store's own `filterKey` rather than a second spelling
    // written here: the mapping between the persisted string and the in-memory `FilterId`
    // lives in exactly one place in `core`.
    activeFilters: read(STORAGE_KEYS.filters, (raw) =>
      Array.isArray(raw)
        ? raw
            .map((key) => (typeof key === "string" ? parseFilterKey(key) : null))
            .filter((filter): filter is NonNullable<typeof filter> => filter !== null)
            .map(filterKey)
        : null,
    ) ?? [],
    mailbox: read(STORAGE_KEYS.mailbox, reviveMailbox),
    learning: read(STORAGE_KEYS.learning, (raw) => raw as LearningSnapshot),
  };
}

/** What the last session persisted, as `store.restoreState` wants it. */
type PersistedState = {
  preferences?: Partial<Preferences>;
  activeFilters: string[];
  mailbox: Mailbox | null;
  learning: LearningSnapshot | null;
};

/**
 * The store, seeded with the demo mailbox and restored from the last session.
 *
 * `attach` breaks the construction cycle: the session bridge needs the store and the
 * store needs the session's backend, so neither is built here — the bridge is created
 * inside `App` on mount.
 */
// Before anything is read: buckets hidden by an earlier build come back, and the list
// that hid them is deleted rather than left behind (see `retiredKeys.ts`).
dropRetiredKeys(() => globalThis.localStorage);
const persisted = loadPersisted();

/*
 * The theme, before the first render.
 *
 * `public/theme-boot.js` has already set the mode on `<html>` so the backdrop is right
 * while this bundle loads; this writes the full palette, accent included, before React
 * paints anything. `App` takes over from here and follows changes.
 */
applyTheme(
  document.documentElement,
  resolveScheme(
    persisted.preferences?.appearance ?? DEFAULT_APPEARANCE,
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  ),
  persisted.preferences?.accent ?? DEFAULT_ACCENT_THEME,
);

const demo = demoMailbox();

const store = new WinnowStore({
  seed: demo.emails,
  seedTrash: DEMO_TRASH,
  seedDrafts: demo.drafts,
  seedLabels: DEMO_LABELS,
  // The demo address book, so the composer shows Google contacts merged in with no network.
  seedContacts: DEMO_CONTACTS,
  // The seed's own reference instant, moved onto the real clock (`demoMailbox`), so the
  // list's day sections and the reader's dates agree. Live mail replaces it on connect.
  now: demo.now,
  // Preferences go through the constructor rather than `restoreState` because they are
  // part of the initial state: a store built with the demo seed and then told to use dark
  // mode must render dark on first paint, not flash light and correct a frame later.
  preferences: persisted.preferences,
});

// One render against a fully-restored world, before the first paint.
store.restoreState(persisted);

/**
 * Persist whatever the store says changed.
 *
 * Only the keys present in the patch are written, each whole. The subtlety is that
 * `preferences` arrives as a *partial* — `{ blockedSenders: [...] }` from a block
 * action — so writing it verbatim would replace the stored preferences with that one
 * field, silently reverting appearance and sort order on the next launch. So a partial
 * preferences patch is merged into what is stored.
 */
function persist(patch: Parameters<NonNullable<StoreOptions["onPersist"]>>[0]): void {
  if (patch.preferences) {
    const current = read(STORAGE_KEYS.preferences, revivePreferences) ?? {};
    write(STORAGE_KEYS.preferences, { ...current, ...patch.preferences });
  }
  if (patch.learning) write(STORAGE_KEYS.learning, patch.learning);
  if (patch.activeFilters) write(STORAGE_KEYS.filters, patch.activeFilters);
  if (patch.mailbox) write(STORAGE_KEYS.mailbox, patch.mailbox);
}

/**
 * The platform bridge.
 *
 * `notifyNewMail`, `setUnreadBadge` and `setBackgroundSync` are what the store calls:
 * it holds product state and asks the OS to reflect it. `openExternal` and
 * `saveAttachment` are *not* here — both are one-shot reads a component performs
 * directly, and routing them through the store would mean reaching past it.
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
 * `info()` is best-effort: a rejection here must not leave the store with no platform
 * bridge *and* no persistence (both are wired in the block below). `App` treats an
 * in-flight answer and a missing one the same — a build that cannot report its
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

    // The background ticker. Registered here rather than in `App` because it is not UI:
    // a tick means "check the account", and the store already knows how. Subscribing once
    // at startup also means a tick that fires on the sign-in screen is not silently
    // dropped.
    //
    // The unsubscribe is released on `pagehide`: the desktop listener holds a closure
    // over the store for the life of the process, so the caller should not leak it.
    //
    // While the window is visible and focused the foreground controller polls every
    // 10s and syncs on focus / tab-visible / back-online; a background tick in that
    // state would only double up, so it is dropped. `store.refresh` is a no-op in the
    // demo (no backend), so the demo makes no requests either way.
    // With automatic sync switched off ("Sync paused") only the button syncs.
    const automatic = (): boolean => store.getSnapshot().preferences.backgroundSync;
    const foreground = startForegroundSync(() => {
      if (automatic()) void store.refresh();
    });
    const unlistenTick = platform.onBackgroundTick(() => {
      if (foreground.active()) return;
      void store.refresh();
    });

    // The list's reference clock, so relative timestamps and day headings stay true
    // in a window that has been open since yesterday. Owned by the store because the
    // store owns `now`.
    const stopClock = store.startClock();

    globalThis.addEventListener?.("pagehide", () => {
      unlistenTick();
      foreground.stop();
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
    // Android's sign-in success page links here only to bring the app forward; the
    // sign-in itself finishes in `session.ts`, so there is nothing else to do.
    if (isSignedInLink(url)) return;
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
      // `open` is handled entirely in Rust (`tray::reveal`) and never emitted on macOS,
      // where the tray menu has no such item. The arm is kept so a platform that does
      // emit it behaves; `tray.rs` points here.
      case "open":
        void platform.focusWindow();
        break;
      case "sync":
        void store.refresh();
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
function isSignedInLink(url: string): boolean {
  return /^winnow:\/\/signed-in\/?$/.test(url.trim());
}

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
