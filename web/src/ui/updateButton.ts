/**
 * The update button beside the version shortcut (tap the Winnow mark: "Winnow 1.5.5"),
 * as pure logic. One button that walks through the states of a manual check:
 *
 *   Check for updates → Checking… → Update (a newer release) or No updates available,
 *   which goes back to Check for updates after `NOTICE_MS`.
 *
 * "Update" runs the app's own updater (`useUpdates().install`: Tauri's updater on macOS
 * and the AppImage, the SHA256SUMS-checked APK on Android and `.deb` on Debian), and then
 * says the stage it is at (`core/updates/stages.ts`): "Downloading 42%", "Verifying…",
 * "Installing…" (or "Opening installer…" for the APK and the `.deb`). A check that
 * fails says so for the same few seconds.
 *
 * Only where this copy can update itself: a native build. The web build (and the Docker
 * image, which is one) has no updater, so the button is not there at all.
 */

import type { UpdateChannel, UpdateRuntime } from "../core/updates/updates";
import { installing, stageButtonLabel, type UpdateStage } from "../core/updates/stages";
import type { UpdateStatus } from "./useUpdates";

/** How long "No updates available" (or a failed check) stays before the button resets, ms. */
export const NOTICE_MS = 3000;

export type UpdateButtonView =
  | "check"
  | "checking"
  | "update"
  /** Installing, before the host has said which stage it is at. */
  | "updating"
  | "downloading"
  | "verifying"
  | "installing"
  | "none"
  | "failed";

/** What the button said after a check it started settled, until `NOTICE_MS` passes. */
export type UpdateNotice = "none" | "failed";

export const UPDATE_BUTTON_LABEL: Record<UpdateButtonView, string> = {
  check: "Check for updates",
  checking: "Checking…",
  update: "Update",
  updating: "Updating…",
  downloading: "Downloading…",
  verifying: "Verifying…",
  installing: "Installing…",
  none: "No updates available",
  failed: "Couldn't check",
};

/** The channels with an updater in the app: every native build. */
const NATIVE: ReadonlySet<UpdateChannel> = new Set<UpdateChannel>(["macos", "appimage", "deb", "android", "manual"]);

/** Whether the button is shown: a native build, once it has said how it runs. */
export function updateButtonShown(runtime: UpdateRuntime | null): boolean {
  return runtime !== null && NATIVE.has(runtime.channel);
}

/** The button's state from the updater's, and the notice a check it started left. */
export function updateButtonView(
  status: UpdateStatus,
  hasOffer: boolean,
  notice: UpdateNotice | null,
  stage?: UpdateStage,
): UpdateButtonView {
  if (stage && installing(stage)) return stage.stage;
  if (status === "installing") return "updating";
  if (hasOffer) return "update";
  if (status === "checking") return "checking";
  return notice ?? "check";
}

/** What a press does in a state: check, install, or nothing while busy. */
export function updateButtonPress(view: UpdateButtonView): "check" | "install" | null {
  switch (view) {
    case "check":
    case "none":
    case "failed":
      return "check";
    case "update":
      return "install";
    case "checking":
    case "updating":
    case "downloading":
    case "verifying":
    case "installing":
      return null;
  }
}

/**
 * The button's words: the view's label, or while an install runs the stage's own
 * ("Downloading 42%", "Opening installer…").
 */
export function updateButtonLabel(view: UpdateButtonView, stage?: UpdateStage): string {
  if (stage && installing(stage) && stage.stage === view) return stageButtonLabel(stage) ?? UPDATE_BUTTON_LABEL[view];
  return UPDATE_BUTTON_LABEL[view];
}

/** The notice a settled check leaves: none newer, or it failed. `null` while it runs. */
export function noticeAfterCheck(status: UpdateStatus, hasOffer: boolean): UpdateNotice | null {
  if (hasOffer || status === "checking" || status === "installing") return null;
  if (status === "current") return "none";
  if (status === "failed") return "failed";
  return null;
}
