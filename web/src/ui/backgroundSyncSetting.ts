/**
 * Whether Settings → Notifications & sync offers "Keep syncing while closed".
 *
 * Two different facts used to share one prop: whether this build *can* sync with the
 * window closed (`PlatformInfo.backgroundSync`) and whether the user *wants* it
 * (`preferences.backgroundSync`). The switch was drawn from the first, so it could never
 * change (STRM-426). This keeps the capability to deciding what is shown; the switch
 * itself always shows the preference.
 *
 * - `switch`: the desktop app, which keeps a tray ticker running.
 * - `native-note`: a native build without one, which today is the Android app: Android
 *   pauses a backgrounded WebView, so ticks would land nowhere (`app_info` in
 *   `native/src-tauri/src/commands.rs`).
 * - `web-note`: a browser tab, or the platform has not answered yet.
 */
export type BackgroundSyncOffer = "switch" | "native-note" | "web-note";

export function backgroundSyncOffer({
  isNative,
  available,
}: {
  /** `info.kind === "desktop"`, which the Android app reports too. */
  isNative: boolean;
  /** `info.backgroundSync`, or null before the platform answers. */
  available: boolean | null;
}): BackgroundSyncOffer {
  if (!isNative || available === null) return "web-note";
  return available ? "switch" : "native-note";
}

export const BACKGROUND_SYNC_NOTE: Record<Exclude<BackgroundSyncOffer, "switch">, string> = {
  "native-note": "Background sync isn't available on Android yet. Winnow checks for new mail while the app is open.",
  "web-note": "Background sync is only in the desktop app. Here, Winnow syncs while this tab is open.",
};
