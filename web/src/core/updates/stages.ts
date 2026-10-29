/**
 * What an update is doing right now, step by step, so every place that shows one (the
 * version shortcut's button, the status pill, Settings › About) can say the real stage
 * instead of one "Updating…":
 *
 *   checking → downloading (with progress) → verifying → installing → done
 *                                                                   ↘ failed (with the reason)
 *
 * - `checking`: asking GitHub whether there is a newer release (`checkForUpdate`).
 * - `downloading`: the release file is coming down; `received` of `total` bytes when
 *   the host knows the size.
 * - `verifying`: the download is being checked before anything opens it: the APK and
 *   the `.deb` against the release's `SHA256SUMS` (since 1.5.4), the macOS app and the
 *   AppImage against the updater's signature.
 * - `installing`: Tauri's updater is swapping the app in (macOS, AppImage), or the
 *   checked file is being handed to the system installer (`.deb`) or Android's
 *   package installer (APK).
 * - `done`: what the install ended in (`InstallOutcome`).
 * - `failed`: why, as a `FailureReason` the UI can word plainly, with the host's own
 *   words kept for the debug log.
 *
 * The hosts report the middle three as they happen (`parseProgress`: Rust's
 * `UpdateProgress`, the Kotlin plugin's progress messages). Reports can arrive late or
 * twice, so the machine only moves forward: a download tick after verifying began, or
 * any report once the install has ended, changes nothing.
 *
 * Pure: no DOM, no clock, no network.
 */

import type { UpdateAction } from "./updates";

/** How the release gets installed, which decides the words for `installing`. */
export type InstallTarget = "self" | "deb" | "apk";

/** What an install ended in (the platform's `InstallOutcome`, by kind). */
export type DoneOutcome = "restarting" | "opened" | "needs-permission" | "none";

export type FailureReason =
  /** The download does not match the release's `SHA256SUMS`. */
  | "checksum-mismatch"
  /** The release has no `SHA256SUMS`, or it lists no checksum for the file. */
  | "no-checksum"
  /** Tauri's updater refused the download's signature. */
  | "signature"
  /** The download (or the checksum list) could not be fetched. */
  | "network"
  /** The file is larger than any release file should be. */
  | "too-large"
  /** A pre-release, offered without Beta updates on. */
  | "prerelease"
  /** The file was checked but could not be saved, or the installer would not open. */
  | "installer"
  /** Anything else; the host's words are shown as they are. */
  | "other";

export type UpdateStage =
  | { stage: "idle" }
  | { stage: "checking" }
  | { stage: "downloading"; target: InstallTarget; received: number; total: number | null }
  | { stage: "verifying"; target: InstallTarget }
  | { stage: "installing"; target: InstallTarget }
  | { stage: "done"; target: InstallTarget; outcome: DoneOutcome; path?: string }
  | { stage: "failed"; reason: FailureReason; detail: string };

/** A host's report from inside an install. */
export type UpdateProgress =
  | { stage: "downloading"; received: number; total: number | null }
  | { stage: "verifying" }
  | { stage: "installing" };

export type StageEvent =
  /** A check for a newer release started. */
  | { type: "check" }
  /** That check settled, whatever it found. */
  | { type: "checked" }
  /** The user pressed Update: the install starts with the download. */
  | { type: "install"; target: InstallTarget }
  /** A host's report from inside the install. */
  | { type: "progress"; progress: UpdateProgress }
  /** The install ended. */
  | { type: "finished"; outcome: DoneOutcome; path?: string }
  /** The install failed, in the host's words. */
  | { type: "failed"; detail: string }
  /** Back to rest (the result has been said, or the offer went). */
  | { type: "reset" };

export const IDLE: UpdateStage = { stage: "idle" };

/** The stages in which an install is under way. */
const ORDER = { downloading: 1, verifying: 2, installing: 3 } as const;

