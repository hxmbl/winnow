/**
 * The reader.
 *
 * The body renders as sanitised markup inline (`MessageBody`, via
 * `core/mail/sanitize.ts`) rather than as text; the untouched original is still offered
 * in a sandboxed frame as "As sent". Remote content stays blocked by default, and the
 * badges come from the same predicates as the filters, so an "Important" chip and the
 * Important pill always agree.
 */

import { QUIET_BUTTON } from "../quietButton";
import { PositionReadout } from "./Masthead";
import { useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ChevronLeft,
  Ban,
  Check,
  CornerUpLeft,
  Eye,
  EyeOff,
  Forward,
  ImageOff,
  Mail,
  MailMinus,
  MailOpen,
  MoreHorizontal,
  ReplyAll,
  RotateCcw,
  Star,
  ListFilter,
  Trash2,
  Undo2,
  X,
  FileCode2,
} from "lucide-react";
import { shortcutHint } from "../../core/mail/keybinds";
import { formatFullTime, formatRelative } from "../../core/mail/datetime";
import { countRemoteReferences } from "../../core/mail/html";
import { displayAddress, displayName, recipientLines, type Email } from "../../core/model/email";
import { Avatar } from "./Avatar";
import {
  badgeFilters,
  type BuiltinSmartFilter,
  type EmailSignals,
} from "../../core/model/signals";
import { filterIcon } from "../filterIcons";
import { MessageBody, type BodyView } from "./MessageBody";
import type { DarkPalette } from "../../core/mail/emailDark";
import { bodyViewOptions } from "../bodyViews";
import { platform } from "../../platform";
import { ariaKey, readerActions, type ReaderAction, type ReaderActionId } from "../readerActions";

/**
 * The first thing someone said, on one line.
 *
 * Used to distinguish messages that share a subject; quote markers are stripped first,
 * so a reply leads with the reply rather than the quoted text.
 */
function firstLine(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^[\s>]+/, "").trim();
    if (line) return line;
  }
  return "";
}
import { AttachmentList, type LoadedAttachment } from "./AttachmentList";
import type { Mailbox } from "../../core/model/email";
import { PILL_START, pillAfterScroll, pillOpened, pillOrder, type ReaderPillAction } from "../readerPill";
import { PillSwipe, type StepDelta, type StepReach } from "../readerSwipe";
import { AppMark } from "../AppMark";

/**
 * A smart filter that applies to the open message.
 *
 * Icon and word, never colour alone. The `title` is the explanation from
 * `ui/filterIcons`, so hovering says *why* Winnow thinks this.
 */
function FilterTag({ id }: { id: BuiltinSmartFilter }) {
  const { Icon, label, title } = filterIcon(id);
  return (
    <span
      // `data-filter-tag` so tests can find these by what they *are*, not by `title`.
      data-filter-tag={id}
      className="inline-flex items-center gap-1 text-meta font-medium text-ink-muted"
      title={title}
    >
      <Icon size={12} strokeWidth={2} className="shrink-0 text-ink-subtle" aria-hidden="true" />
      {label}
      <span className="sr-only"> — {title}</span>
    </span>
  );
}

/** The action row. Which verbs appear depends on the mailbox. */
type Actions = {
  onStar: () => void;
  onRead: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onReply: () => void;
  onForward: () => void;
  /** Mark the current message not-spam. Only offered in the spam folder. */
  onNotSpam: () => void;
  /** Open the snooze choices beside `trigger`. Absent where snoozing means nothing. */
  onSnooze?: (trigger: HTMLElement) => void;
  onShowOriginal: () => void;
  onBlockSender: () => void;
  /** Unsubscribe as the List-Unsubscribe header says. Absent when the mail has none. */
  onUnsubscribe?: () => void;
  /** Open "Change smart filters…" for this message. Absent outside the inbox. */
  onChangeFilters?: () => void;
  /** Dev Options → View Original: the raw source. Absent unless that switch is on. */
  onViewOriginal?: () => void;
  /** Turn image loading on for this message only. */
  onLoadRemoteContent: () => void;
  /** Load images from now on, for every message. */
  onAlwaysLoadRemoteContent: () => void;
  /**
   * Stop being asked — load images for nobody, silently, from now on.
   *
   * Not the same as declining *this* message; a boolean could not express it.
   */
  onNeverLoadRemoteContent: () => void;
  /** Open another message in the conversation. */
  onOpenMessage: (id: number) => void;
  onSaveAttachment: (attachment: { filename: string; mimeType: string; size: number; index: number }) => void;
  /** The bytes of the open message's attachment at `index`, for a thumbnail. */
  onLoadAttachment: (index: number) => Promise<LoadedAttachment>;
  /** Show the open message's attachment at `index` (a PDF) in a viewer. */
  onOpenAttachment: (index: number) => void;
};


/**
 * One button of the action bar: icon, its word when the pane has room (a container
 * query in `index.css` hides `.wn-action-text` in a narrow pane, so nothing shifts as
 * messages change), and a tooltip with the key that does the same thing. The tooltip
 * is drawn by CSS on hover and keyboard focus after a short delay, faster than a native
 * `title`, and never takes layout space.
 */
