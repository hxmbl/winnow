/**
 * Wiring new-mail notifications to the running app: what a sync announces, what a
 * press does, and the replies a phone kept while it could not send.
 *
 * Here rather than in `main.tsx` so the pieces are named and testable; `main.tsx`
 * calls `wireNotifications` once the store exists. The decisions themselves are in
 * `core/notify/notifications.ts`.
 */

import type { Email } from "../core/model/email";
import {
  buildNotificationBatch,
  handleNotificationAction,
  parseKeptReply,
  type KeptReply,
  type NotificationAccount,
  type NotificationActionDeps,
  type NotificationActionEvent,
} from "../core/notify/notifications";
import type { WinnowStore } from "../core/store/store";
import type { Platform } from "../platform/types";
import { MAX_MESSAGE_NOTIFICATIONS } from "../core/notify/notifications";
import { displayName } from "../core/model/email";
import { currentSenderPictures, resolveSenderPicture, type SenderPictures } from "./senderPictures";

/** A notification's picture size: Android's large icon and the desktop's, in px. */
export const NOTIFICATION_PICTURE_SIZE = 96;

/**
 * Each shown message's sender picture, by Gmail id, under the avatar's own rules and
 * the sources the app is drawing avatars from. Nothing at all while previews are hidden
 * (not even a lookup).
 */
export async function notificationPictures(
  emails: readonly Email[],
  hidePreview: boolean,
  sources: SenderPictures = currentSenderPictures(),
): Promise<Record<string, string>> {
  if (hidePreview) return {};
  const out: Record<string, string> = {};
  await Promise.all(
    emails.slice(0, MAX_MESSAGE_NOTIFICATIONS).map(async (email) => {
      const url = await resolveSenderPicture(sources, email.sender, displayName(email), NOTIFICATION_PICTURE_SIZE).catch(() => null);
      if (url) out[email.gmailId] = url;
    }),
  );
  return out;
}

// ── Pictures for the native notifications ─────────────────────────────────

/**
 * The longest picture (as a data URL) handed to a native notification. Rust and Kotlin
 * enforce the same cap (`MAX_PICTURE_CHARS` in `notify_actions/mod.rs`); a 96px PNG is
 * usually 5–20 KB.
 */
export const NATIVE_PICTURE_MAX_CHARS = 200_000;

/**
 * Whether `value` is a picture a native notification will draw: a base64 PNG or JPEG
 * data URL under the cap. The native side never fetches anything (Rust has no TLS client,
 * and a background fetch from Android would reach a sender's server with no say from the
 * app's rules), so a URL is never one.
 */
export function isNativePicture(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= NATIVE_PICTURE_MAX_CHARS &&
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

/** Draw a picture URL to a `size`-px square PNG data URL, or `null` when it cannot be. */
export type Rasterise = (url: string, size: number) => Promise<string | null>;

/**
 * The webview's rasteriser: the same anonymous, referrer-less image load the avatar
 * makes (so nothing new reaches anyone), centre-cropped into a square canvas. A picture
 * that fails to load, takes over `timeoutMs`, or taints the canvas (a server without
 * CORS) answers `null`, and the notification shows the app icon instead.
 */
export function canvasRasterise(timeoutMs = 3000): Rasterise {
  return (url, size) =>
    new Promise<string | null>((resolve) => {
      if (typeof Image === "undefined" || typeof document === "undefined") return resolve(null);
      const img = new Image();
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const done = (value: string | null) => {
        clearTimeout(timer);
        resolve(value);
      };
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.decoding = "async";
      img.onerror = () => done(null);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext("2d");
          const w = img.naturalWidth || size;
          const h = img.naturalHeight || size;
          if (!context) return done(null);
          const side = Math.min(w, h);
          context.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
          const data = canvas.toDataURL("image/png");
          done(isNativePicture(data) ? data : null);
        } catch {
          // A tainted canvas throws on `toDataURL`.
          done(null);
        }
      };
      img.src = url;
    });
}

/**
 * The resolved pictures, made drawable by a native notification: each URL rasterised to
 * a small PNG data URL in the webview, under the same rules that resolved it. A picture
 * that cannot be drawn is left out (the app icon shows), never passed on as a URL.
 */
