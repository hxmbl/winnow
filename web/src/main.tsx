/**
 * The entry point.
 *
 * Almost nothing happens here, and that is deliberate. It reads the platform,
 * asks the OS what it can do, and renders. The product is in `core/`, the pixels
 * are in `ui/`, and this file's only job is to connect them to whichever host it
 * was loaded by.
 *
 * The one decision worth stating: the app renders *immediately*, in demo mode,
 * before any network call. A mail client that shows a spinner on launch is a
 * mail client that cannot be opened offline, and the classification — the whole
 * product — is something the user should be able to see the moment they open
 * the app. If a Gmail session exists it is adopted in the background and the
 * mailbox replaces the demo.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WinnowStore } from "./core/store/store";
import { DEMO_EMAILS, DEMO_NOW, DEMO_TRASH } from "./core/data/demo";
import { desktopPlatformExtras, isTauri, platform } from "./platform";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("no #root element to mount into");

/**
 * The store, seeded with the demo mailbox.
 *
 * `attach` breaks the construction cycle: the session bridge needs the store,
 * and the store needs the session's backend. Neither is built here — the bridge
 * is created inside `App` on mount, once the platform has been read.
 */
const store = new WinnowStore({
  seed: DEMO_EMAILS,
  seedTrash: DEMO_TRASH,
  // The seed is built around this instant, so the list's day sections are
  // computed against it. Live mail replaces it with the wall clock on connect.
  now: DEMO_NOW,
});

/**
 * What this build can do, read once at startup.
 *
 * Async because the desktop shell has to round-trip to Rust for the answer, and
 * the app is told `null` until it lands rather than being blocked on it — the
 * demo mailbox does not care whether there is a tray icon.
 */
void platform.info().then(() => {
  store.attach({
    platform: {
      notifyNewMail: async (emails) => {
        const first = emails[0];
        if (!first) return;
        // One message gets the sender as the title; several get a count, with
        // the senders as the body. A notification that reads "Ada Lovelace —
        // Re: the plan" is actionable; one that reads "Winnow" is not.
        const title =
          emails.length === 1
            ? first.name ?? first.sender
            : `${emails.length} new messages`;
        const body =
          emails.length === 1
            ? first.subject
            : emails
                .slice(0, 3)
                .map((email) => email.name ?? email.sender)
                .join(", ");
        await platform.notifyNewMail({
          title,
          body,
          messageIds: emails.map((email) => email.id),
        });
      },
      setUnreadBadge: (count) => platform.setUnreadBadge(count),
      setBackgroundSync: (interval) => platform.setBackgroundSync(interval),
      openExternal: (url) => platform.openExternal(url),
      /**
       * Attachment saving.
       *
       * The bytes are fetched from Gmail here rather than in the store, because
       * the store holds product state and this is a platform operation. The
       * download is a single `messages.get`-with-attachment round trip.
       */
      saveAttachment: async (filename, bytes, mimeType) =>
        platform.saveFile(filename, bytes, mimeType),
    },
    onPersist: (patch) => persist(patch),
  });

  // The background ticker. Registered here rather than in `App` because it is
  // not UI: a tick means "check the account", and the store already knows how.
  // Subscribing once at startup also means a tick that fires while the user is
  // on the sign-in screen is not silently dropped.
  platform.onBackgroundTick(() => {
    void store.refresh();
  });

  wireDesktopEvents();
});

/**
 * The desktop-only event subscriptions.
 *
 * Tray and deep-link handling needs a live store, so it lives here where the
 * store exists rather than in a component. Guarded by `isTauri()` so a browser
 * build never subscribes to events it will never receive.
 */
function wireDesktopEvents(): void {
  if (!isTauri()) return;

  // A `winnow://` link is either a message to open or just "wake up". Either
  // way the window has to come forward: a link that opened the app behind the
  // frontmost window reads as nothing happening at all.
  desktopPlatformExtras.onDeepLink((url) => {
    void platform.focusWindow();
    const messageId = messageIdFromDeepLink(url);
    if (messageId !== null) {
      void store.focusMessage(messageId);
    } else {
      void store.refresh();
    }
  });

  // The ids here must match `tray.rs`'s menu items exactly. They are strings
  // across an IPC boundary with no shared type, so this switch is the only place
  // the two halves can drift apart — an unrecognised id falls through to
  // nothing, which is why the default arm is a deliberate no-op rather than a
  // guess.
  desktopPlatformExtras.onTrayAction((action) => {
    switch (action) {
      case "open":
        void platform.focusWindow();
        break;
      case "sync":
        void store.refresh();
        break;
      case "mark_all_read":
        // The tray says "Mark all read", and it means the mailbox on screen, not
        // every mailbox: marking spam read too would be a surprise.
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
}

/**
 * Pull a message id out of a `winnow://message/<id>` link.
 *
 * Returns `null` for a link that is not a message link — a bare
 * `winnow://open`, say — because "show me the app" is a legitimate deep link
 * that carries no id.
 */
function messageIdFromDeepLink(url: string): number | null {
  const match = /^winnow:\/\/message\/(\d+)$/.exec(url.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Persistence.
 *
 * Four keys, all namespaced, all small. Nothing derived is written: the
 * classification, the search bags and the profile are recomputed from the
 * messages on load, because a cached copy would be a second source of truth
 * that could disagree with the classifier that is about to run.
 */
const STORAGE_KEYS = {
  preferences: "winnow.preferences.v1",
  learning: "winnow.learning.v1",
  filters: "winnow.activeFilters.v1",
  mailbox: "winnow.mailbox.v1",
} as const;

function persist(patch: Parameters<NonNullable<Parameters<typeof store.attach>[0]["onPersist"]>>[0]): void {
  try {
    if (patch.preferences) {
      globalThis.localStorage?.setItem(
        STORAGE_KEYS.preferences,
        JSON.stringify(patch.preferences),
      );
    }
    if (patch.learning) {
      // The event log is capped at 400 entries by the model, so this cannot grow
      // without bound. It is kept because it is the audit trail that makes a
      // surprising ranking explainable.
      globalThis.localStorage?.setItem(STORAGE_KEYS.learning, JSON.stringify(patch.learning));
    }
    if (patch.activeFilters) {
      globalThis.localStorage?.setItem(
        STORAGE_KEYS.filters,
        JSON.stringify(patch.activeFilters),
      );
    }
    if (patch.mailbox) {
      globalThis.localStorage?.setItem(STORAGE_KEYS.mailbox, patch.mailbox);
    }
  } catch {
    // A full quota or a private-mode browser throws here. The app keeps working
    // from memory; only the *next* launch loses the settings, which is a much
    // better failure than an exception during a star toggle.
  }
}

/** Restore what was persisted. Called once, before the first render. */
function restore(): void {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEYS.preferences);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{
        sortBy: "date" | "sender" | "score";
        loadRemoteContent: boolean;
        notificationsEnabled: boolean;
        appearance: "system" | "light" | "dark";
        backgroundSync: boolean;
        backgroundSyncInterval: number;
        blockedSenders: string[];
      }>;
      store.setPreferences(parsed);
    }
  } catch {
    // Corrupt preferences are not worth a crash: the defaults are fine and the
    // next save overwrites them.
  }
}

restore();

createRoot(container).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