function ActionButton({ action, onClick, children, tipStart = false }: { action: ReaderAction; onClick: (trigger: HTMLElement) => void; children: React.ReactNode; tipStart?: boolean }) {
  const key = ariaKey(action.keys);
  return (
    <button
      type="button"
      onClick={(event) => onClick(event.currentTarget)}
      aria-haspopup={action.id === "snooze" ? "menu" : undefined}
      aria-label={action.label}
      aria-pressed={action.pressed ?? undefined}
      aria-keyshortcuts={key ?? undefined}
      data-reader-action={action.id}
      className={`wn-action group/action relative flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-ctl text-ui font-medium transition-[background-color,color,transform] duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-[0.96] motion-reduce:active:scale-100 ${
        action.primary
          ? "bg-accent px-2.5 text-on-accent hover:opacity-90"
          : action.text
            ? "px-2 text-ink-body hover:bg-surface-hover hover:text-ink"
            : "px-0 text-ink-icon hover:bg-surface-hover hover:text-ink"
      } ${action.pressed ? "text-(--wn-badge-starred)" : ""}`}
    >
      {children}
      {action.text && <span className="wn-action-text whitespace-nowrap">{action.text}</span>}
      <span aria-hidden="true" className="wn-tip" data-tip={tipStart ? "start" : ""}>
        {action.label}
        {action.keys && <kbd className="wn-tip-key">{action.keys}</kbd>}
      </span>
    </button>
  );
}

/**
 * The reader's action bar, on the desktop and at medium widths.
 *
 * Its own row at the very top of the reader, left-aligned, the same for every message
 * (see `readerActions.ts` for the order and why). Below `lg`, where the reader replaces
 * the list, it leads with the sidebar toggle and Close, so there is one bar, not two.
 */