export async function nativePictures(
  pictures: Readonly<Record<string, string>>,
  rasterise: Rasterise = canvasRasterise(),
  size = NOTIFICATION_PICTURE_SIZE,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    Object.entries(pictures).map(async ([id, url]) => {
      const drawn = isNativePicture(url) ? url : await rasterise(url, size).catch(() => null);
      if (isNativePicture(drawn)) out[id] = drawn;
    }),
  );
  return out;
}

// ── Reply requests ────────────────────────────────────────────────────────

/**
 * "Open the composer on a reply to the open message." The composer is `App`'s state,
 * so `App` registers the one function that can do that, and a notification's Reply on
 * the desktop asks for it here.
 */
let replyOpener: (() => void) | null = null;

export function onReplyRequest(open: () => void): () => void {
  replyOpener = open;
  return () => {
    if (replyOpener === open) replyOpener = null;
  };
}

function requestReply(): void {
  replyOpener?.();
}

// ── Accounts ──────────────────────────────────────────────────────────────

/**
 * How a press reaches the right account (1.4.0). `App` provides it once the session
 * bridge exists; a press that arrives before that (a cold start from a notification)
 * waits for it, then for the launch's own restore, so it never acts on the demo.
 */
export type AccountRouter = {
  /** Resolves once the launch has adopted (or failed to adopt) the stored session. */
  ready(): Promise<void>;
  /** Make `id` the open account; `false` when this device has no such account. */
  openAccount(id: string): Promise<boolean>;
  isOpen(id: string): boolean;
  /** Catch an inactive account up after a native action (its light sync). */
  refreshAccount(id: string): Promise<void>;
  /** The light sync of every account that is not open. */
  refreshInactive(): Promise<void>;
};

let router: AccountRouter | null = null;
let routerWaiters: ((value: AccountRouter) => void)[] = [];

export function provideAccountRouter(next: AccountRouter): () => void {
  router = next;
  for (const resolve of routerWaiters) resolve(next);
  routerWaiters = [];
  return () => {
    if (router === next) router = null;
  };
}