/** Whether an install is under way (and so another press must not start a second). */
export function installing(stage: UpdateStage): stage is Extract<UpdateStage, { stage: "downloading" | "verifying" | "installing" }> {
  return stage.stage === "downloading" || stage.stage === "verifying" || stage.stage === "installing";
}

/** Whether anything is under way: a check or an install. */
export function busy(stage: UpdateStage): boolean {
  return stage.stage === "checking" || installing(stage);
}

/** The target an offer installs through, or `null` when nothing installs here. */
export function installTarget(action: UpdateAction): InstallTarget | null {
  switch (action.kind) {
    case "self":
      return "self";
    case "deb":
      return "deb";
    case "apk":
      return "apk";
    default:
      return null;
  }
}

/** The next stage. Anything that does not fit where the update is changes nothing. */
export function advance(current: UpdateStage, event: StageEvent): UpdateStage {
  switch (event.type) {
    case "check":
      // A check never interrupts an install.
      return installing(current) || current.stage === "checking" ? current : { stage: "checking" };
    case "checked":
      return current.stage === "checking" ? IDLE : current;
    case "install":
      if (installing(current)) return current;
      return { stage: "downloading", target: event.target, received: 0, total: null };
    case "progress": {
      if (!installing(current)) return current;
      const progress = event.progress;
      if (ORDER[progress.stage] < ORDER[current.stage]) return current;
      const target = current.target;
      if (progress.stage === "downloading") {
        const before = current.stage === "downloading" ? current : null;
        const total = progress.total ?? before?.total ?? null;
        // Never backwards, never past the size the host gave.
        let received = Math.max(progress.received, before?.received ?? 0);
        if (total !== null) received = Math.min(received, total);
        if (before && before.received === received && before.total === total) return current;
        return { stage: "downloading", target, received, total };
      }
      if (progress.stage === current.stage) return current;
      return { stage: progress.stage, target };
    }
    case "finished":
      if (!installing(current)) return current;
      return {
        stage: "done",
        target: current.target,
        outcome: event.outcome,
        ...(event.path ? { path: event.path } : {}),
      };
    case "failed": {
      if (!installing(current)) return current;
      const detail = event.detail.trim() || "the update could not be installed";
      return { stage: "failed", reason: failureReason(detail), detail };
    }
    case "reset":
      return installing(current) ? current : IDLE;
  }
}

/**
 * Which failure a host's message is. The hosts' own words (`updater.rs`, `UpdatePlugin.kt`,
 * Tauri's updater) are matched loosely, so a reworded message still lands on the right
 * reason rather than in `other`.
 */
export function failureReason(detail: string): FailureReason {
  const text = detail.toLowerCase();
  if (/doesn't match|does not match|didn't match|mismatch/.test(text) && text.includes("checksum")) return "checksum-mismatch";
  if (/no checksums?|lists no checksum|sha256sums/.test(text)) return "no-checksum";
  if (text.includes("signature")) return "signature";
  if (text.includes("pre-release")) return "prerelease";
  if (text.includes("too large")) return "too-large";
  if (/could not save|couldn't save|installer could not|installer couldn't|could not be opened/.test(text)) return "installer";
  if (/download failed|network|timed? ?out|connection|http \d|dns|offline|unreachable|failed to fetch|error sending request/.test(text)) {
    return "network";
  }
  return "other";
}

/** The plain words for a failure, as the end of "Couldn't update: …". */
export function failureText(reason: FailureReason, detail: string): string {
  switch (reason) {
    case "checksum-mismatch":
      return "the download didn't match the release's checksum, so it wasn't installed.";
    case "no-checksum":
      return "the release has no checksum for this file, so it wasn't installed.";
    case "signature":
      return "the download's signature didn't check out, so it wasn't installed.";
    case "network":
      return "the download didn't finish. Check your connection and try again.";
    case "too-large":
      return "the download was larger than any Winnow release, so it was stopped.";
    case "prerelease":
      return "that release is a pre-release. Turn on Beta updates in Dev Options to get it.";
    case "installer":
      return `the download was checked but couldn't be opened (${stripFinalStop(detail)}).`;
    case "other":
      return `${stripFinalStop(detail)}.`;
  }
}

