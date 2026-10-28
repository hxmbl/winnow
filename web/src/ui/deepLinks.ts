/**
 * `winnow://` links reaching the running app: a notification's tap (one message, or a
 * summary's account inbox), the background sync notification's "just open", and
 * Android's sign-in page bringing the app back.
 *
 * Two routes deliver them. A link that arrives while the app is up comes as an event
 * (`onDeepLink`). A link the app was *started* for was usually announced before the page
 * listened, so the page asks for it once it does (`launchLinks`). On Android the native
 * side also keeps every tap for that ask (`LaunchLinks.kt`), because the deep-link plugin
 * misses a tap that starts a new activity in a process the background sync service kept
 * alive, so after each event the kept copy is taken too: the same link must not open
 * twice now, nor again on the next page load. `wireDeepLinks` owns both routes; what
 * each link does is `deepLinkRoute`. Here rather than in `main.tsx` so it is testable.
 */

import { parseDeepLink, type NotificationActionEvent } from "../core/notify/notifications";

/** What one link asks of the app. */
export type DeepLinkRoute =
  /** Nothing beyond bringing the window forward (sign-in's return, an unknown link). */
  | { kind: "focus" }
  /** Bring it forward and sync (`winnow://open`, the background sync notification). */
  | { kind: "refresh" }
  /** A notification's tap: open that message, or that account's inbox. */
  | { kind: "action"; event: NotificationActionEvent };

export function deepLinkRoute(url: string): DeepLinkRoute {
  const link = parseDeepLink(url);
  // Android's sign-in success page links here only to bring the app forward; the
  // sign-in itself finishes in `session.ts`, so there is nothing else to do.
  if (!link || link.kind === "signed-in") return { kind: "focus" };
  if (link.kind === "open") return { kind: "refresh" };
  return {
    kind: "action",
    event: {
      action: link.kind === "message" ? "open" : "inbox",
      messageId: link.kind === "message" ? link.messageId : 0,
      gmailId: link.kind === "message" ? link.gmailId : "",
      // Asked of the app, not reported as done: the tap only opens.
      origin: "desktop",
      ...(link.account ? { account: link.account } : {}),
    },
  };
}

/** How long the same link counts as the same tap, arriving by both routes. */
export const REPEAT_LINK_MS = 10_000;

/**
 * `true` for a link to act on, `false` for the same link again within `windowMs` (one
 * tap that came by the event and by the launch ask). A second tap on the same
 * notification after that is acted on again.
 */
export function linkRepeatFilter(windowMs = REPEAT_LINK_MS, now: () => number = Date.now): (url: string) => boolean {
  const seen = new Map<string, number>();
  return (raw) => {
    const url = raw.trim();
    const at = now();
    for (const [key, when] of seen) if (at - when > windowMs) seen.delete(key);
    if (seen.has(url)) return false;
    seen.set(url, at);
    return true;
  };
}

export type DeepLinkSources = {
  /** Links arriving while the app runs; returns the unsubscribe. */
  onDeepLink(handler: (url: string) => void): () => void;
  /** Links the app was started for (taken once on Android); `[]` when none. */
  launchLinks(): Promise<string[]>;
  /** Whether a link the event delivered is also kept natively and must be taken (Android). */
  keepsDeliveredLinks(): Promise<boolean>;
};

/**
 * Deliver every link to `open` exactly once: the launch links now, each event's link as
 * it comes, and on Android the kept copy after each event (dropped as a repeat, or a link
 * the event route lost, opened). Not on the desktop, whose "current" link can be an
 * older launch's (a second launch's link arrives by event only). Returns the unsubscribe.
 */
export function wireDeepLinks(sources: DeepLinkSources, open: (url: string) => void, fresh = linkRepeatFilter()): () => void {
  const deliver = (url: string) => {
    if (fresh(url)) open(url);
  };
  const takeLaunchLinks = () =>
    sources
      .launchLinks()
      .then((urls) => urls.forEach(deliver))
      .catch(() => undefined);
  const keeps = sources.keepsDeliveredLinks().catch(() => false);
  const unlisten = sources.onDeepLink((url) => {
    deliver(url);
    void keeps.then((yes) => (yes ? takeLaunchLinks() : undefined));
  });
  void takeLaunchLinks();
  return unlisten;
}
