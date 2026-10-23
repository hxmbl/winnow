/**
 * Dev Options → Check now (native builds only): the same check as About's Check now
 * (`updates.checkNow` in `useUpdates.ts`, which ignores the timer and the
 * automatic-check setting and restarts the every-tenth-load count), with its result
 * inline. It only reports: Update available, No updates available, or Couldn't check.
 * Installing stays where it was (About, the version shortcut's button); nothing here
 * ever installs.
 */

import type { UpdateOffer } from "../core/updates/updates";
import type { UpdateStatus } from "./useUpdates";

export type DevCheckState = "idle" | "checking" | "offer" | "current" | "failed";

export type DevCheckView = { state: DevCheckState; line: string | null };

const FAILED_PREFIX = "Couldn't check for updates: ";

/**
 * What the row says, from the updater's state. `asked`: this row has been pressed in
 * this visit to Settings; before that it says nothing, so an earlier background check
 * is not passed off as this one's answer.
 */
export function devCheckView(asked: boolean, status: UpdateStatus, offer: UpdateOffer | null, message: string | null): DevCheckView {
  if (!asked) return { state: "idle", line: null };
  if (status === "checking") return { state: "checking", line: "Checking…" };
  // A failed check keeps an earlier offer on screen elsewhere; this row answers the press.
  if (status === "failed") {
    const reason = message?.startsWith(FAILED_PREFIX) ? message.slice(FAILED_PREFIX.length).replace(/\.$/, "") : null;
    return { state: "failed", line: reason ? `Couldn't check: ${reason}` : "Couldn't check" };
  }
  if (offer) return { state: "offer", line: `Update available: ${offer.version} (you have ${offer.current})` };
  if (status === "current") return { state: "current", line: "No updates available" };
  return { state: "idle", line: null };
}
