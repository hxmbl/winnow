/**
 * The every-tenth-load update check, as pure logic.
 *
 * Every load of the app counts: a cold launch, Android reloading the webview on resume,
 * a page reload. Each one runs the bundle once, and `useUpdates` counts it once (a
 * module flag, so React's double effects in development do not count twice). On a load
 * that brings the count to `LOAD_CHECK_EVERY`, the app runs its usual background check
 * (`useUpdates`' `runCheck(false)`): nothing waits for it, a failure says nothing, and a
 * newer release turns the version shortcut's button into "Update" and is announced once
 * in the status pill, exactly as the six-hourly check does. Nothing installs by itself.
 *
 * - Native builds only (`updateButtonShown`): the web build and the Docker image never
 *   count or check.
 * - Any check that runs (this one, the six-hourly one, or "Check for updates") resets the
 *   count, so the next load check is ten loads after the last check of any kind.
 * - A due load that cannot check (offline, a check already running) keeps the count, so
 *   the check comes as soon as it can: when the network is back, or on a later load.
 * - "Check for updates automatically" off means no load checks either, and a browser
 *   driven by automation never checks by itself unless the page opts in
 *   (`window.__WINNOW_LOAD_CHECK__ = true`, set by `smoke-android.mjs`).
 */

import type { UpdateRuntime } from "../core/updates/updates";
import { updateButtonShown } from "./updateButton";

/** Check for updates on every this-many loads of the app. */
export const LOAD_CHECK_EVERY = 10;

/** Where the count is kept (`localStorage`): loads since the last check. */
export const LOAD_COUNT_KEY = "winnow.updates.loads.v1";

/** The stored count, or 0 for anything that is not a whole, non-negative number. */
export function parseLoadCount(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return 0;
  return Number(raw.trim());
}

/** Whether this copy counts loads at all: a native build, once it has said how it runs. */
export function countsLoads(runtime: UpdateRuntime | null): boolean {
  return updateButtonShown(runtime);
}

/** The count after one more load. Capped, so a long-offline device cannot overflow it. */
export function countLoad(count: number): number {
  return Math.min(Math.max(0, Math.floor(count)) + 1, LOAD_CHECK_EVERY);
}

export type LoadCheckInput = {
  runtime: UpdateRuntime | null;
  /** Loads since the last check, this one included. */
  count: number;
  /** "Check for updates automatically". */
  auto: boolean;
  online: boolean;
  /** A browser driven by automation that did not opt in. */
  automated: boolean;
  /** A check is already running. */
  inFlight: boolean;
};

/** Whether this load should start the background check now. */
export function loadCheckDue(input: LoadCheckInput): boolean {
  return (
    countsLoads(input.runtime) &&
    input.count >= LOAD_CHECK_EVERY &&
    input.auto &&
    input.online &&
    !input.automated &&
    !input.inFlight
  );
}
