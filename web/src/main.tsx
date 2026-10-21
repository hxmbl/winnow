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
import { DEMO_CONTACTS, DEMO_TRASH, demoMailbox } from "./core/data/demo";
import { desktopPlatformExtras, isTauri, platform } from "./platform";
import { loadPreferences, persistPreferences } from "./core/store/preferences";
import { dropRetiredKeys } from "./core/store/retiredKeys";
import type { AccountState, Preferences, StoreOptions } from "./core/store/store";
import { applyTheme, resolveScheme } from "./ui/theme";
import { DEFAULT_ACCENT_THEME, DEFAULT_APPEARANCE } from "./core/model/appearance";
import type { Email } from "./core/model/email";
import { accountRouter, announce, routeNotificationAction, saveKeptReplies, wireNotifications } from "./ui/notificationActions";
import { loadAccountState, persistAccountState } from "./core/store/accountState";
import { deviceStorage } from "./core/store/storage";
import { parseDeepLink } from "./core/notify/notifications";
import { watchPhysicalKeyboard } from "./ui/physicalKeyboard";
import { isExistingInstall } from "./ui/tour";
import "./index.css";

// From the first key press, not from when Settings opens: Keyboard shortcuts shows on a
// touch device once a real keyboard has been used this session (`physicalKeyboard.ts`).
watchPhysicalKeyboard();

const container = document.getElementById("root");
if (!container) throw new Error("no #root element to mount into");

/**
 * What the last session persisted, in the shape `store.restoreState` takes.
 *
 * The preferences are the person's and shared by every account; the rest is the
 * device's own copy of what the demo, or a session with nobody signed in, learned
 * (`core/store/accountState.ts`, id `null`). Reading through those two codecs rather
 * than re-spelling their keys here is what keeps a restore and a write from drifting.
 */
function loadPersisted(): PersistedState {
  const storage = deviceStorage();
  return {
    preferences: loadPreferences(storage) ?? undefined,
    ...loadAccountState(storage, null),
  };
}

/** What the last session persisted, as `store.restoreState` wants it. */
type PersistedState = AccountState & { preferences?: Partial<Preferences> };

/**
 * The store, seeded with the demo mailbox and restored from the last session.
 *
 * `attach` breaks the construction cycle: the session bridge needs the store and the
 * store needs the session's backend, so neither is built here — the bridge is created
 * inside `App` on mount.
 */
/*
 * Whether this device has run Winnow before, read before anything below writes a key:
 * the first-run tour opens only on a true first launch, never for someone upgrading
 * (`ui/tour.ts`).
 */
const existingInstall = (() => {
  try {
    const storage = globalThis.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) keys.push(storage.key(i) ?? "");
    return isExistingInstall(keys);
  } catch {
    // Storage that cannot be read cannot remember the tour either: no tour.
    return true;
  }
})();

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
  persisted.preferences?.accentCustom,
);

const demo = demoMailbox();

const store = new WinnowStore({
  seed: demo.emails,
  seedTrash: DEMO_TRASH,
  seedDrafts: demo.drafts,
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
  const storage = deviceStorage();
  if (patch.preferences) persistPreferences(storage, patch.preferences);
  // 1.4.0: the learning, the active filters and the mailbox are the open account's,
  // written under its namespace (`core/store/accountState.ts`); the demo's are the
  // device's own, under the unscoped keys.
  persistAccountState(storage, store.currentAccountId(), patch);
}

/**
 * The platform bridge.
 *
 * `notifyNewMail`, `setUnreadBadge` and `setBackgroundSync` are what the store calls:
 * it holds product state and asks the OS to reflect it. `openExternal` and
 * `saveAttachment` are *not* here — both are one-shot reads a component performs
 * directly, and routing them through the store would mean reaching past it.
 */
/** How often the accounts that are not open are checked while the window is in front. */
const INACTIVE_CHECK_MS = 60_000;

const platformBridge = {
  // One notification per message with its buttons, plus a summary; what qualifies and
  // what it says are in `core/notify/notifications.ts`.
  notifyNewMail: (emails: readonly Email[]) => announce(store, platform, emails),
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
    // The accounts that are not open: a light sync (unread counts, new-mail
    // notifications) on every background tick, and once a minute while the window is in
    // front. Never more often: each is a listing per account.
    const checkInactive = () => void accountRouter(0).then((routes) => routes?.refreshInactive());
    const unlistenTick = platform.onBackgroundTick(() => {
      checkInactive();
      if (foreground.active()) return;
      void store.refresh();
    });
    const inactiveTimer = setInterval(() => {
      if (automatic() && foreground.active()) checkInactive();
    }, INACTIVE_CHECK_MS);

    // The list's reference clock, so relative timestamps and day headings stay true
    // in a window that has been open since yesterday. Owned by the store because the
    // store owns `now`.
    const stopClock = store.startClock();

    // Presses on new-mail notifications, and replies a phone kept while it could not
    // send: saved to Drafts once signed in, and again whenever the app or the network
    // comes back.
    const unlistenNotifications = wireNotifications(store, platform);
    let wasReady = false;
    const unsubscribeKept = store.subscribe(() => {
      const ready = store.getSnapshot().status === "ready";
      if (ready && !wasReady) void saveKeptReplies(store, platform);
      wasReady = ready;
    });
    const onVisible = () => {
      if (globalThis.document?.visibilityState === "visible") void saveKeptReplies(store, platform);
    };
    globalThis.document?.addEventListener("visibilitychange", onVisible);
    // A reply kept because the phone was offline is most likely to save the moment the
    // network is back, which is when the offline queue replays too.
    const onOnline = () => void saveKeptReplies(store, platform);
    globalThis.addEventListener?.("online", onOnline);

    globalThis.addEventListener?.("pagehide", () => {
      unlistenNotifications();
      unsubscribeKept();
      globalThis.document?.removeEventListener("visibilitychange", onVisible);
      globalThis.removeEventListener?.("online", onOnline);
      unlistenTick();
      clearInterval(inactiveTimer);
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
  const unlistenLink = desktopPlatformExtras.onDeepLink(openDeepLink);
  // A cold start from a notification's tap: the link was emitted before this listened,
  // so it is asked for (`deep_link_launch`; an older shell without it answers nothing).
  void desktopPlatformExtras.launchLinks().then((urls) => urls.forEach(openDeepLink));

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
 * A `winnow://` link: a notification's tap opens that exact message in its account (the
 * reader, full screen on a phone, fetched first when it is not cached), a summary's tap
 * that account's inbox, and anything else just brings the window forward and syncs.
 * Either way the window comes forward first: a link that opened the app behind the
 * frontmost window reads as nothing happening at all.
 */
function openDeepLink(url: string): void {
  void platform.focusWindow();
  const link = parseDeepLink(url);
  // Android's sign-in success page links here only to bring the app forward; the
  // sign-in itself finishes in `session.ts`, so there is nothing else to do.
  if (!link || link.kind === "signed-in") return;
  if (link.kind === "open") {
    void store.refresh();
    return;
  }
  void routeNotificationAction(store, platform, {
    action: link.kind === "message" ? "open" : "inbox",
    messageId: link.kind === "message" ? link.messageId : 0,
    gmailId: link.kind === "message" ? link.gmailId : "",
    // Asked of the app, not reported as done: the tap only opens.
    origin: "desktop",
    ...(link.account ? { account: link.account } : {}),
  });
}

createRoot(container).render(
  <StrictMode>
    <App store={store} existingInstall={existingInstall} />
  </StrictMode>,
);