function stripFinalStop(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

/** Whole percent of a download, or `null` when the size is unknown. */
export function percent(received: number, total: number | null): number | null {
  if (total === null || !(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
}

/** "12.3 MB": a size for a download without a known total. */
export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** What `installing` is called for a target. */
function installingText(target: InstallTarget, version: string): string {
  switch (target) {
    case "self":
      return `Installing Winnow ${version}…`;
    case "deb":
      return "Opening the installer…";
    case "apk":
      return "Opening Android's installer…";
  }
}

/** How far a download has got, for after "Downloading …": "42%", or "12.3 MB" without a size. */
function downloadAmount(stage: Extract<UpdateStage, { stage: "downloading" }>): string | null {
  const share = percent(stage.received, stage.total);
  if (share !== null) return `${share}%`;
  return stage.received > 0 ? megabytes(stage.received) : null;
}

/**
 * The full sentence for a stage, for the pill and Settings: "Downloading Winnow 1.7.0… 42%",
 * "Verifying the download…", "Couldn't update: the download didn't match…". `null` at rest.
 */
export function stageText(stage: UpdateStage, version: string): string | null {
  switch (stage.stage) {
    case "idle":
      return null;
    case "checking":
      return "Checking for updates…";
    case "downloading": {
      const amount = downloadAmount(stage);
      return `Downloading Winnow ${version}…${amount ? ` ${amount}` : ""}`;
    }
    case "verifying":
      return "Verifying the download…";
    case "installing":
      return installingText(stage.target, version);
    case "done":
      return doneText(stage, version);
    case "failed":
      return `Couldn't update: ${failureText(stage.reason, stage.detail)}`;
  }
}

/** What an install ended in, in words. */
export function doneText(stage: Extract<UpdateStage, { stage: "done" }>, version: string): string {
  switch (stage.outcome) {
    case "restarting":
      return `Restarting into Winnow ${version}…`;
    case "opened":
      if (stage.path) return `Saved to ${stage.path}. If no installer opened, run: sudo apt install ${stage.path}`;
      return "Android's installer is open. Confirm there to update.";
    case "needs-permission":
      return "Allow Winnow to install apps in the page that opened, then press Update again.";
    case "none":
      return `Opened the Winnow ${version} release page to download it.`;
  }
}

/**
 * The short label for a button while an install runs: "Downloading 42%", "Verifying…",
 * "Installing…", "Opening installer…". `null` when no install is under way.
 */
export function stageButtonLabel(stage: UpdateStage): string | null {
  switch (stage.stage) {
    case "downloading": {
      const share = percent(stage.received, stage.total);
      return share === null ? "Downloading…" : `Downloading ${share}%`;
    }
    case "verifying":
      return "Verifying…";
    case "installing":
      return stage.target === "self" ? "Installing…" : "Opening installer…";
    default:
      return null;
  }
}

/**
 * What a screen reader hears for a stage: the stage's words without the running
 * percentage, so a download is announced once rather than at every tick.
 */
export function stageAnnouncement(stage: UpdateStage, version: string): string {
  if (stage.stage === "downloading") return `Downloading Winnow ${version}.`;
  return stageText(stage, version) ?? "";
}

/**
 * A host's progress report, as it arrives over IPC, or `null` when it is not one. Both
 * hosts send `{ stage, received?, total? }`; sizes may be missing, zero or nonsense.
 */
export function parseProgress(wire: unknown): UpdateProgress | null {
  if (!wire || typeof wire !== "object") return null;
  const raw = wire as Record<string, unknown>;
  switch (raw.stage) {
    case "downloading": {
      const count = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
      const total = count(raw.total);
      return { stage: "downloading", received: count(raw.received) ?? 0, total: total && total > 0 ? total : null };
    }
    case "verifying":
      return { stage: "verifying" };
    case "installing":
      return { stage: "installing" };
    default:
      return null;
  }
}