function ActionBar({ starred, unread, mailbox, actions, view, onViewChange, hasHtml, senderName, onClose, sidebarOpen, onToggleSidebar }: {
  starred: boolean;
  unread: boolean;
  mailbox: Mailbox;
  actions: Actions;
  view: BodyView;
  onViewChange: (next: BodyView) => void;
  hasHtml: boolean;
  senderName: string;
  onClose: () => void;
  sidebarOpen: boolean;
  onToggleSidebar?: () => void;
}) {
  const list = readerActions(mailbox, { starred, unread }).filter((action) => action.id !== "snooze" || actions.onSnooze);
  const run: Record<ReaderActionId, (trigger: HTMLElement) => void> = {
    reply: actions.onReply,
    forward: actions.onForward,
    archive: actions.onArchive,
    snooze: (trigger) => actions.onSnooze?.(trigger),
    notSpam: actions.onNotSpam,
    trash: actions.onTrash,
    read: actions.onRead,
    star: actions.onStar,
  };
  const ICON = { size: 16, strokeWidth: 1.9, "aria-hidden": true } as const;
  const icon = (action: ReaderAction) => {
    switch (action.id) {
      case "reply":
        return <ReplyAll {...ICON} />;
      case "forward":
        return <Forward {...ICON} />;
      case "archive":
        return mailbox === "inbox" ? <Archive {...ICON} /> : mailbox === "snoozed" ? <AlarmClockOff {...ICON} /> : <RotateCcw {...ICON} />;
      case "notSpam":
        return <Undo2 {...ICON} />;
      case "snooze":
        return <AlarmClock {...ICON} />;
      case "trash":
        return <Trash2 {...ICON} />;
      case "read":
        return unread ? <MailOpen {...ICON} /> : <Mail {...ICON} />;
      case "star":
        return <Star {...ICON} fill={starred ? "currentColor" : "none"} />;
    }
  };
  return (
    <div
      data-reader-actions=""
      role="toolbar"
      aria-label="Message actions"
      // From lg the list's floating masthead sits beside this bar: a 52px glass pill 10px
      // from the top (`Masthead`), so its centre line is 36px down. Matching its box
      // (10px top inset + 52px) puts these buttons on the same line instead of 12px
      // higher. Below lg the reader has the window to itself, so the plain 48px bar stays.
      className="wn-reader-actions flex h-12 shrink-0 items-center gap-1 px-3 lg:box-content lg:h-[52px] lg:pt-2.5"
    >
      {onToggleSidebar && (
        <button
          type="button"
          data-sidebar-toggle=""
          data-reader-sidebar-toggle=""
          onClick={onToggleSidebar}
          aria-expanded={sidebarOpen}
          aria-controls="winnow-sidebar"
          aria-haspopup="dialog"
          aria-label="Open sidebar"
          title={shortcutHint("Sidebar", "toggleSidebar")}
          aria-keyshortcuts="["
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl transition-colors hover:bg-surface-hover active:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring lg:hidden"
        >
          <AppMark size={26} />
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label="Back to the list"
        aria-keyshortcuts="Escape"
        className="wn-action relative flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring lg:hidden"
      >
        <X size={16} strokeWidth={2} aria-hidden="true" />
        <span aria-hidden="true" className="wn-tip" data-tip="start">
          Back to the list<kbd className="wn-tip-key">Esc</kbd>
        </span>
      </button>
      {onToggleSidebar && <span className="mx-1 h-4 w-px shrink-0 bg-divider lg:hidden" aria-hidden="true" />}
      {list.map((action, index) => (
        <span key={action.id} className="contents">
          {index > 0 && list[index - 1]!.group !== action.group && (
            <span className="mx-1 h-4 w-px shrink-0 bg-divider" aria-hidden="true" />
          )}
          <ActionButton action={action} onClick={run[action.id]} tipStart={index === 0}>
            {icon(action)}
          </ActionButton>
        </span>
      ))}
      <div className="ml-auto">
        <MoreMenu
          view={view}
          onViewChange={onViewChange}
          hasHtml={hasHtml}
          senderName={senderName}
          onBlockSender={actions.onBlockSender}
          onUnsubscribe={actions.onUnsubscribe}
          onChangeFilters={actions.onChangeFilters}
          onViewOriginal={actions.onViewOriginal}
          buttonClass="flex h-8 w-8 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
      </div>
    </div>
  );
}

/**
 * The toolbar's overflow: the controls a reader reaches for rarely.
 *
 * "Show as" was a segmented switch above every body and "Hide everything from…" a
 * footer under every message; both were on screen for every message and used for almost
 * none. Here they cost one icon. Closes on a choice, an outside click, or Escape, and
 * hands focus back to its button so the keyboard is not stranded.
 */
function MoreMenu({ view, onViewChange, hasHtml, senderName, onBlockSender, onUnsubscribe, onChangeFilters, onViewOriginal, buttonClass, phone, buttonContent }: {
  view: BodyView;
  onViewChange: (next: BodyView) => void;
  hasHtml: boolean;
  senderName: string;
  onBlockSender: () => void;
  onUnsubscribe?: () => void;
  onChangeFilters?: () => void;
  onViewOriginal?: () => void;
  buttonClass: string;
  /**
   * The phone reader's version: the menu opens *upward* from the action bar, its rows
   * are touch height, and it leads with star and read, which the bar has no room for.
   */
  phone?: { starred: boolean; unread: boolean; onStar: () => void; onRead: () => void; leftHanded?: boolean };
  /** What the trigger shows. The icon alone unless the phone bar labels it. */
  buttonContent?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape closes the menu, not the reader behind it.
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const choose = (run: () => void) => {
    setOpen(false);
    run();
    buttonRef.current?.focus();
  };

  const ITEM = phone
    ? "flex min-h-11 w-full items-center gap-2.5 rounded-ctl px-3 text-left text-ui font-medium text-ink-body transition-colors active:bg-sheen focus-visible:bg-sheen focus-visible:outline-hidden"
    : "flex w-full items-center gap-2 rounded-ctl px-2.5 py-1.5 text-left text-meta font-medium text-ink-body transition-colors hover:bg-sheen focus-visible:bg-sheen focus-visible:outline-hidden";
  const iconSize = phone ? 16 : 13;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        onClick={() => setOpen((was) => !was)}
        className={buttonClass}
      >
        {buttonContent ?? <MoreHorizontal size={15} strokeWidth={1.9} />}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="More actions"
          className={
            phone
              ? // Above the floating action pill, on the thumb's side. Fixed rather than
                // absolute: the pill clips its own contents while it folds.
                `fixed bottom-[calc(var(--wn-dock-bottom)+var(--wn-dock-h)+0.5rem)] z-40 w-[min(18rem,calc(100vw-1.5rem))] rounded-pane border border-hairline bg-chrome p-1.5 shadow-lift ${
                  phone.leftHanded ? "left-(--wn-dock-left)" : "right-(--wn-dock-right)"
                }`
              : "absolute right-0 top-8 z-30 w-60 rounded-pane border border-hairline bg-surface p-1 shadow-pane"
          }
        >
          {phone && (
            <>
              <button
                type="button"
                role="menuitem"
                aria-pressed={phone.starred}
                onClick={() => choose(phone.onStar)}
                className={ITEM}
              >
                <Star
                  size={iconSize}
                  strokeWidth={1.9}
                  aria-hidden="true"
                  fill={phone.starred ? "currentColor" : "none"}
                  className={phone.starred ? "text-(--wn-badge-starred)" : "text-ink-muted"}
                />
                <span className="flex-1">{phone.starred ? "Unstar" : "Star"}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => choose(phone.onRead)} className={ITEM}>
                {phone.unread ? (
                  <Mail size={iconSize} strokeWidth={1.9} aria-hidden="true" className="text-ink-muted" />
                ) : (
                  <MailOpen size={iconSize} strokeWidth={1.9} aria-hidden="true" className="text-ink-muted" />
                )}
                <span className="flex-1">{phone.unread ? "Mark read" : "Mark unread"}</span>
              </button>
              <div className="my-1 h-px bg-divider" aria-hidden="true" />
            </>
          )}
          <p className="px-2.5 pb-1 pt-1.5 text-meta font-semibold text-ink-subtle">
            Show as
          </p>
          {bodyViewOptions(hasHtml).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={view === id}
              onClick={() => choose(() => onViewChange(id))}
              className={ITEM}
            >
              <Icon size={iconSize} strokeWidth={1.9} aria-hidden="true" className="text-ink-muted" />
              <span className="flex-1">{label}</span>
              {view === id && <Check size={iconSize} strokeWidth={2.2} aria-hidden="true" />}
            </button>
          ))}
          {onViewOriginal && (
            <button type="button" role="menuitem" data-reader-view-original="" onClick={() => choose(onViewOriginal)} className={ITEM}>
              <FileCode2 size={iconSize} strokeWidth={1.9} aria-hidden="true" className="text-ink-muted" />
              <span className="flex-1">View Original</span>
            </button>
          )}
          <div className="my-1 h-px bg-divider" aria-hidden="true" />
          {onChangeFilters && (
            <button type="button" role="menuitem" data-reader-change-filters="" onClick={() => choose(onChangeFilters)} className={ITEM}>
              <ListFilter size={iconSize} strokeWidth={1.9} aria-hidden="true" className="text-ink-muted" />
              <span className="flex-1">Change smart filters…</span>
            </button>
          )}
          {onUnsubscribe && (
            <button type="button" role="menuitem" data-reader-unsubscribe="" onClick={() => choose(onUnsubscribe)} className={ITEM}>
              <MailMinus size={iconSize} strokeWidth={1.9} aria-hidden="true" className="text-ink-muted" />
              <span className="min-w-0 flex-1 truncate">Unsubscribe from {senderName}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onBlockSender)}
            title="Everything from this sender disappears from every folder. Bring it back in Settings."
            className={`${ITEM} hover:bg-danger-wash hover:text-danger`}
          >
            <Ban size={iconSize} strokeWidth={1.9} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Hide everything from {senderName}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The pill's sideways swipe (STRM-324): left steps to the next message, right to the
 * previous, by the same step as the masthead's arrows (`readerSwipe.ts` decides; this
 * draws). The pill follows the finger a little and springs back on release; under
 * reduced motion it stays put. Once a press has become a swipe, the click it would end
 * in is swallowed, so letting go over Archive never archives. A haptic tick marks a step.
 */
