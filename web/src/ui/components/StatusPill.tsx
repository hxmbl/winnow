/**
 * The status pill (the rules are `statusPill.ts`).
 *
 * The same frosted pill as a pull to refresh's "Synced just now" (`.wn-glass`,
 * `.wn-glass-bar`, full round, meta weight; Liquid Glass, `.wn-liquid`, since 1.4), at the same place: centred over the list,
 * just under its top chrome — the phone's top bar or the desktop's floating list
 * header. When the list is not on screen (a phone reading a message, or a narrow
 * window with the reader over the list) it centres on the window under the safe area
 * instead. Up top, it never meets the phone's dock, its chips or the gesture bar.
 *
 * Fixed rather than in the layout, so a notice never pushes the mail down the way the
 * old strips did. It holds one notice at a time, newest first, and its buttons act on
 * that notice alone. After a notice it says the sync status for a beat, then goes.
 *
 * Accessibility: one polite live region, always mounted, says each notice once (not
 * every tick of a countdown) and that Undo is there; the pill itself is ordinary
 * buttons in reading order. Reduced motion: the global rule makes the entrance instant.
 *
 * The sync indicator rides in the same row (`SyncIndicator.tsx`): a small disc beside
 * the pill on its right, or where the pill rests when there is no pill. It replaced the
 * "Syncing 1 change…" bar that pushed the whole app down; like the pill it takes no room.
 *
 * Leaving: when nothing is left to say, the last pill stays for `LEAVE_MS` as a ghost
 * (no buttons to hit, out of the accessibility tree) while it fades out, so it eases
 * away instead of blinking off. A new notice during the fade replaces it at once.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { BADGE_GAP, BADGE_SIZE, badgePlacement } from "../syncIndicator";
import type { SyncIndicatorState } from "../useSyncIndicator";
import { SyncAnnouncer, SyncDisc } from "./SyncIndicator";
import {
  SYNC_RETURN_MS,
  currentNotice,
  noticeKey,
  pillAnnouncement,
  pillClock,
  pillText,
  pillTop,
  returnsToSync,
  type PillNotice,
} from "../statusPill";
import { Icon } from "./Icon";

type Props = {
  /** The send in its undo window, if any. */
  sending: { deadline: number; at: number } | null;
  /** The store's undo offer. */
  undo: { label: string; at: number } | null;
  /** The store's flash. */
  flash: { text: string; at: number } | null;
  /** A newer Winnow, while its announcement shows (`useUpdates.ts`). */
  update?: { text: string; button: string | null; at: number } | null;
  /** An install under way, its words following the stage (`useUpdates().progress`). */
  updating?: { text: string; announcement: string; at: number } | null;
  onUpdate?: () => void;
  onDismissUpdate?: () => void;
  /** Open the release notes for the update ("What's new"). */
  onWhatsNew?: () => void;
  /** A pull to refresh's result, while it shows. */
  pull: { text: string; ok: boolean; at: number } | null;
  /** The sync status line and whether it is bad news, for the beat after a notice. */
  syncLine: string;
  syncOk: boolean;
  onUndo: () => void;
  onDismissUndo: () => void;
  onUndoSend: () => void;
  onSendNow: () => void;
  onDismissFlash: () => void;
  /**
   * The list's pane: the pill centres over it, under `inset`. The element itself, not a
   * ref: this component sits before the list in the tree, so its layout effect runs
   * before the list's ref is attached. With a ref it found nothing whenever it mounted
   * again with the same `inset` (back from the sign-in or "Couldn't reach Gmail"
   * screen), and fell back to the top of the window, over the phone's top bar.
   */
  anchor: HTMLElement | null;
  /** The height of the chrome over the list's top (top bar or floating header), px. */
  inset: number;
  /**
   * A selector for something the pill must never cover: the phone demo strip, whose
   * Connect Gmail button sat right where the pill rests. While it is on screen under the
   * pill's place the pill drops below it, following it as the list scrolls.
   */
  avoid?: string;
  /** The sync indicator to show beside the pill, or in its place (`useSyncIndicator`). */
  sync?: SyncIndicatorState;
};

/** How long the pill takes to fade out, ms (`animate-vanish`): quick, like its entrance. */
export const LEAVE_MS = 140;

/** The gap between the chrome and the pill, px: where a pull's result rests. */
const GAP = 16;

