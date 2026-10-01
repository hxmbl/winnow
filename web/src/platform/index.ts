/**
 * Choosing a platform.
 *
 * One function, called once at startup. The detection is deliberately
 * conservative: it looks for the Tauri IPC bridge rather than a user agent,
 * because the webview *is* Safari or Chrome and only the injected
 * `__TAURI_INTERNALS__` distinguishes it.
 *
 * Everything below this file is written against the `Platform` interface and
 * has no idea which one it got.
 */

import { desktopPlatform, desktopPlatformExtras } from "./desktop";
import { webPlatform } from "./web";
import type { Platform } from "./types";

/**
 * True when running inside the Tauri shell.
 *
 * `__TAURI_INTERNALS__` is injected by the Tauri bootstrap before any app code
 * runs. The previous implementation checked for a `window.Tauri` global, which
 * is the *v1* API: Tauri 2 has no such global unless `withGlobalTauri` is on,
 * so the check never fired and every native call silently fell back to a stub.
 */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const candidate = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(candidate.__TAURI_INTERNALS__ ?? candidate.__TAURI__);
}

/** The platform for this build. */
export function createPlatform(): Platform {
  return isTauri() ? desktopPlatform : webPlatform;
}

/** The singleton the app uses. */
export const platform: Platform = createPlatform();

export { desktopPlatform, desktopPlatformExtras, webPlatform };
export type {
  NewMailNotification,
  OAuthRedirect,
  Platform,
  PlatformInfo,
  PlatformKey,
  SignInRequest,
} from "./types";
export { PLATFORM_KEYS, webTokenStore } from "./types";