function usePillSwipe(reach: StepReach | undefined, onStep: ((step: StepDelta) => void) | undefined) {
  const dockRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<{ id: number; swipe: PillSwipe } | null>(null);
  /** Set once a press became a swipe; the click that ends it is swallowed. */
  const swallowClick = useRef(false);
  // The latest reach and handler, read at release rather than captured at press.
  const latest = useRef({ reach, onStep });
  latest.current = { reach, onStep };

  const draw = (shift: number, settle: boolean) => {
    const dock = dockRef.current;
    if (!dock) return;
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduce) {
      dock.style.transform = "";
      return;
    }
    dock.style.transition = settle ? "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
    dock.style.transform = shift === 0 ? "" : `translateX(${shift}px)`;
  };

  const end = (pointerId: number, element: HTMLElement) => {
    gesture.current = null;
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    draw(0, true);
  };

  const handlers = onStep
    ? {
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
          swallowClick.current = false;
          if (!event.isPrimary) return;
          gesture.current = {
            id: event.pointerId,
            swipe: new PillSwipe({ x: event.clientX, y: event.clientY, at: event.timeStamp }, latest.current.reach ?? { prev: false, next: false }, {
              screenWidth: window.innerWidth,
              pointer: event,
            }),
          };
        },
        onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
          const current = gesture.current;
          if (!current || current.id !== event.pointerId) return;
          const wasSwiping = current.swipe.swiping;
          const move = current.swipe.move(event.clientX, event.clientY, event.timeStamp);
          if (move.phase === "ignored") {
            gesture.current = null;
            return;
          }
          if (move.phase !== "swiping") return;
          if (!wasSwiping) {
            // From here on the press is a swipe: keep its moves, and not its click.
            swallowClick.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }
          draw(move.shift, false);
        },
        onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
          const current = gesture.current;
          if (!current || current.id !== event.pointerId) return;
          current.swipe.move(event.clientX, event.clientY, event.timeStamp);
          const step = current.swipe.release();
          end(event.pointerId, event.currentTarget);
          if (step !== null) {
            navigator.vibrate?.(10);
            latest.current.onStep?.(step);
          }
        },
        onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
          if (gesture.current?.id === event.pointerId) end(event.pointerId, event.currentTarget);
        },
        onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        },
      }
    : {};

  return { dockRef, handlers };
}

/**
 * The phone reader's actions: a floating glass pill under the thumb.
 *
 * Bottom-right (bottom-left when left-handed), clear of the gesture bar, the same frost
 * as the dock and the status pill. Ordered by reach (`readerPill.ts`): Archive, Delete
 * and Reply nearest the thumb, Forward, then More furthest; star and read live in More.
 * Back is the reader's top-left arrow (and Android's back gesture), not a pill slot.
 *
 * While you read down it folds to a single ••• circle that only opens it, and opens
 * again on a scroll up, a tap, or at the end of the message. The fold is a width change
 * with the buttons fading out; under reduced motion it is only the fade.
 */
