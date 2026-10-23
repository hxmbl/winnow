/**
 * When the offline download (`core/offline/downloader.ts`) should wait.
 *
 * Read from the host, which is why this is in `platform/`: the network state, whether
 * the app is on screen, the Network Information API's data-saver and connection type,
 * and the Battery Status API. The Android WebView (Chromium) has all three; desktop
 * WebKit and Firefox have only `onLine` and visibility, which is fine.
 *
 * - **offline**: `navigator.onLine` is false.
 * - **hidden**: the app is not on screen *on a phone* (Android, or a touch device with a
 *   phone-sized screen): Android pauses a background WebView anyway, and downloading in
 *   the background is the battery cost the user did not choose. On the desktop a hidden
 *   window keeps downloading.
 * - **metered**: Data Saver is on (`connection.saveData`) or the connection says it is
 *   cellular. Android's own "metered Wi-Fi" flag and Battery Saver are not visible to a
 *   WebView without a native plugin; this is the closest the web layer can see.
 * - **battery**: below `LOW_BATTERY` and not charging.
 */

import type { DownloadBlock } from "../core/offline/downloader";

/** Below this charge, unplugged, downloading waits. */
export const LOW_BATTERY = 0.2;

export type DownloadEnvironment = {
  online: boolean;
  hidden: boolean;
  phone: boolean;
  saveData?: boolean;
  connectionType?: string;
  battery?: { level: number; charging: boolean } | null;
};

export function downloadBlock(env: DownloadEnvironment): DownloadBlock | null {
  if (!env.online) return "offline";
  if (env.phone && env.hidden) return "hidden";
  if (env.saveData || env.connectionType === "cellular") return "metered";
  if (env.battery && !env.battery.charging && env.battery.level < LOW_BATTERY) return "battery";
  return null;
}

type BatteryLike = { level: number; charging: boolean; addEventListener?: (type: string, listener: () => void) => void };
type NavigatorLike = {
  onLine?: boolean;
  connection?: { saveData?: boolean; type?: string };
  getBattery?: () => Promise<BatteryLike>;
};

/**
 * The live reading for this host. `phone()` says whether this is a phone (asked each time:
 * a tablet turning into a phone layout counts). The battery is read once and then kept
 * current by its own events.
 */
export function hostDownloadConditions(phone: () => boolean): () => DownloadBlock | null {
  const nav = globalThis.navigator as unknown as NavigatorLike | undefined;
  let battery: { level: number; charging: boolean } | null = null;
  void nav
    ?.getBattery?.()
    .then((reading) => {
      const update = () => {
        battery = { level: reading.level, charging: reading.charging };
      };
      update();
      reading.addEventListener?.("levelchange", update);
      reading.addEventListener?.("chargingchange", update);
    })
    .catch(() => undefined);
  return () =>
    downloadBlock({
      online: nav?.onLine ?? true,
      hidden: globalThis.document?.visibilityState === "hidden",
      phone: phone(),
      saveData: nav?.connection?.saveData,
      connectionType: nav?.connection?.type,
      battery,
    });
}
