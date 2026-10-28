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

export type BackgroundServiceAccount = { id: string; label: string | null; notify: boolean };

export type BackgroundServiceConfig = {
  enabled: boolean;
  accounts: BackgroundServiceAccount[];
  activeAccount: string | null;
  /** 1 reply, 2 delete, 4 mark read (the native flags). */
  actions: number;
  hidePreview: boolean;
  quietSenders: string[];
};

export type BackgroundServiceStatus = {
  enabled: boolean;
  running: boolean;
  batteryUnrestricted: boolean;
  notificationsAllowed: boolean;
};

/** The slice of preferences the service depends on. */
export type BackgroundServicePrefs = {
  backgroundSync: boolean;
  notificationsEnabled: boolean;
  notificationActions: NotificationActions;
  notificationHidePreview: boolean;
  mutedSenders: readonly string[];
  blockedSenders: readonly string[];
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
  return {
    enabled: prefs.backgroundSync && prefs.notificationsEnabled && signedIn && valid.length > 0,
    accounts: valid.map((account) => ({
      id: account.id,
      label: several && account.email ? account.email : null,
      notify: account.notify !== false,
    })),
    activeAccount: activeAccount && valid.some((account) => account.id === activeAccount) ? activeAccount : null,
    actions: actionFlags(prefs.notificationActions),
    hidePreview: prefs.notificationHidePreview,
    quietSenders: quiet,
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
  prefs: Pick<BackgroundServicePrefs, "backgroundSync" | "notificationsEnabled">,
  status: BackgroundServiceStatus | null,
): string | null {
  if (!prefs.backgroundSync) return null;
  if (!prefs.notificationsEnabled) return "Turn on notifications to get new mail while Winnow is closed.";
  if (!status) return null;
  if (!status.notificationsAllowed) return "Android isn't letting Winnow show notifications. Allow them in system settings.";
  if (status.running) return "Checks about once a minute while Winnow is closed.";
  return null;
}
