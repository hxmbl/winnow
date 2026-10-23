/**
 * Automatic updates, as the app runs them: when to check, what to say, and what the
 * Update button does. The decisions are `core/updates/updates.ts`; installing is the
 * platform's (`installUpdate`); this hook owns the timer and the stored state.
 *
 * - Checks on launch and then at most every six hours (an hour after a failure), only
 *   while online, and only with "Check for updates automatically" on. A browser driven
 *   by automation (`navigator.webdriver`, the smoke tests) never checks by itself, so
 *   a test run neither calls GitHub nor finds a pill it did not expect.
 * - A newer version is announced once in the status pill. Dismissing it, pressing
 *   Update, or letting it go by itself all mark that version seen, and it is not
 *   announced again; a newer release is. Settings › About keeps offering it.
 * - On a native build, every tenth load of the app also runs the background check
 *   (`loadCheck.ts`); any check resets that count, "Check for updates" included.
 * - "What's new" (from the pill or Settings) shows the notes of every release between
 *   the installed version and the newest, newest first (`core/updates/changelog.ts`).
 */

import { debugLog } from "../core/debug/debugLog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkDue,
  checkForUpdate,
  dismiss,
  msUntilDue,
  offerButton,
  offerText,
  parseUpdateState,
  recordCheck,
  serialiseUpdateState,
  shouldAnnounce,
  type UpdateOffer,
  type UpdateRuntime,
  type UpdateState,
} from "../core/updates/updates";
import { fetchChangelog, type ChangelogEntry } from "../core/updates/changelog";
import type { Platform } from "../platform/types";
import { LOAD_COUNT_KEY, countLoad, countsLoads, loadCheckDue, parseLoadCount } from "./loadCheck";

export const UPDATE_STATE_KEY = "winnow.updates.v1";

/** How long the pill's announcement stays before it goes by itself. */
export const ANNOUNCE_MS = 12_000;

/** How long the pill keeps an install's result. */
const RESULT_MS = 10_000;

export type UpdateStatus = "idle" | "checking" | "current" | "failed" | "installing";

export type ChangelogState =
  | { status: "loading" }
  | { status: "ok"; entries: ChangelogEntry[] }
  | { status: "failed"; reason: string };

