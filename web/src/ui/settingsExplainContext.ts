/**
 * How a setting row reports that it was pointed at, and how its (?) popover is driven.
 *
 * In the three-column layout (`mode: "panel"`) rows call `point` on hover and focus and
 * the explanation column shows the last one. Below 1200px (`mode: "popover"`) each row
 * carries a (?) button instead, and one popover at a time is open (`info`).
 */

import { createContext } from "react";
import type { SettingId } from "./settingsCatalog";
import { INFO_CLOSED, type InfoEvent, type InfoState } from "./settingsView";

export type SettingsExplainContext = {
  mode: "panel" | "popover";
  point: (setting: SettingId) => void;
  /** The setting the explanation column describes, if any. */
  pointed: SettingId | null;
  info: InfoState;
  dispatchInfo: (event: InfoEvent) => void;
};

export const SettingsExplain = createContext<SettingsExplainContext>({
  mode: "panel",
  point: () => {},
  pointed: null,
  info: INFO_CLOSED,
  dispatchInfo: () => {},
});
