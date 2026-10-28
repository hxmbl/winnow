/**
 * What Settings → Notifications & sync offers for "Keep syncing while closed".
 *
 * Two different facts used to share one prop: whether this build *can* sync with the
 * window closed (`PlatformInfo.backgroundSync`) and whether the user *wants* it
 * (`preferences.backgroundSync`). The switch was drawn from the first, so it could never
 * change (STRM-426). This keeps the capability to deciding what is shown; the switch
 * itself always shows the preference.
 *
 * - `switch`: the desktop app, which keeps a tray ticker running, with its interval.
 * - `service`: the Android app, where the switch starts and stops a foreground service
 *   that checks Gmail about once a minute with the app closed (`MailSyncService.kt`).
 *   No interval: the service's pace is fixed, and Android spaces it out when idle.
 * - `web-note`: a browser tab, or the platform has not answered yet.
 */
export type BackgroundSyncOffer = "switch" | "service" | "web-note";

export function backgroundSyncOffer({
  isNative,
  available,
  android,
}: {
  /** `info.kind === "desktop"`, which the Android app reports too. */
  isNative: boolean;
  /** `info.backgroundSync`, or null before the platform answers. */
  available: boolean | null;
  /** `info.os === "android"`. */
  android: boolean;
}): BackgroundSyncOffer {
  if (!isNative || available !== true) return "web-note";
  return android ? "service" : "switch";
}

export const BACKGROUND_SYNC_NOTE: Record<"web-note", string> = {
  "web-note": "Background sync is only in the desktop and Android apps. Here, Winnow syncs while this tab is open.",
};