/** The router, waited for up to `ms` (a press before the app is up). */
export function accountRouter(ms = 20_000): Promise<AccountRouter | null> {
  if (router) return Promise.resolve(router);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    routerWaiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** For tests. */
export function resetAccountRouter(): void {
  router = null;
  routerWaiters = [];
}

// ── The store's bridge ────────────────────────────────────────────────────

/** Whose notification this is: the open account, labelled when there is more than one. */
export function openAccountTag(store: WinnowStore): NotificationAccount | null {
  const snap = store.getSnapshot();
  if (!snap.accountId) return null;
  const many = snap.accounts.filter((account) => !account.demo).length > 1;
  return { id: snap.accountId, label: many ? (snap.account?.email ?? null) : null };
}

/** `PlatformBridge.notifyNewMail`: the store's arrivals, as the platform's batch. */
export async function announce(
  store: WinnowStore,
  platform: Platform,
  emails: readonly Email[],
  account: NotificationAccount | null = openAccountTag(store),
  /** The account's own reply heads (another account's backend); the open one's by default. */
  replyHeads?: (emails: readonly Email[]) => Promise<Record<string, string>>,
): Promise<void> {
  if (emails.length === 0) return;
  const preferences = store.getSnapshot().preferences;
  // Only Android replies from the notification itself; elsewhere Reply opens the
  // composer, so the header blocks (a profile read each) would be built for nothing.
  const info = await platform.info().catch(() => null);
  const heads = info?.os === "android"
    ? (replyHeads ?? ((shown) => store.notificationReplyHeads(shown)))(emails.slice(0, 5)).catch(() => ({}))
    : Promise.resolve({});
  const [resolvedHeads, pictures] = await Promise.all([heads, notificationPictures(emails, preferences.notificationHidePreview)]);
  // Native notifications (Android, desktop) draw a picture from its bytes, never a URL.
  const shown = info?.kind === "desktop" ? await nativePictures(pictures) : pictures;
  await platform.notifyNewMail(buildNotificationBatch(emails, preferences, resolvedHeads, shown, account));
}

// ── Presses and kept replies ──────────────────────────────────────────────

/** The handler's dependencies over the store and the account router. */
export function notificationDeps(store: WinnowStore, platform: Platform, routes: AccountRouter | null): NotificationActionDeps {
  return {
    focusWindow: () => platform.focusWindow(),
    ...(routes
      ? {
          openAccount: (id: string) => routes.openAccount(id),
          isOpen: (id: string) => routes.isOpen(id),
          refreshAccount: (id: string) => routes.refreshAccount(id),
        }
      : {}),
    openMessage: (gmailId, id) => store.openMessage(gmailId, id),
    openInbox: () => store.openInbox(),
    openReply: requestReply,
    find: async (id, gmailId) => {
      const snap = store.getSnapshot();
      const cached = snap.all.find((email) => email.id === id || (gmailId !== "" && email.gmailId === gmailId));
      if (cached) return cached;
      return (await store.ensureMessage(gmailId)) ?? undefined;
    },
    setRead: (id, read) => store.setRead(id, read),
    trashWithUndo: (id) => store.moveWithUndo(id, "trash"),
    refresh: () => store.refresh(),
    confirm: (id, title, text, failed) => void platform.confirmNotificationAction?.(id, title, text, failed),
  };
}

/** One press (or a notification's deep link), once the app can act on it. */
export async function routeNotificationAction(store: WinnowStore, platform: Platform, event: NotificationActionEvent): Promise<string> {
  // A native action already done needs no account to be open.
  const native = event.origin === "android" && event.action !== "open" && event.action !== "inbox";
  const routes = await accountRouter(native ? 0 : undefined);
  if (routes && !native) await routes.ready();
  return handleNotificationAction(event, notificationDeps(store, platform, routes ?? router));
}

export function wireNotifications(store: WinnowStore, platform: Platform): () => void {
  const unlisten = platform.onNotificationAction((event) => {
    void routeNotificationAction(store, platform, event);
    // A failed native action was about a message the user may now want to see.
    if (event.origin === "android" && event.outcome === "failed") {
      store.setNotice("A notification action didn't go through. It's shown on the notification.");
    }
  });
  return unlisten;
}

/**
 * Save any replies the phone kept to Drafts, and release each from the phone only once
 * Gmail has it. One that cannot be saved yet (still offline) stays on the phone for the
 * next try: nothing typed is ever dropped on the way.
 */
export function saveKeptReplies(store: WinnowStore, platform: Platform): Promise<void> {
  // Ready, visible and online can all fire together. Two runs would both read the same
  // kept replies before either released them, and save each one to Drafts twice.
  if (!saving) {
    saving = saveKeptRepliesOnce(store, platform).finally(() => {
      saving = null;
    });
  }
  return saving;
}

let saving: Promise<void> | null = null;

async function saveKeptRepliesOnce(store: WinnowStore, platform: Platform): Promise<void> {
  if (!platform.keptReplies || !platform.releaseKeptReplies) return;
  if (store.getSnapshot().status !== "ready") return;
  const raw = await platform.keptReplies().catch(() => []);
  // Each kept reply goes to its own account's Drafts: those for an account that is not
  // open wait on the phone until it is (this runs again whenever an account is ready).
  const open = store.currentAccountId();
  const kept = raw
    .map(parseKeptReply)
    .filter((reply): reply is KeptReply => reply !== null && (!reply.account || reply.account === open));
  if (kept.length === 0) return;
  const { saved, failed } = await store.saveKeptReplies(kept);
  const failedIds = new Set(failed.map((reply) => reply.requestId));
  const released = kept.filter((reply) => !failedIds.has(reply.requestId)).map((reply) => reply.requestId);
  if (released.length > 0) await platform.releaseKeptReplies(released).catch(() => undefined);
  if (saved === 0) return;
  store.setNotice(
    saved === 1
      ? "A reply you wrote in a notification couldn't be sent, so it's saved in Drafts."
      : `${saved} replies you wrote in notifications couldn't be sent, so they're saved in Drafts.`,
  );
}