function ReaderPill({ starred, unread, mailbox, actions, view, onViewChange, hasHtml, senderName, scroller, messageKey, leftHanded, reach, onStep }: {
  starred: boolean;
  unread: boolean;
  mailbox: Mailbox;
  actions: Actions;
  view: BodyView;
  onViewChange: (next: BodyView) => void;
  hasHtml: boolean;
  senderName: string;
  /** The message's scroller, whose direction folds and opens the pill. */
  scroller: React.RefObject<HTMLDivElement | null>;
  /** Changes with the open message: a new message starts with the pill open. */
  messageKey: string | number;
  leftHanded: boolean;
  /** Which ways a sideways swipe on the pill can step (the masthead arrows' `canStep`). */
  reach?: StepReach;
  /** Step to the previous (`-1`) or next (`1`) message. Absent, the pill does not swipe. */
  onStep?: (step: StepDelta) => void;
}) {
  const [scroll, setScroll] = useState(PILL_START);
  const swipe = usePillSwipe(reach, onStep);
  useEffect(() => {
    setScroll(PILL_START);
    const element = scroller.current;
    if (!element) return;
    const onScroll = () =>
      setScroll((state) => pillAfterScroll(state, element.scrollTop, element.scrollHeight - element.clientHeight));
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [scroller, messageKey]);
  const collapsed = scroll.collapsed;

  const inSpam = mailbox === "spam";
  /** Snooze is on the pill only where a message can be snoozed (the pill sizes to it). */
  const snoozable = actions.onSnooze !== undefined && (mailbox === "inbox" || mailbox === "archive" || mailbox === "snoozed");
  const archiveLabel =
    mailbox === "inbox" ? "Archive" : mailbox === "archive" ? "Move to inbox" : mailbox === "snoozed" ? "Unsnooze" : "Restore";
  const trashLabel = mailbox === "trash" ? "Delete permanently" : "Move to trash";

  const BUTTON =
    "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-ink-body transition-colors active:bg-sheen focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring";
  const ICON = { size: 21, strokeWidth: 1.8, "aria-hidden": true } as const;

  const button = (id: ReaderPillAction) => {
    switch (id) {
      case "archive":
        return inSpam ? (
          <button key={id} type="button" onClick={actions.onNotSpam} aria-label="Not spam — move to inbox" title="Not spam" className={BUTTON}>
            <Undo2 {...ICON} />
          </button>
        ) : (
          <button key={id} type="button" onClick={actions.onArchive} aria-label={archiveLabel} title={archiveLabel} className={BUTTON}>
            {mailbox === "inbox" ? <Archive {...ICON} /> : <RotateCcw {...ICON} />}
          </button>
        );
      case "trash":
        // In the Trash this deletes for good: red, and on a phone it asks first (`App.tsx`).
        return (
          <button
            key={id}
            type="button"
            onClick={actions.onTrash}
            aria-label={trashLabel}
            title={trashLabel}
            data-destructive={mailbox === "trash" ? "" : undefined}
            className={`${BUTTON} ${mailbox === "trash" ? "text-danger!" : ""}`}
          >
            <Trash2 {...ICON} />
          </button>
        );
      case "reply":
        return (
          <button key={id} type="button" onClick={actions.onReply} aria-label="Reply to all" title="Reply" className={BUTTON}>
            <CornerUpLeft {...ICON} />
          </button>
        );
      case "snooze":
        if (!snoozable) return null;
        return (
          <button
            key={id}
            type="button"
            data-reader-pill-snooze=""
            aria-haspopup="menu"
            onClick={(event) => actions.onSnooze?.(event.currentTarget)}
            aria-label={mailbox === "snoozed" ? "Change snooze time" : "Snooze"}
            title="Snooze"
            className={BUTTON}
          >
            <AlarmClock {...ICON} />
          </button>
        );
      case "forward":
        return (
          <button key={id} type="button" onClick={actions.onForward} aria-label="Forward" title="Forward" className={BUTTON}>
            <Forward {...ICON} />
          </button>
        );
      case "more":
        return (
          <MoreMenu
            key={id}
            view={view}
            onViewChange={onViewChange}
            hasHtml={hasHtml}
            senderName={senderName}
            onBlockSender={actions.onBlockSender}
            onUnsubscribe={actions.onUnsubscribe}
            onChangeFilters={actions.onChangeFilters}
            onViewOriginal={actions.onViewOriginal}
            buttonClass={BUTTON}
            phone={{ starred, unread, onStar: actions.onStar, onRead: actions.onRead, leftHanded }}
            buttonContent={<MoreHorizontal {...ICON} />}
          />
        );
    }
  };

  return (
    <div
      ref={swipe.dockRef}
      data-reader-dock=""
      data-reader-pill={collapsed ? "collapsed" : "open"}
      data-hand={leftHanded ? "left" : "right"}
      className={`pointer-events-none fixed bottom-(--wn-dock-bottom) z-30 flex ${
        leftHanded ? "left-(--wn-dock-left) justify-start" : "right-(--wn-dock-right) justify-end"
      }`}
    >
      <div
        role="toolbar"
        aria-label="Message actions"
        data-reader-pill-swipe={onStep ? "" : undefined}
        className="wn-glass wn-glass-behind wn-liquid wn-reader-pill pointer-events-auto relative h-(--wn-dock-h) rounded-full"
        style={{ "--wn-pill-count": snoozable ? 6 : 5 } as React.CSSProperties}
        {...swipe.handlers}
      >
        <div
          data-reader-pill-actions=""
          inert={collapsed}
          className={`wn-reader-pill-actions absolute inset-y-0 flex items-center gap-0.5 px-1.5 ${leftHanded ? "left-0" : "right-0"}`}
        >
          {pillOrder(leftHanded).map(button)}
        </div>
        <button
          type="button"
          data-reader-pill-handle=""
          aria-label="Show message actions"
          aria-expanded={!collapsed}
          tabIndex={collapsed ? undefined : -1}
          aria-hidden={collapsed ? undefined : true}
          onClick={() => setScroll(pillOpened)}
          className={`wn-reader-pill-handle absolute inset-y-0 flex w-(--wn-dock-h) items-center justify-center rounded-full text-ink-body focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
            leftHanded ? "left-0" : "right-0"
          }`}
        >
          <MoreHorizontal size={22} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

type Props = {
  /**
   * A `mailto:` link in the message, which opens Winnow's own composer rather than
   * whatever the OS calls its mail client. Absent, the link goes to the OS like any other.
   */
  onMailto?: (url: string) => void;
  /** Left-handed phone layout: the action pill sits bottom-left. */
  leftHanded?: boolean;
  /** Email dark mode's palette for the body, or null for the sender's light page. See `MessageBody`. */
  emailDark?: DarkPalette | null;
  /** Dev Options → Pure Plain Text: the Plain text form shows the text exactly as sent. See `MessageBody`. */
  purePlainText?: boolean;
  email: Email | null;
  conversation: readonly Email[];
  signals: EmailSignals | null;
  mailbox: Mailbox;
  /**
   * Whether *this* message's images are showing.
   *
   * Resolved by `App.tsx` from the global policy and the per-message override, so the
   * reader never has to know which is in force.
   */
  imagesAllowed: boolean;
  /** Whether to offer the choice at all. `false` once the user has answered for good. */
  askAboutImages: boolean;
  accountAddress: string | null;
  /**
   * The reference instant for relative timestamps in this pane.
   *
   * Passed in rather than read from the clock, so the demo's fixed instant governs the
   * demo's timestamps and the reader cannot disagree with the list beside it.
   */
  now: number;
  onClose: () => void;
  actions: Actions;
  /** Scroll the reader by whole steps, for the arrow keys. */
  scrollStep: number;
  /**
   * True when this message's HTML body has not arrived yet.
   *
   * A separate prop rather than inferred from `email.bodyHtml` being absent, because
   * absent means either "not fetched yet" or "plain text that will never have one".
   */
  bodyPending: boolean;
  /** Ask for the HTML body of the open message. */
  onLoadBody: () => void;
  /**
   * The phone layout: the actions and the way back move to a bar at the bottom edge, and
   * the header keeps only who and when.
   */
  phone?: boolean;
  /** The sender's contact photo, when known. */
  senderPhoto?: string;
  /** Open the sender menu from the header's avatar. */
  onSenderMenu?: (trigger: HTMLElement) => void;
  /** The one-time code strip, drawn at the very top, above the sender. */
  codeBar?: React.ReactNode;
  /**
   * "Why it's here" (`WhyHere`): at the bottom of the email, grouped with the
   * "Not where it belongs?" footer (1.3.3), not up under the sender.
   */
  whyHere?: React.ReactNode;
  /**
   * The sidebar's toggle, for the medium-width layout (640–1023px) where the reader
   * replaces the list and so hides the masthead's toggle with it. Without this the
   * folders and the account could not be reached while a message was open.
   */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  /** Phone: which ways a swipe on the action pill can step (the arrows' `canStep`). */
  stepReach?: StepReach;
  /** Phone: step to the previous (`-1`) or next (`1`) message, from a swipe on the pill. */
  onStep?: (step: StepDelta) => void;
  /**
   * Phone: where the open message sits in the list it was opened from ("3 of 120"),
   * top right of the header, as the desktop masthead shows it. The list is the mailbox
   * being read, narrowed by any smart filter or search, so N and M always agree. `position` is null
   * when the message is not in that list (the total alone is shown then).
   */
  listPosition?: { position: number | null; total: number };
};

export function Reader({
  email,
  conversation,
  signals,
  mailbox,
  imagesAllowed,
  askAboutImages,
  accountAddress,
  now,
  onClose,
  actions,
  scrollStep,
  bodyPending,
  onLoadBody,
  phone = false,
  senderPhoto,
  onSenderMenu,
  listPosition,
  codeBar = null,
  whyHere = null,
  sidebarOpen = false,
  onToggleSidebar,
  onMailto,
  leftHanded = false,
  emailDark = null,
  purePlainText = false,
  stepReach,
  onStep,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * Ask for the HTML body when this message does not have one.
   *
   * Keyed on the message id, so holding `j` down the list walks through the fetches
   * rather than re-asking for the first one.
   */
  const emailId = email?.id ?? null;
  const hasHtml = email?.bodyHtml !== undefined;

  // The body's form, per message: back to the default when the selection moves, so a
  // message you read as text is not the reason the next one is.
  const [view, setView] = useState<BodyView>("rich");
  useEffect(() => {
    setView("rich");
  }, [emailId]);

  useEffect(() => {
    if (emailId !== null && !hasHtml) onLoadBody();
  }, [emailId, hasHtml, onLoadBody]);

  // The arrow keys scroll the reader rather than moving the list. A discrete
  // step per keypress, applied as an effect, so holding the key down scrolls
  // repeatedly — which is what a key repeat is *for*.
  useEffect(() => {
    if (scrollStep === 0 || !bodyRef.current) return;
    bodyRef.current.scrollBy({ top: scrollStep * 120, behavior: "auto" });
  }, [scrollStep]);

  if (!email) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <MailOpen size={24} strokeWidth={1.5} className="text-ink-subtle" aria-hidden="true" />
        <p className="text-ui font-medium text-ink-body">Nothing selected</p>
        <p className="max-w-[24rem] text-meta text-ink-subtle">
          Pick something from the list, or press{" "}
          <kbd className="rounded-ctl bg-sheen px-1.5 font-mono text-ink-muted">j</kbd>.
        </p>
      </div>
    );
  }

  const filters = signals ? badgeFilters(email, signals) : [];
  const blocked = email.bodyHtml ? countRemoteReferences(email.bodyHtml) : 0;
  const isOwnMessage = accountAddress !== null && email.sender === accountAddress;
  const others = conversation.filter((m) => m.gmailId !== email.gmailId);
  /**
   * The offer, and only when there is something to decide.
   *
   * `blocked > 0` because a message with no remote references has no trade-off to put
   * to anybody. `askAboutImages` because "never ask again" has to mean never.
   */
  const offerImages = email.bodyHtml !== undefined && blocked > 0 && !imagesAllowed && askAboutImages;

  return (
    // `data-reader` so a test can reach the pane as a whole — the header's `<time>`
    // lives outside `<article>`, so "which message is open" cannot be answered from
    // the article alone.
    <div data-reader="" data-reader-message={email.id} data-select-scope="" className="flex min-h-0 flex-1 flex-col">
      {/* The action bar: its own row, at the top, the same place for every message. On a
          phone the actions are the dock at the bottom instead. */}
      {!phone && (
        <ActionBar
          starred={email.starred}
          unread={email.unread}
          mailbox={mailbox}
          actions={actions}
          view={view}
          onViewChange={setView}
          hasHtml={Boolean(email.bodyHtml)}
          senderName={displayName(email)}
          onClose={onClose}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={onToggleSidebar}
        />
      )}

      {codeBar}

      {/*
        The header.

        No rule under it: a `border-b` drew a hard line across the pane that the flat
        layout does not otherwise have, so the separation is the padding below and the
        change in type size.
      */}
      <div className={`flex items-start gap-3 px-5 pb-4 ${phone && !codeBar ? "pt-[max(1rem,env(safe-area-inset-top))]" : "pt-4"}`}>
        {/*
          The sender's avatar — their photo, or the list's quiet monogram — and the door
          to the sender menu, as it is in the list. A button of its own; the name beside
          it stays selectable text.
        */}
        {phone && (
          // Back, top-left as on iOS: the action pill no longer carries it, and Android
          // still has its back gesture.
          <button
            type="button"
            data-reader-back=""
            onClick={onClose}
            aria-label="Back to the list"
            className="-ml-3 flex h-11 w-9 shrink-0 items-center justify-center rounded-full text-accent transition-colors active:bg-sheen focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <ChevronLeft size={26} strokeWidth={2.1} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          data-reader-avatar=""
          aria-label={`Sender options for ${displayName(email)}`}
          aria-haspopup="menu"
          onClick={(event) => onSenderMenu?.(event.currentTarget)}
          className="mt-0.5 shrink-0 rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Avatar name={displayName(email)} address={email.sender} photo={senderPhoto} size={36} />
        </button>

        <div className="min-w-0 flex-1">
          {/* The sender is the h2 and the subject the h1 — inverted from the usual
              pattern, and deliberately: the subject is the page's title, so it is the
              document's h1 and the sender is subordinate to it. The actions are no longer
              beside the name (they are the bar above), so the name has the whole width. */}
          <div className="min-w-0">
            <h2 data-reader-sender="" className="selectable truncate text-ui font-semibold text-ink">
              {displayName(email)}
            </h2>
            <p data-reader-address="" className="selectable truncate text-meta text-ink-subtle">
              {displayAddress(email)}
            </p>
          </div>

          {/*
            Who it went to. Selectable, and wrapped rather than truncated, because a
            recipient list is exactly the text someone copies into another message.
          */}
          {recipientLines(email).map((line) => (
            <p
              key={line.field}
              data-reader-recipients={line.field}
              className="selectable mt-1 wrap-break-word text-meta text-ink-subtle"
            >
              <span className="text-ink-muted">{line.field}</span> {line.text}
            </p>
          ))}

          <p data-reader-date="" className="selectable mt-1 text-meta text-ink-subtle">
            <time dateTime={new Date(email.receivedAt).toISOString()}>
              {formatFullTime(email.receivedAt)}
            </time>
            {isOwnMessage && " · sent by you"}
          </p>

          {filters.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {filters.map((id) => (
                <FilterTag key={id} id={id} />
              ))}
            </div>
          )}
        </div>
        {phone && listPosition && listPosition.total > 0 && (
          <PositionReadout
            position={listPosition.position}
            total={listPosition.total}
            className="mt-0.5 shrink-0 text-meta"
          />
        )}
      </div>

      <div ref={bodyRef} className="thin-scroll selectable min-h-0 flex-1 overflow-y-auto">
        <article className={`px-6 pt-5 ${phone ? "pb-[calc(var(--wn-dock-h)+var(--wn-dock-bottom)+1.5rem)]" : "pb-8"}`}>
          {/*
            The image decision, at the very top of the email.

            It goes *here* because it is a decision about this message that has to be
            made before reading it — the thing it governs is whether the mail looks like
            the mail the sender sent.

            Three answers, because there are three distinct intentions and a two-button
            offer cannot express the third: this message, from now on, don't ask.
          */}
          {offerImages && (
            <div className="mb-5 max-w-[68ch] rounded-pane bg-sheen px-4 py-3.5">
              <p className="flex items-center gap-2 text-ui font-semibold text-ink">
                <ImageOff size={14} strokeWidth={1.9} className="text-ink-muted" aria-hidden="true" />
                Images are off
              </p>
              <p className="mt-1 text-meta leading-relaxed text-ink-muted">
                This message points at {blocked} thing{blocked === 1 ? "" : "s"} on the
                internet, and Winnow has not fetched {blocked === 1 ? "it" : "them"}. Loading
                {blocked === 1 ? " it" : " them"} tells the sender you opened the message, and
                roughly where you are.
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={actions.onLoadRemoteContent}
                  className={QUIET_BUTTON}
                >
                  Show {blocked === 1 ? "it" : "them"} for this message
                </button>
                <button
                  type="button"
                  onClick={actions.onAlwaysLoadRemoteContent}
                  className={QUIET_BUTTON}
                >
                  Always show images
                </button>
                <button
                  type="button"
                  onClick={actions.onNeverLoadRemoteContent}
                  className={QUIET_BUTTON}
                >
                  Don&rsquo;t ask again
                </button>
                <button
                  type="button"
                  onClick={actions.onShowOriginal}
                  className="rounded-ctl px-3 py-1.5 text-meta font-medium text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Open the original
                </button>
              </div>
            </div>
          )}

          <h1 className="max-w-[42ch] text-title font-semibold tracking-[-0.01em] text-ink" data-reader-subject="">
            {email.subject || "(no subject)"}
          </h1>

          {/*
            The body itself.

            `MessageBody` owns all three forms and the control that picks between them.
            The plain text is still one tap away and is still what the classifier read
            and what a reply quotes, so the two views cannot disagree.

            `onOpenLink` routes a click out to the system browser rather than letting it
            navigate the app: a link in a message must reach a different origin, or it
            reaches this one.
          */}
          <MessageBody
            email={email}
            imagesAllowed={imagesAllowed}
            onOpenLink={(url) => {
              if (onMailto && /^mailto:/i.test(url)) onMailto(url);
              else void platform.openExternal(url);
            }}
            view={view}
            emailDark={emailDark}
            purePlainText={purePlainText}
          />

          {/*
            The rich version is on its way.

            Said out loud because the plain text is already complete: rendering nothing
            would read as "this message has no formatting" when the markup is arriving.
          */}
          {bodyPending && (
            <p
              className="mt-3 text-meta text-ink-subtle"
              role="status"
              aria-live="polite"
            >
              Getting the formatted version…
            </p>
          )}

          {/*
            The standing account of what the message was still fetching.

            `scripts and links are blocked` is unconditional. The count's verb follows
            the answer, because "are loading" is the opposite of the truth when images
            are off — and a privacy note that says the wrong thing is worse than none.
          */}
          {email.bodyHtml && blocked > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-meta font-medium text-ink-muted">
                {imagesAllowed ? (
                  <Eye size={13} strokeWidth={1.9} aria-hidden="true" />
                ) : (
                  <EyeOff size={13} strokeWidth={1.9} aria-hidden="true" />
                )}
                {blocked} remote {blocked === 1 ? "thing is" : "things are"}{" "}
                {imagesAllowed ? "loading" : "withheld"} · scripts and links are blocked
              </p>
              <button
                type="button"
                onClick={actions.onShowOriginal}
                className="text-meta font-medium text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Open the original
              </button>
            </div>
          )}

          {/*
            When images are off *and* the user has said never to ask, this one line is
            the whole of it.

            It is at the end, not at the top with the offer, because it is a *status*
            and not a question: there is no button, so it cannot be the first thing in
            the message.
          */}
          {email.bodyHtml && blocked > 0 && !imagesAllowed && !askAboutImages && (
            <p className="mt-6 max-w-[68ch] text-meta text-ink-subtle">
              This message&rsquo;s {blocked === 1 ? "image was" : "images were"} not loaded.
              Winnow will not ask again.
            </p>
          )}

          {email.attachments.length > 0 && (
            <AttachmentList
              attachments={email.attachments}
              load={actions.onLoadAttachment}
              onSave={(index) => {
                const attachment = email.attachments[index];
                if (attachment) actions.onSaveAttachment({ ...attachment, index });
              }}
              onOpen={actions.onOpenAttachment}
            />
          )}

          {/*
            "Why it's here" and "Change smart filters…", together after the message: the
            moment to ask where it belongs is once it has been read, and up in the header
            they sat between the sender and the words, the first thing the eye met on
            every message (the owner moved "Why it's here" down here in 1.3.3). On a phone
            the article's bottom padding keeps the group clear of the floating reader pill.
          */}
          {(whyHere || actions.onChangeFilters) && (
            <div data-reader-filters-footer="" className="mt-8 flex max-w-[68ch] flex-col gap-3 border-t border-hairline-soft pt-4">
              {whyHere}
              {actions.onChangeFilters && (
                <div className="flex items-center gap-2">
                  <ListFilter size={13} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-ink-subtle" />
                  <p className="text-meta text-ink-subtle">Not where it belongs?</p>
                  <button
                    type="button"
                    data-why-change=""
                    onClick={actions.onChangeFilters}
                    className="rounded-ctl px-1.5 py-1 text-meta font-medium text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    Change smart filters…
                  </button>
                </div>
              )}
            </div>
          )}

          {/*
            The rest of the conversation.

            Clickable, because a thread you cannot read past the newest message is half
            a thread. `focusMessage` is the right entry point rather than a local
            selection swap: it handles the case where the message is not in the current
            view at all, clearing the search and filters that were hiding it.

            Each row leads with the message's own words rather than its subject: in a
            thread the subjects are the same string three times over, while the body is
            the one thing that differs.
          */}
          {/*
            Spacing, not a rule.

            A `border-t` here draws a line across the full measure every time the reader
            moves to a message with a different number of replies. They are separated by
            32–40px and a quiet label instead.
          */}
          {others.length > 0 && (
            <div className="mt-10 max-w-[68ch]">
              <h3 className="text-meta font-semibold text-ink-muted">
                {others.length === 1 ? "1 earlier message" : `${others.length} earlier messages`}
              </h3>
              <ul className="mt-2 flex flex-col gap-0.5">
                {others.map((message) => {
                  const subject = message.subject.trim();
                  // A changed subject is worth a prefix; the same one is noise. An empty
                  // body — a stub, or a message that was entirely a quote — falls back
                  // to the subject rather than to an empty row.
                  const preview = firstLine(message.body);
                  const lead = subject && subject !== email.subject.trim() ? subject : "";
                  return (
                    <li key={message.gmailId}>
                      <button
                        type="button"
                        onClick={() => actions.onOpenMessage(message.id)}
                        className="flex w-full items-baseline gap-2 rounded-ctl px-2 py-1.5 text-left text-ui transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        {/* Weight only for unread, as in the list. */}
                        <span
                          data-thread-sender=""
                          className={`shrink-0 ${message.unread ? "font-semibold text-ink" : "font-normal text-ink-muted"}`}
                        >
                          {displayName(message)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-ink-body">
                          {lead && (
                            <span className={`mr-2 ${message.unread ? "font-semibold text-ink" : "font-normal text-ink"}`}>
                              {lead}
                            </span>
                          )}
                          {preview || message.subject || "(no body)"}
                        </span>
                        {/*
                          Against the *store's* reference instant, not the open message's:
                          formatted relative to another message's timestamp it reads "in 3
                          days" for something that arrived three days ago. `now` rather
                          than `Date.now()` so the demo's fixed instant still governs.
                        */}
                        <span className="shrink-0 text-meta tabular-nums text-ink-subtle">
                          {formatRelative(message.receivedAt, now)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

        </article>
      </div>

      {phone && (
        <ReaderPill
          starred={email.starred}
          unread={email.unread}
          mailbox={mailbox}
          actions={actions}
          view={view}
          onViewChange={setView}
          hasHtml={Boolean(email.bodyHtml)}
          senderName={displayName(email)}
          scroller={bodyRef}
          messageKey={email.id}
          leftHanded={leftHanded}
          reach={stepReach}
          onStep={onStep}
        />
      )}
    </div>
  );
}


