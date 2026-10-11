/**
 * Platform selector.
 */

import { desktopPlatform, desktopPlatformExtras } from "./desktop";
import { webPlatform } from "./web";
import type { Platform } from "./types";

export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const candidate = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(candidate.__TAURI_INTERNALS__ ?? candidate.__TAURI__);
}

export function createPlatform(): Platform {
  return isTauri() ? desktopPlatform : webPlatform;
}

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