type Place = { left: number; width: number; top: number } | null;

/** Where the list's pane is on screen (and the pill's top in it), or `null` while hidden. */
function useAnchor(element: HTMLElement | null, inset: number, avoid: string | undefined, active: boolean): Place {
  const [place, setPlace] = useState<Place>(null);
  useLayoutEffect(() => {
    const read = () => {
      const rect = element?.getBoundingClientRect();
      const avoided = avoid && element ? document.querySelector(avoid)?.getBoundingClientRect() : undefined;
      const next =
        rect && rect.width > 0 && rect.height > 0
          ? {
              left: rect.left,
              width: rect.width,
              top: pillTop(
                rect.top + inset + GAP,
                avoided && avoided.height > 0 ? { top: avoided.top, bottom: avoided.bottom } : null,
              ),
            }
          : null;
      setPlace((current) =>
        current?.left === next?.left && current?.width === next?.width && current?.top === next?.top ? current : next,
      );
    };
    read();
    const observer = typeof ResizeObserver === "undefined" || !element ? null : new ResizeObserver(read);
    if (element) observer?.observe(element);
    window.addEventListener("resize", read);
    // The strip to avoid scrolls with the list: follow it while a notice shows.
    const follow = Boolean(avoid) && active;
    if (follow) document.addEventListener("scroll", read, { capture: true, passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", read);
      if (follow) document.removeEventListener("scroll", read, { capture: true });
    };
  }, [element, inset, avoid, active]);
  return place;
}

export function StatusPill(props: Props) {
  const { sending, undo, flash, pull, update, updating } = props;
  const candidates: (PillNotice | null | undefined)[] = [
    sending && { kind: "sending", at: sending.at, deadline: sending.deadline },
    undo && { kind: "undo", at: undo.at, label: undo.label },
    flash && { kind: "flash", at: flash.at, text: flash.text },
    update && { kind: "update", at: update.at, text: update.text, button: update.button },
    updating && { kind: "updating", at: updating.at, text: updating.text, announcement: updating.announcement },
    pull && { kind: "sync", at: pull.at, text: pull.text, ok: pull.ok },
  ];
  const live = currentNotice(candidates);

  // The beat after a notice: the sync status, then nothing.
  const [beat, setBeat] = useState<number | null>(null);
  const previous = useRef<PillNotice | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = live;
    if (live !== null) {
      setBeat(null);
      return;
    }
    if (!returnsToSync(before, live)) return;
    const at = Date.now();
    setBeat(at);
    const timer = window.setTimeout(() => setBeat((current) => (current === at ? null : current)), SYNC_RETURN_MS);
    return () => window.clearTimeout(timer);
    // `live` is rebuilt every render; its identity is its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live === null ? null : noticeKey(live)]);

  const shown: PillNotice | null =
    live ?? (beat === null ? null : { kind: "sync", at: beat, text: props.syncLine, ok: props.syncOk });

  // The countdown ticks only while a send is waiting (`pillClock` keeps a stale tick out).
  const [tick, setNow] = useState(() => Date.now());
  const now = pillClock(tick, shown);
  useEffect(() => {
    if (shown?.kind !== "sending") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [shown?.kind]);

  // The last pill, kept while it fades out (see "Leaving" above).
  const [leaving, setLeaving] = useState<{ notice: PillNotice; now: number } | null>(null);
  const lastShown = useRef<{ notice: PillNotice; now: number } | null>(null);
  if (shown) lastShown.current = { notice: shown, now };
  const shownKey = shown === null ? null : noticeKey(shown);
  useLayoutEffect(() => {
    if (shownKey !== null) {
      setLeaving(null);
      return;
    }
    const last = lastShown.current;
    lastShown.current = null;
    if (!last) return;
    setLeaving(last);
    const timer = window.setTimeout(() => setLeaving((current) => (current === last ? null : current)), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [shownKey]);
  const ghost = shown ? null : leaving;
  const pill = shown ?? ghost?.notice ?? null;
  const pillNow = shown ? now : (ghost?.now ?? now);

  const sync = props.sync ?? { badge: null, leaving: false };
  const disc = sync.badge;
  const place = useAnchor(props.anchor, props.inset, props.avoid, pill !== null || disc !== null);
  const style: React.CSSProperties = place
    ? { left: place.left, width: place.width, top: place.top }
    : { left: 0, right: 0, top: `max(${GAP}px, calc(env(safe-area-inset-top, 0px) + 8px))` };

  return (
    <>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-pill-announce="">
        {pillAnnouncement(live)}
      </p>
      <SyncAnnouncer {...sync} />
      {disc && !pill && (
        <div data-sync-row="" className="pointer-events-none fixed z-35 flex justify-center px-4" style={style}>
          <div className="relative h-10 w-0">
            <SyncDisc badge={disc} leaving={sync.leaving} placement={badgePlacement(false)} />
          </div>
        </div>
      )}
      {pill && (
        <div
          {...(ghost
            ? // A ghost answers to its own name, so nothing that looks for the pill finds it.
              { "data-pill-leaving": pill.kind, "aria-hidden": true, inert: true }
            : { "data-status-pill": pill.kind })}
          className="pointer-events-none fixed z-35 flex justify-center px-4"
          style={style}
        >
          {/* The pill stays centred; the disc hangs off its right edge, room kept for it. */}
          <div
            className="relative flex max-w-full justify-center"
            style={disc ? { maxWidth: `calc(100% - ${2 * (BADGE_SIZE + BADGE_GAP)}px)` } : undefined}
          >
            <div
              key={ghost ? "leaving" : noticeKey(pill)}
              {...(pill.kind === "sending" && !ghost ? { "data-send-pending": "" } : {})}
              className={`wn-glass wn-glass-bar wn-liquid pointer-events-auto flex h-10 max-w-full ${ghost ? "animate-vanish" : "animate-appear"} items-center gap-1 rounded-ctl pl-4 text-meta font-semibold ${
                pill.kind === "sync" || pill.kind === "updating" ? "pr-4" : "pr-1"
              } ${pill.kind === "sync" && !pill.ok ? "text-danger" : "text-ink-body"}`}
            >
              <span
                {...(ghost ? {} : { "data-pill-text": "" })}
                {...(pill.kind === "undo" && !ghost ? { "data-undo-label": "" } : {})}
                className="selectable min-w-0 truncate tabular-nums"
                title={pillText(pill, pillNow)}
              >
                {pillText(pill, pillNow)}
              </span>
              {pill.kind === "undo" && (
                <>
                  <PillButton onClick={props.onUndo} primary data="data-pill-undo">
                    Undo
                  </PillButton>
                  <PillButton onClick={props.onDismissUndo} label="Dismiss" data="data-pill-dismiss">
                    <Icon icon={X} size={16} />
                  </PillButton>
                </>
              )}
              {pill.kind === "sending" && (
                <>
                  <PillButton onClick={props.onUndoSend} primary data="data-send-undo">
                    Undo
                  </PillButton>
                  <PillButton onClick={props.onSendNow} data="data-send-now">
                    Send now
                  </PillButton>
                </>
              )}
              {pill.kind === "update" && (
                <>
                  {props.onWhatsNew && (
                    <PillButton onClick={props.onWhatsNew} data="data-pill-whats-new">
                      What's new
                    </PillButton>
                  )}
                  {pill.button && props.onUpdate && (
                    <PillButton onClick={props.onUpdate} primary data="data-pill-update">
                      {pill.button}
                    </PillButton>
                  )}
                  <PillButton onClick={props.onDismissUpdate ?? (() => undefined)} label="Dismiss" data="data-pill-dismiss">
                    <Icon icon={X} size={16} />
                  </PillButton>
                </>
              )}
              {pill.kind === "flash" && (
                <PillButton onClick={props.onDismissFlash} label="Dismiss" data="data-pill-dismiss">
                  <Icon icon={X} size={16} />
                </PillButton>
              )}
            </div>
            {disc && <SyncDisc badge={disc} leaving={sync.leaving} placement={badgePlacement(true)} />}
          </div>
        </div>
      )}
    </>
  );
}

function PillButton({
  onClick,
  primary = false,
  label,
  data,
  children,
}: {
  onClick: () => void;
  primary?: boolean;
  label?: string;
  data: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      {...{ [data]: "" }}
      className={`flex h-8 min-w-8 shrink-0 items-center justify-center rounded-ctl px-2.5 font-semibold transition-colors hover:bg-sheen focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
        primary ? "text-accent" : "text-ink-subtle hover:text-ink"
      } ${label ? "px-0" : ""}`}
    >
      {children}
    </button>
  );
}
