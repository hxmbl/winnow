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
import { avatarInitial, avatarTone, type AvatarTone } from "./avatar";

/** A notification's picture size: Android's large icon and the desktop's, in CSS px. */
export const NOTIFICATION_PICTURE_SIZE = 96;

/**
 * The pixels a native notification's picture is drawn at: twice the picture size, as
 * Gravatar is asked for, so Android's 64dp large icon is sharp on a 3× screen rather
 * than a 96px picture scaled up.
 */
export const NATIVE_PICTURE_PIXELS = NOTIFICATION_PICTURE_SIZE * 2;

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
 * enforce the same cap (`MAX_PICTURE_CHARS` in `notify_actions/mod.rs`); a 192px PNG is
 * usually 10–60 KB.
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
 * Where a picture of natural size `width`×`height` is drawn in a `size`-px square: scaled
 * to cover it and centred, the avatar's `object-cover` (the overflow is clipped by the
 * canvas). Always in destination space, never a source crop: an SVG with a `viewBox` and
 * no `width`/`height` (most BIMI logos, SVG Tiny PS) reports a made-up natural size
 * (Chromium says 150×150, some engines 0×0) and is drawn at another, so cropping its
 * source by the reported size cut the logo to a corner or to nothing at all. Drawn by
 * destination rectangle, the vector is rendered at the size it is drawn. No natural size
 * at all is taken as square.
 */
export function pictureDrawRect(width: number, height: number, size: number): { x: number; y: number; width: number; height: number } {
  const w = width > 0 ? width : size;
  const h = height > 0 ? height : size;
  const scale = size / Math.min(w, h);
  const dw = w * scale;
  const dh = h * scale;
  return { x: (size - dw) / 2, y: (size - dh) / 2, width: dw, height: dh };
}

/** Whether RGBA pixels are all fully transparent: a picture that drew nothing. */
export function isBlankPixels(data: ArrayLike<number>): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

/** The parts of a 2D context `drawPicture` uses, so a test can stand in for a canvas. */
export type PictureContext = {
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: ArrayLike<number> };
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalCompositeOperation: GlobalCompositeOperation;
};

/**
 * Draw a loaded picture into a `size`-px square the way the avatar shows it: covering the
 * square, centred, over the avatar's own backdrop (`background`, the in-app
 * `bg-surface-active`) so a logo with a transparent background is not dark-on-nothing
 * in a dark notification shade, and the round large icon Android crops it to looks like
 * the avatar. `false` when it drew nothing at all (a picture Android would show as an
 * empty disc rather than the app icon).
 */
export function drawPicture(
  context: PictureContext,
  image: CanvasImageSource,
  natural: { width: number; height: number },
  size: number,
  background: string | null,
): boolean {
  const rect = pictureDrawRect(natural.width, natural.height, size);
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  if (isBlankPixels(context.getImageData(0, 0, size, size).data)) return false;
  if (background) {
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);
    context.globalCompositeOperation = "source-over";
  }
  return true;
}

/** The avatar's backdrop behind a loaded picture (`bg-surface-active`), or `null`. */
export function avatarBackdrop(): string | null {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return null;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--wn-surfaceActive").trim();
  return value || null;
}

/**
 * The webview's rasteriser: an anonymous, referrer-less image load (so nothing new
 * reaches anyone), drawn into a square canvas by `drawPicture`. The load has to be
 * `crossOrigin="anonymous"` (the avatar's `<img>` is not, for non-Gravatar hosts) or the
 * canvas is tainted and cannot be read; a host that sends no
 * `Access-Control-Allow-Origin` therefore fails to load here, and the CSP's
 * `connect-src` (Google and the DoH resolver only) rules out fetching the bytes instead.
 * A picture that fails to load, takes over `timeoutMs`, draws nothing or taints the
 * canvas answers `null`, and the notification shows the app icon instead.
 */
export function canvasRasterise(timeoutMs = 3000, background: () => string | null = avatarBackdrop): Rasterise {
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
          if (!context) return done(null);
          if (!drawPicture(context, img, { width: img.naturalWidth, height: img.naturalHeight }, size, background())) return done(null);
          // A PNG keeps a logo's edges; a busy photo that would pass the cap as a PNG
          // goes as a JPEG (opaque by then: it is over the backdrop).
          const png = canvas.toDataURL("image/png");
          const data = isNativePicture(png) ? png : canvas.toDataURL("image/jpeg", 0.9);
          done(isNativePicture(data) ? data : null);
        } catch {
          // A tainted canvas throws on `getImageData` / `toDataURL`.
          done(null);
        }
      };
      img.src = url;
    });
}

/** How long a notification waits for one picture to load and draw, ms. */
export const NOTIFICATION_RASTERISE_MS = 1500;

/** Pictures drawn this session, by size and URL (a hit is instant; a miss is remembered too). */
const RASTER_CACHE_MAX = 64;

/**
 * `inner`, remembering each answer (a picture or `null`) for the session, so a sender who
 * writes again is not loaded and drawn again, and one whose picture failed does not hold
 * the next notification up for another timeout.
 */
