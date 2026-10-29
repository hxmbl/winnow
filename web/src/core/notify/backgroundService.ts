/**
 * Background sync on Android, from the web layer's side: what the background service is
 * told, and what it answers.
 *
 * The service (`MailSyncService.kt`) runs in Kotlin with the app closed, so it cannot ask
 * the store anything. Whenever something it depends on changes (the switch,
 * notifications, accounts, muted senders, the open account), `main.tsx` builds a fresh
 * config here and hands it over (`platform.configureBackgroundService`). Nothing secret
 * is in it: the service reads the tokens from the keychain itself.
 *
 * Pure: no platform, no store.
 */

import type { NotificationActions } from "./notifications";
import { isAccountId, type AccountRecord } from "../session/accounts";

export type BackgroundServiceAccount = {
  id: string;
  /** The address shown on a notification: only with more than one account. */
  label: string | null;
  notify: boolean;
  /**
   * The address, lowercased, whatever the number of accounts: what the Gmail-app
   * listener matches the account line of a Gmail notification against. Never shown.
   */
  address: string | null;
};

export type BackgroundServiceConfig = {
  enabled: boolean;
  accounts: BackgroundServiceAccount[];
  activeAccount: string | null;
  /** 1 reply, 2 delete, 4 mark read (the native flags). */
  actions: number;
  hidePreview: boolean;
  quietSenders: string[];
  /**
   * "Instant mail via the Gmail app" (STRM-442): check as soon as the Gmail app posts a
   * notification (`GmailNotificationListener.kt`). Never on while `enabled` is off.
   */
  gmailListener: boolean;
};

export type BackgroundServiceStatus = {
  enabled: boolean;
  running: boolean;
  batteryUnrestricted: boolean;
  notificationsAllowed: boolean;
  /** The user has given Winnow Notification access in Android's settings. */
  listenerAccess: boolean;
  /** Android has the Gmail-app listener bound and the setting is on. */
  listenerConnected: boolean;
  /** The Gmail app is installed (and not disabled). */
  gmailInstalled: boolean;
};

/** The slice of preferences the service depends on. */
export type BackgroundServicePrefs = {
  backgroundSync: boolean;
  notificationsEnabled: boolean;
  notificationActions: NotificationActions;
  notificationHidePreview: boolean;
  mutedSenders: readonly string[];
  blockedSenders: readonly string[];
  /** "Instant mail via the Gmail app". Absent reads as off. */
  gmailListener?: boolean;
};

/** The native flags for the buttons a notification offers. */
export function actionFlags(actions: NotificationActions): number {
  return (actions.reply ? 1 : 0) | (actions.trash ? 2 : 0) | (actions.read ? 4 : 0);
}

/**
 * The config for the current state. On only when the user wants syncing while closed
 * *and* notifications (the service does nothing else: the inbox itself catches up when
 * the app opens) *and* an account is signed in. The address is only a label with more
 * than one account, as on every other notification.
 */
export function backgroundServiceConfig(
  prefs: BackgroundServicePrefs,
  accounts: readonly Pick<AccountRecord, "id" | "email" | "notify">[],
  activeAccount: string | null,
  signedIn: boolean,
): BackgroundServiceConfig {
  const valid = accounts.filter((account) => isAccountId(account.id));
  const several = valid.length > 1;
  const quiet = [...new Set([...prefs.mutedSenders, ...prefs.blockedSenders].map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
  const enabled = prefs.backgroundSync && prefs.notificationsEnabled && signedIn && valid.length > 0;
  return {
    enabled,
    accounts: valid.map((account) => ({
      id: account.id,
      label: several && account.email ? account.email : null,
      notify: account.notify !== false,
      address: account.email && account.email.includes("@") ? account.email.trim().toLowerCase() : null,
    })),
    activeAccount: activeAccount && valid.some((account) => account.id === activeAccount) ? activeAccount : null,
    actions: actionFlags(prefs.notificationActions),
    hidePreview: prefs.notificationHidePreview,
    quietSenders: quiet,
    gmailListener: enabled && prefs.gmailListener === true,
  };
}

/** Validate the native status answer; anything unexpected is `null`, never guessed at. */
export function parseBackgroundStatus(raw: unknown): BackgroundServiceStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.running !== "boolean") return null;
  return {
    enabled: s.enabled === true,
    running: s.running,
    batteryUnrestricted: s.batteryUnrestricted !== false,
    notificationsAllowed: s.notificationsAllowed !== false,
    // Only a definite yes counts: an older native side that says nothing has no listener.
    listenerAccess: s.listenerAccess === true,
    listenerConnected: s.listenerConnected === true,
    gmailInstalled: s.gmailInstalled === true,
  };
}

/** Validate `notify_active`'s answer (Rust's camelCase `ActiveNotice` list). */
export function parseActiveNotices(raw: unknown): { account: string | null; gmailId: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { account: string | null; gmailId: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { account, gmailId } = item as Record<string, unknown>;
    if (typeof gmailId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(gmailId)) continue;
    out.push({ account: isAccountId(account) ? account : null, gmailId });
  }
  return out;
}

/**
 * What Settings says under "Keep syncing while closed" on Android, or `null` for nothing.
 * The one thing the user can act on comes first.
 */
export function backgroundServiceHint(
  prefs: Pick<BackgroundServicePrefs, "backgroundSync" | "notificationsEnabled" | "gmailListener">,
  status: BackgroundServiceStatus | null,
): string | null {
  if (!prefs.backgroundSync) return null;
  if (!prefs.notificationsEnabled) return "Turn on notifications to get new mail while Winnow is closed.";
  if (!status) return null;
  if (!status.notificationsAllowed) return "Android isn't letting Winnow show notifications. Allow them in system settings.";
  if (!status.running) return null;
  if (prefs.gmailListener && status.listenerConnected) {
    return "Checks as soon as the Gmail app gets new mail, and every 10 minutes as a backup.";
  }
  return "Checks every 5 minutes while Winnow is closed.";
}

/** The fallback poll's pace, in minutes, as `GmailListenerLogic.pollInterval` picks it. */
export function fallbackPollMinutes(gmailListener: boolean, listenerConnected: boolean): number {
  return gmailListener && listenerConnected ? 10 : 5;
}

/**
 * What Settings says under "Instant mail via the Gmail app", or `null` for nothing: the
 * one thing in the way first (no Gmail app, no notification access), then whether
 * Android has connected it.
 */
export function gmailListenerHint(on: boolean, status: BackgroundServiceStatus | null): string | null {
  if (!on || !status) return null;
  if (!status.gmailInstalled) return "The Gmail app isn't installed, so there's nothing to listen to. Winnow checks every 5 minutes.";
  if (!status.listenerAccess) return "Needs Notification access: allow it for Winnow in Android's settings.";
  if (status.listenerConnected) return "On. The Gmail app must stay signed in with its notifications allowed.";
  return "Waiting for Android to connect it. Until then Winnow checks every 5 minutes.";
}