export type UpdatesController = {
  runtime: UpdateRuntime | null;
  auto: boolean;
  setAuto: (value: boolean) => void;
  /** The newer release, once a check has found one. */
  offer: UpdateOffer | null;
  /** The latest published version when this one is current, once known. */
  latest: string | null;
  status: UpdateStatus;
  /** The last thing an install or a manual check had to say (an error, the apt command). */
  message: string | null;
  /** The pill's announcement, while it shows. */
  announcement: { at: number; text: string; button: string | null } | null;
  checkNow: () => void;
  install: () => void;
  dismissAnnouncement: () => void;
  /** "What's new": the notes for every release since the installed one, while open. */
  whatsNew: ChangelogState | null;
  openWhatsNew: () => void;
  closeWhatsNew: () => void;
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readState(): UpdateState {
  try {
    return parseUpdateState(storage()?.getItem(UPDATE_STATE_KEY));
  } catch {
    return parseUpdateState(null);
  }
}

function writeState(state: UpdateState): void {
  try {
    storage()?.setItem(UPDATE_STATE_KEY, serialiseUpdateState(state));
  } catch {
    // Private mode or a full quota: the next launch checks again, which is harmless.
  }
}

/** Loads since the last check (`loadCheck.ts`); 0 when storage is out of reach. */
function readLoadCount(): number {
  try {
    return parseLoadCount(storage()?.getItem(LOAD_COUNT_KEY));
  } catch {
    return 0;
  }
}

function writeLoadCount(count: number): void {
  try {
    storage()?.setItem(LOAD_COUNT_KEY, String(count));
  } catch {
    // Unwritable storage: no load check, which is harmless.
  }
}

/** This load of the bundle has been counted (once, whatever React's effects do). */
let loadCounted = false;

function isOnline(): boolean {
  return globalThis.navigator?.onLine !== false;
}

function automated(): boolean {
  return globalThis.navigator?.webdriver === true;
}

/** Automation that asked for the load check anyway (`smoke-android.mjs`). */
function loadCheckOptIn(): boolean {
  return (globalThis as { __WINNOW_LOAD_CHECK__?: unknown }).__WINNOW_LOAD_CHECK__ === true;
}

export function useUpdates(
  platform: Platform,
  flash: (text: string, ms: number) => void,
  /** Dev Options → Beta updates (`ui/devOptions.ts`); only a native build honours it (`betaChannel`). */
  beta = false,
): UpdatesController {
  const [hostRuntime, setRuntime] = useState<UpdateRuntime | null>(null);
  const runtime = useMemo(() => (hostRuntime ? { ...hostRuntime, beta } : null), [hostRuntime, beta]);
  const [state, setStateRaw] = useState<UpdateState>(readState);
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<UpdatesController["announcement"]>(null);
  const [online, setOnline] = useState(isOnline);
  const [whatsNew, setWhatsNew] = useState<ChangelogState | null>(null);
  /** The notes once fetched, by `current→latest`, so reopening is instant. */
  const changelogCache = useRef<{ key: string; entries: ChangelogEntry[] } | null>(null);

  // Beta updates turned off: a pre-release offer already on screen is withdrawn (it is
  // not installed, and nothing is downgraded); the next check is the stable channel's.
  useEffect(() => {
    if (beta || !offer?.beta) return;
    setOffer(null);
    setAnnouncement(null);
  }, [beta, offer]);

  const stateRef = useRef(state);
  const setState = useCallback((update: (current: UpdateState) => UpdateState) => {
    const next = update(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    writeState(next);
    setStateRaw(next);
  }, []);

  // How this copy runs. A host without `updateRuntime` is the web build.
  useEffect(() => {
    let cancelled = false;
    const ask = platform.updateRuntime?.() ?? platform.info().then((info) => ({
      channel: "web" as const,
      version: info.version,
      arch: info.arch,
    }));
    void ask
      .then((value) => {
        if (!cancelled) setRuntime(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    const update = () => setOnline(isOnline());
    globalThis.addEventListener?.("online", update);
    globalThis.addEventListener?.("offline", update);
    return () => {
      globalThis.removeEventListener?.("online", update);
      globalThis.removeEventListener?.("offline", update);
    };
  }, []);

  /** Loads since the last check, once this load has been counted (native builds only). */
  const [loadCount, setLoadCount] = useState<number | null>(null);
  const resetLoadCount = useCallback(() => {
    if (!countsLoads(runtime)) return;
    writeLoadCount(0);
    setLoadCount(0);
  }, [runtime]);

  // Count this load, once the runtime says it is a native build.
  useEffect(() => {
    if (!countsLoads(runtime) || loadCounted) return;
    loadCounted = true;
    const count = countLoad(readLoadCount());
    writeLoadCount(count);
    setLoadCount(count);
  }, [runtime]);

  const checking = useRef(false);
  const runCheck = useCallback(
    async (manual: boolean) => {
      if (!runtime || checking.current) return;
      checking.current = true;
      setStatus("checking");
      if (manual) setMessage(null);
      const started = Date.now();
      debugLog("updates", "check", { manual, channel: runtime.channel });
      const result = await checkForUpdate(runtime, (url, init) => globalThis.fetch(url, init));
      checking.current = false;
      debugLog("updates", "result", {
        kind: result.kind,
        ms: Date.now() - started,
        version: result.kind === "offer" ? result.offer.version : result.kind === "current" ? result.latest : undefined,
        reason: result.kind === "failed" ? result.reason : undefined,
      });
      // Any check that ran restarts the count to the next load check.
      resetLoadCount();
      setState((current) => recordCheck(current, Date.now(), result.kind !== "failed"));
      if (result.kind === "offer") {
        setOffer(result.offer);
        setStatus("idle");
        if (shouldAnnounce(result.offer, stateRef.current) && !manual) {
          setAnnouncement({
            at: Date.now(),
            text: offerText(result.offer),
            button: offerButton(result.offer),
          });
        }
      } else if (result.kind === "current") {
        setOffer(null);
        setLatest(result.latest);
        setStatus("current");
      } else {
        setStatus("failed");
        if (manual) setMessage(`Couldn't check for updates: ${result.reason}.`);
      }
    },
    [runtime, setState, resetLoadCount],
  );

  // The automatic schedule: due now, or a timer for when it will be.
  useEffect(() => {
    if (!runtime || !state.auto || !online || automated()) return;
    const now = Date.now();
    if (checkDue(state, now, online)) {
      void runCheck(false);
      return;
    }
    const timer = globalThis.setTimeout(() => void runCheck(false), msUntilDue(state, now) + 1000);
    return () => globalThis.clearTimeout(timer);
  }, [runtime, state, online, runCheck]);

  // Every tenth load: the same background check, never in the way of the launch.
  useEffect(() => {
    if (loadCount === null) return;
    const due = loadCheckDue({
      runtime,
      count: loadCount,
      auto: state.auto,
      online,
      automated: automated() && !loadCheckOptIn(),
      inFlight: checking.current,
    });
    if (due) void runCheck(false);
  }, [runtime, loadCount, state.auto, online, runCheck]);

  // The announcement goes by itself, and that counts as seen.
  useEffect(() => {
    if (!announcement || !offer) return;
    const version = offer.version;
    const timer = globalThis.setTimeout(() => {
      setAnnouncement(null);
      setState((current) => dismiss(current, version));
    }, ANNOUNCE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [announcement, offer, setState]);

  const dismissAnnouncement = useCallback(() => {
    setAnnouncement(null);
    if (offer) setState((current) => dismiss(current, offer.version));
  }, [offer, setState]);

  const say = useCallback(
    (text: string) => {
      setMessage(text);
      flash(text, RESULT_MS);
    },
    [flash],
  );

  const install = useCallback(() => {
    if (!offer || status === "installing") return;
    setAnnouncement(null);
    setState((current) => dismiss(current, offer.version));
    const openPage = () => void platform.openExternal(offer.pageUrl).catch(() => undefined);
    const action = offer.action;
    if (action.kind === "git-pull" || action.kind === "docker") return;
    if (action.kind === "page" || !platform.installUpdate) {
      openPage();
      return;
    }
    setStatus("installing");
    setMessage(null);
    flash(`Downloading Winnow ${offer.version}…`, 120_000);
    platform
      .installUpdate(offer)
      .then((outcome) => {
        debugLog("updates", "install", { version: offer.version, outcome: outcome.kind });
        setStatus("idle");
        switch (outcome.kind) {
          case "restarting":
            say(`Restarting into Winnow ${offer.version}…`);
            break;
          case "opened":
            if (outcome.path) {
              say(`Saved to ${outcome.path}. If no installer opened, run: sudo apt install ${outcome.path}`);
            } else {
              say("Android's installer is open. Confirm there to update.");
            }
            break;
          case "needs-permission":
            say("Allow Winnow to install apps in the page that opened, then press Update again.");
            break;
          case "none":
            openPage();
            say(`Opened the Winnow ${offer.version} release page to download it.`);
            break;
        }
      })
      .catch((error: unknown) => {
        setStatus("failed");
        const reason = error instanceof Error ? error.message : String(error);
        debugLog("updates", "install-failed", { version: offer.version, reason });
        say(`Couldn't update: ${reason}`);
      });
  }, [offer, status, platform, flash, say, setState]);

  const setAuto = useCallback(
    (value: boolean) => setState((current) => ({ ...current, auto: value })),
    [setState],
  );

  const checkNow = useCallback(() => {
    // A press is a check: the count starts again now, and again when it settles.
    resetLoadCount();
    void runCheck(true);
  }, [runCheck, resetLoadCount]);

  const openWhatsNew = useCallback(() => {
    if (!offer) return;
    // Opening the notes from the pill is acting on it: the pill goes, and stays gone.
    setAnnouncement(null);
    setState((current) => dismiss(current, offer.version));
    const key = `${offer.current}→${offer.version}`;
    if (changelogCache.current?.key === key) {
      setWhatsNew({ status: "ok", entries: changelogCache.current.entries });
      return;
    }
    setWhatsNew({ status: "loading" });
    void fetchChangelog(offer.current, offer.version, (url, init) => globalThis.fetch(url, init), undefined, {
      includePrereleases: offer.beta === true,
    }).then((result) => {
      if (result.kind === "ok") {
        changelogCache.current = { key, entries: result.entries };
        setWhatsNew((open) => (open ? { status: "ok", entries: result.entries } : open));
      } else {
        setWhatsNew((open) => (open ? { status: "failed", reason: result.reason } : open));
      }
    });
  }, [offer, setState]);

  const closeWhatsNew = useCallback(() => setWhatsNew(null), []);

  return {
    runtime,
    auto: state.auto,
    setAuto,
    offer,
    latest,
    status,
    message,
    announcement,
    checkNow,
    install,
    dismissAnnouncement,
    whatsNew,
    openWhatsNew,
    closeWhatsNew,
  };
}