export function cachedRasterise(inner: Rasterise, cache = new Map<string, string | null>()): Rasterise {
  return async (url, size) => {
    const key = `${size}|${url}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const drawn = await inner(url, size).catch(() => null);
    if (cache.size >= RASTER_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, drawn);
    return drawn;
  };
}

let defaultRasteriser: Rasterise | null = null;
function notificationRasterise(): Rasterise {
  defaultRasteriser ??= cachedRasterise(canvasRasterise(NOTIFICATION_RASTERISE_MS));
  return defaultRasteriser;
}

// ── The monogram, for an Android notification with no picture ─────────────

/** A sender's monogram as the list's avatar draws it: one letter on one of two tones. */
export type Monogram = { initial: string; tone: AvatarTone };

/**
 * The monogram for each shown message, by Gmail id (the avatar's `avatarInitial` and
 * `avatarTone`). Nothing while previews are hidden, as for pictures. Local: no lookup.
 */
export function notificationMonograms(emails: readonly Email[], hidePreview: boolean): Record<string, Monogram> {
  if (hidePreview) return {};
  const out: Record<string, Monogram> = {};
  for (const email of emails.slice(0, MAX_MESSAGE_NOTIFICATIONS)) {
    out[email.gmailId] = { initial: avatarInitial(displayName(email), email.sender), tone: avatarTone(email.sender) };
  }
  return out;
}

/** The CSS variables a tone paints with: the avatar's `TONE_CLASS`, background then ink. */
export const MONOGRAM_COLOURS: Record<AvatarTone, { background: string; ink: string }> = {
  neutral: { background: "--wn-surfaceActive", ink: "--wn-inkMuted" },
  soft: { background: "--wn-surfaceSelected", ink: "--wn-inkBody" },
};

/** Draw a monogram to a PNG data URL, or `null` when it cannot be. */
export type DrawMonogram = (monogram: Monogram, size: number) => string | null;

/**
 * The webview's monogram: a filled circle in the tone's colour (transparent outside, so
 * it is round whether or not the shade crops the large icon) with the letter centred in
 * the app's semibold face, read from the theme in force. Anything missing: `null`.
 */
export function canvasMonogram(monogram: Monogram, size: number): string | null {
  try {
    if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return null;
    const root = getComputedStyle(document.documentElement);
    const colours = MONOGRAM_COLOURS[monogram.tone];
    const background = root.getPropertyValue(colours.background).trim();
    const ink = root.getPropertyValue(colours.ink).trim();
    if (!background || !ink) return null;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = background;
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = ink;
    context.font = `600 ${Math.round(size * 0.44)}px "IBM Plex Sans", system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(monogram.initial, size / 2, size / 2 + size * 0.02);
    const data = canvas.toDataURL("image/png");
    return isNativePicture(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * What a native notification's large icon is drawn from, for one message: its resolved
 * picture when it draws, else its monogram when the platform asks for one (Android),
 * else nothing (the app icon). The picture itself was chosen by the avatar's own rules
 * (`resolveSenderPicture`), so nothing here reaches a server the app would not.
 */
export function largeIconSource(picture: string | null | undefined, drawn: string | null, monogram: Monogram | undefined): "picture" | "monogram" | "none" {
  if (picture && isNativePicture(drawn)) return "picture";
  return monogram ? "monogram" : "none";
}

/**
 * The resolved pictures, made drawable by a native notification: each URL rasterised to
 * a small PNG data URL in the webview, under the same rules that resolved it. A picture
 * that cannot be drawn is left out (the app icon shows), never passed on as a URL. With
 * `monograms` (Android), a message whose picture is missing or failed gets its sender's
 * monogram instead, as the list's avatar does; a monogram that cannot be drawn is none.
 */
export async function nativePictures(
  pictures: Readonly<Record<string, string>>,
  rasterise: Rasterise = notificationRasterise(),
  size = NATIVE_PICTURE_PIXELS,
  { monograms = {}, drawMonogram = canvasMonogram }: { monograms?: Readonly<Record<string, Monogram>>; drawMonogram?: DrawMonogram } = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const ids = new Set([...Object.keys(pictures), ...Object.keys(monograms)]);
  await Promise.all(
    [...ids].map(async (id) => {
      const url = pictures[id];
      const drawn = url ? (isNativePicture(url) ? url : await rasterise(url, size).catch(() => null)) : null;
      switch (largeIconSource(url, drawn, monograms[id])) {
        case "picture":
          out[id] = drawn as string;
          break;
        case "monogram": {
          const mono = drawMonogram(monograms[id]!, size);
          if (isNativePicture(mono)) out[id] = mono;
          break;
        }
        case "none":
          break;
      }
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
  // Android draws the sender's monogram when there is no picture, as the list does.
  const monograms = info?.os === "android" ? notificationMonograms(emails, preferences.notificationHidePreview) : {};
  const shown = info?.kind === "desktop" ? await nativePictures(pictures, undefined, undefined, { monograms }) : pictures;
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
