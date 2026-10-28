/**
 * Settings → About → Export settings / Import settings…, wired to the live values.
 *
 * What goes in the file and how an import is checked is `settingsTransfer.ts`; this is
 * only where the values come from and where an import goes: the shared preferences
 * through the store (so they persist and repaint at once), Dev Options through their own
 * slot, the update switch through `useUpdates`, and the reader's width through its own
 * key, with a `storage` event so the open divider follows.
 */

import { useCallback, useMemo } from "react";
import type { Preferences } from "../core/store/store";
import type { Platform, PlatformInfo } from "../platform/types";
import type { DevOptions } from "./devOptions";
import { saveDevOptions } from "./devOptions";
import { READER_SPLIT_KEY, loadReaderFraction, saveReaderFraction } from "./readerSplit";
import {
  collectSettings,
  mergeDevOptions,
  serialiseSettings,
  settingsFileName,
  splitSettings,
  type ExportedSettings,
} from "./settingsTransfer";

export type SettingsTransfer = {
  /** The current values, as an import compares against them. */
  current: () => ExportedSettings;
  /** Write the file the way this host saves files. Resolves with a sentence for the row. */
  exportFile: () => Promise<string>;
  /** Apply an import that has been checked and confirmed. */
  apply: (settings: ExportedSettings) => void;
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** What the Export row says once the file is out. */
export function exportedMessage(path: string | null, info: Pick<PlatformInfo, "kind"> | null, filename: string): string {
  if (path && !path.startsWith("content:")) return `Saved to ${path}`;
  if (path) return "Saved.";
  return info?.kind === "desktop" ? "Not saved." : `Downloaded ${filename}.`;
}

export function useSettingsTransfer(options: {
  platform: Platform;
  info: PlatformInfo | null;
  preferences: Preferences;
  setPreferences: (patch: Partial<Preferences>) => void;
  devOptions: DevOptions;
  setDevOptions: (next: DevOptions) => void;
  autoCheckUpdates: boolean;
  setAutoCheckUpdates: (value: boolean) => void;
  /** Ask for notification permission, as turning the switch on does. */
  onNotificationsEnabled: () => void;
}): SettingsTransfer {
  const {
    platform,
    info,
    preferences,
    setPreferences,
    devOptions,
    setDevOptions,
    autoCheckUpdates,
    setAutoCheckUpdates,
    onNotificationsEnabled,
  } = options;

  const current = useCallback(
    () =>
      collectSettings({
        preferences,
        dev: devOptions,
        autoCheckUpdates,
        readerFraction: loadReaderFraction(storage()),
      }),
    [preferences, devOptions, autoCheckUpdates],
  );

  const exportFile = useCallback(async () => {
    const filename = settingsFileName();
    const text = serialiseSettings(current(), { app: info ? `${info.name} ${info.version}` : null });
    const path = await platform.saveFile(filename, new TextEncoder().encode(text), "application/json");
    return exportedMessage(path, info, filename);
  }, [current, info, platform]);

  const apply = useCallback(
    (settings: ExportedSettings) => {
      const split = splitSettings(settings);
      if (Object.keys(split.preferences).length > 0) setPreferences(split.preferences);
      if (split.preferences.notificationsEnabled === true && !preferences.notificationsEnabled) onNotificationsEnabled();
      if (Object.keys(split.dev).length > 0) {
        const next = mergeDevOptions(devOptions, split.dev);
        saveDevOptions(next);
        setDevOptions(next);
      }
      if (split.autoCheckUpdates !== undefined && split.autoCheckUpdates !== autoCheckUpdates) {
        setAutoCheckUpdates(split.autoCheckUpdates);
      }
      if (split.readerFraction !== undefined) {
        saveReaderFraction(storage(), split.readerFraction);
        // The divider follows other windows through `storage`; this window raises it itself.
        try {
          globalThis.dispatchEvent?.(new StorageEvent("storage", { key: READER_SPLIT_KEY }));
        } catch {
          // No StorageEvent (an old WebView): the width applies on the next launch.
        }
      }
    },
    [
      setPreferences,
      preferences.notificationsEnabled,
      onNotificationsEnabled,
      devOptions,
      setDevOptions,
      autoCheckUpdates,
      setAutoCheckUpdates,
    ],
  );

  return useMemo(() => ({ current, exportFile, apply }), [current, exportFile, apply]);
}
