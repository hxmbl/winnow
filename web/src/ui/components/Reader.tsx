/**
 * The reader.
 *
 * The body renders as sanitised markup inline (`MessageBody`, via
 * `core/mail/sanitize.ts`) rather than as text; the untouched original is still offered
 * in a sandboxed frame as "As sent". Remote content stays blocked by default, and the
 * badges come from the same predicates as the filters, so an "Important" chip and the
 * Important pill always agree.
 */

import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Ban,
  Check,
  CornerUpLeft,
  Eye,
  EyeOff,
  Forward,
  ImageOff,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  RotateCcw,
  Star,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { formatFullTime, formatRelative } from "../../core/mail/datetime";
import { shortcutHint } from "../../core/mail/keybinds";
import { countRemoteReferences } from "../../core/mail/html";
import { displayAddress, displayName, monogram, type Email } from "../../core/model/email";
import {
  badgeFilters,
  type BuiltinSmartFilter,
  type EmailSignals,
} from "../../core/model/signals";
import { filterIcon } from "../filterIcons";
import { MessageBody, type BodyView } from "./MessageBody";
import { bodyViewOptions } from "../bodyViews";
import { platform } from "../../platform";

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
import { avatarColor, avatarTextColor } from "../avatarColor";
import { formatBytes } from "../../core/gmail/mime";
import type { Mailbox } from "../../core/model/email";
import { DOCK_SURFACE } from "./PhoneChrome";

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
      className="inline-flex items-center gap-1.5 rounded-full bg-sheen py-1 pl-1.5 pr-2.5 text-[11.5px] font-medium text-ink-body"
      title={title}
    >
      <Icon size={12} strokeWidth={2} className="shrink-0 text-ink-muted" aria-hidden="true" />
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
  onShowOriginal: () => void;
  onBlockSender: () => void;
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
};

const ICON_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-sheen focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

/**
 * A quiet text button, for the places in this pane that are not the toolbar.
 *
 * `bg-sheen` rather than a bordered pill: four outlined pills in a column is a column
 * of boxes. At rest they are almost invisible; the fill is the hover.
 */
const QUIET_BUTTON =
  "rounded-full bg-sheen px-3 py-1.5 text-[12.5px] font-medium text-ink-body transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

function Toolbar({ starred, unread, mailbox, actions, view, onViewChange, hasHtml, senderName }: {
  starred: boolean;
  unread: boolean;
  mailbox: Mailbox;
  actions: Actions;
  view: BodyView;
  onViewChange: (next: BodyView) => void;
  hasHtml: boolean;
  senderName: string;
}) {
  // The label follows the action rather than the verb: "Restore" in the bin, because
  // that is what the button will do.
  const archiveLabel =
    mailbox === "inbox" ? "Archive" : mailbox === "archive" ? "Move to inbox" : "Restore";
  const trashLabel = mailbox === "trash" ? "Delete permanently" : "Move to trash";

  const inSpam = mailbox === "spam";

  // The starred fill is the palette's own accent, the same custom property the list
  // row reads. A literal here was missed when the list row moved onto
  // `--wn-badge-starred`, and a hard-coded gold goes near-invisible in dark mode.
  const ICON_BUTTON =
    "flex h-7 w-7 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

  return (
    // `shrink-0` and, below `sm`, the whole row is a column — see the header.
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={actions.onStar}
        aria-pressed={starred}
        aria-label={starred ? "Unstar" : "Star"}
        title={shortcutHint(starred ? "Unstar" : "Star", "toggleStar")}
        className={`${ICON_BUTTON} ${starred ? "text-[var(--wn-badge-starred)]" : ""}`}
      >
        <Star size={15} strokeWidth={1.9} fill={starred ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        onClick={actions.onRead}
        aria-label={unread ? "Mark read" : "Mark unread"}
        title={unread ? "Mark read" : shortcutHint("Mark unread", "toggleRead")}
        className={ICON_BUTTON}
      >
        {unread ? <Mail size={15} strokeWidth={1.9} /> : <MailOpen size={15} strokeWidth={1.9} />}
      </button>
      <span className="mx-1 h-4 w-px bg-divider" aria-hidden="true" />
      <button
        type="button"
        onClick={actions.onReply}
        aria-label="Reply to all"
        title={shortcutHint("Reply to all", "focusReply")}
        className={ICON_BUTTON}
      >
        <CornerUpLeft size={15} strokeWidth={1.9} />
      </button>
      <button
        type="button"
        onClick={actions.onForward}
        aria-label="Forward"
        title={shortcutHint("Forward", "forward")}
        className={ICON_BUTTON}
      >
        <Forward size={15} strokeWidth={1.9} />
      </button>
      {/* In Spam this *is* the not-spam button, not a second one beside it — both
          mean "move to the inbox". */}
      {inSpam ? (
        <button
          type="button"
          onClick={actions.onNotSpam}
          aria-label="Not spam — move to inbox"
          title="Not spam — move to inbox"
          className={ICON_BUTTON}
        >
          <Undo2 size={15} strokeWidth={1.9} />
        </button>
      ) : (
        <button
          type="button"
          onClick={actions.onArchive}
          aria-label={archiveLabel}
          title={shortcutHint(archiveLabel, "archive")}
          className={ICON_BUTTON}
        >
          {mailbox === "inbox" ? (
            <Archive size={15} strokeWidth={1.9} />
          ) : (
            <RotateCcw size={15} strokeWidth={1.9} />
          )}
        </button>
      )}
      <button
        type="button"
        onClick={actions.onTrash}
        aria-label={trashLabel}
        title={shortcutHint(trashLabel, "trash")}
        className={ICON_BUTTON}
      >
        <Trash2 size={15} strokeWidth={1.9} />
      </button>
      <MoreMenu
        view={view}
        onViewChange={onViewChange}
        hasHtml={hasHtml}
        senderName={senderName}
        onBlockSender={actions.onBlockSender}
        buttonClass={ICON_BUTTON}
      />
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
function MoreMenu({ view, onViewChange, hasHtml, senderName, onBlockSender, buttonClass, phone, buttonContent }: {
  view: BodyView;
  onViewChange: (next: BodyView) => void;
  hasHtml: boolean;
  senderName: string;
  onBlockSender: () => void;
  buttonClass: string;
  /**
   * The phone reader's version: the menu opens *upward* from the action bar, its rows
   * are touch height, and it leads with star and read, which the bar has no room for.
   */
  phone?: { starred: boolean; unread: boolean; onStar: () => void; onRead: () => void };
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
    ? "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[14px] font-medium text-ink-body transition-colors active:bg-sheen focus-visible:bg-sheen focus-visible:outline-none"
    : "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] font-medium text-ink-body transition-colors hover:bg-sheen focus-visible:bg-sheen focus-visible:outline-none";
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
              ? // Flat, and the tone of the bar it rises from rather than of the message
                // card under it: a tonal step, no border and no shadow.
                "absolute bottom-full right-0 z-30 mb-2 w-[min(18rem,calc(100vw-1.5rem))] rounded-pane bg-canvas p-1.5"
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
                  className={phone.starred ? "text-[var(--wn-badge-starred)]" : "text-ink-muted"}
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
          <p className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-[0.07em] text-ink-subtle">
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
          <div className="my-1 h-px bg-divider" aria-hidden="true" />
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
 * The phone reader's action bar.
 *
 * The same verbs as the toolbar, moved to the bottom edge where a thumb already is, each
 * with its label under its icon like the tabs it replaces. Back leads, because leaving is
 * the most common thing to do with a message on a phone. Star and read go into More: six
 * targets of 48px is what a 390px screen holds without shrinking any of them.
 */
function ReaderDock({ starred, unread, mailbox, actions, view, onViewChange, hasHtml, senderName, onClose }: {
  starred: boolean;
  unread: boolean;
  mailbox: Mailbox;
  actions: Actions;
  view: BodyView;
  onViewChange: (next: BodyView) => void;
  hasHtml: boolean;
  senderName: string;
  onClose: () => void;
}) {
  const inSpam = mailbox === "spam";
  const archiveLabel =
    mailbox === "inbox" ? "Archive" : mailbox === "archive" ? "Move to inbox" : "Restore";
  const archiveShort = mailbox === "inbox" ? "Archive" : mailbox === "archive" ? "Inbox" : "Restore";
  const trashLabel = mailbox === "trash" ? "Delete permanently" : "Move to trash";
  const trashShort = mailbox === "trash" ? "Delete" : "Trash";

  const BUTTON =
    "flex min-h-[52px] w-full flex-col items-center justify-center gap-0.5 rounded-pane px-0.5 py-1.5 text-ink-muted transition-colors active:bg-sheen focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
  const LABEL = "max-w-full truncate text-tiny font-medium";
  const ICON = { size: 20, strokeWidth: 1.8, "aria-hidden": true } as const;

  return (
    <div
      data-reader-dock=""
      className={`${DOCK_SURFACE} grid grid-cols-6 gap-0.5 px-2`}
    >
      <button type="button" onClick={onClose} aria-label="Back to the list" className={BUTTON}>
        <ArrowLeft {...ICON} />
        <span className={LABEL}>Back</span>
      </button>
      <button type="button" onClick={actions.onReply} aria-label="Reply to all" className={BUTTON}>
        <CornerUpLeft {...ICON} />
        <span className={LABEL}>Reply</span>
      </button>
      <button type="button" onClick={actions.onForward} aria-label="Forward" className={BUTTON}>
        <Forward {...ICON} />
        <span className={LABEL}>Forward</span>
      </button>
      {inSpam ? (
        <button type="button" onClick={actions.onNotSpam} aria-label="Not spam — move to inbox" className={BUTTON}>
          <Undo2 {...ICON} />
          <span className={LABEL}>Not spam</span>
        </button>
      ) : (
        <button type="button" onClick={actions.onArchive} aria-label={archiveLabel} className={BUTTON}>
          {mailbox === "inbox" ? <Archive {...ICON} /> : <RotateCcw {...ICON} />}
          <span className={LABEL}>{archiveShort}</span>
        </button>
      )}
      <button type="button" onClick={actions.onTrash} aria-label={trashLabel} className={BUTTON}>
        <Trash2 {...ICON} />
        <span className={LABEL}>{trashShort}</span>
      </button>
      <MoreMenu
        view={view}
        onViewChange={onViewChange}
        hasHtml={hasHtml}
        senderName={senderName}
        onBlockSender={actions.onBlockSender}
        buttonClass={BUTTON}
        phone={{ starred, unread, onStar: actions.onStar, onRead: actions.onRead }}
        buttonContent={
          <>
            <MoreHorizontal {...ICON} />
            <span className={LABEL}>More</span>
          </>
        }
      />
    </div>
  );
}

type Props = {
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
        <MailOpen size={28} strokeWidth={1.4} className="text-ink-subtle" aria-hidden="true" />
        <p className="text-[13.5px] font-medium text-ink-muted">Nothing selected</p>
        <p className="max-w-[24rem] text-preview text-ink-subtle">
          Pick a message from the list, or press <kbd className="font-mono">j</kbd> to move
          through it.
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
    <div data-reader="" className="flex min-h-0 flex-1 flex-col">
      {/* Back bar for a narrow window. On a wide screen the reader is a pane beside
          the list, so closing it would be redundant; on a phone the dock has Back. */}
      {!phone && (
      <div className="flex items-center gap-1 px-3 py-2 lg:hidden">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to the list"
          className={ICON_BUTTON}
        >
          <X size={16} strokeWidth={2} />
        </button>
        <span className="text-ui font-semibold text-ink-muted">Message</span>
      </div>
      )}

      {/*
        The header.

        No rule under it: a `border-b` drew a hard line across the pane that the flat
        layout does not otherwise have, so the separation is the padding below and the
        change in type size.
      */}
      <div className={`flex items-start gap-3 px-5 pb-4 ${phone ? "pt-[max(1rem,env(safe-area-inset-top))]" : "pt-4"}`}>
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold"
          style={{ background: avatarColor(email.sender), color: avatarTextColor(email.sender) }}
        >
          {monogram(email)}
        </span>

        <div className="min-w-0 flex-1">
          {/* The sender is the h2 and the subject the h1 — inverted from the usual
              pattern, and deliberately: the subject is the page's title, so it is the
              document's h1 and the sender is subordinate to it.

              1200px rather than `lg` (1024): `lg` is the width at which the pane appears
              at all, not the width at which it fits. Below 1200px the name is what gives
              way, and it ellipsised to make room for controls you reach for later. */}
          <div className="flex flex-col gap-2.5 min-[1200px]:flex-row min-[1200px]:items-start min-[1200px]:justify-between min-[1200px]:gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold leading-snug text-ink">
                {displayName(email)}
              </h2>
              <p className="selectable truncate text-[12.5px] text-ink-muted">
                {displayAddress(email)}
              </p>
            </div>
            {!phone && <Toolbar
              starred={email.starred}
              unread={email.unread}
              mailbox={mailbox}
              actions={actions}
              view={view}
              onViewChange={setView}
              hasHtml={Boolean(email.bodyHtml)}
              senderName={displayName(email)}
            />}
          </div>

          <p className="mt-1 text-[12.5px] text-ink-subtle">
            <time dateTime={new Date(email.receivedAt).toISOString()}>
              {formatFullTime(email.receivedAt)}
            </time>
            {isOwnMessage && " · sent by you"}
          </p>

          {filters.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {filters.map((id) => (
                <FilterTag key={id} id={id} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div ref={bodyRef} className="thin-scroll selectable min-h-0 flex-1 overflow-y-auto">
        <article className="px-6 pb-8 pt-5">
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
              <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <ImageOff size={14} strokeWidth={1.9} className="text-ink-muted" aria-hidden="true" />
                Images are off
              </p>
              <p className="mt-1 text-preview leading-relaxed text-ink-muted">
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
                  className="rounded-full px-3 py-1.5 text-[12.5px] font-medium text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Open the original
                </button>
              </div>
            </div>
          )}

          <h1 className="max-w-[42ch] text-subject font-semibold leading-tight text-ink">
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
            onOpenLink={(url) => void platform.openExternal(url)}
            view={view}
          />

          {/*
            The rich version is on its way.

            Said out loud because the plain text is already complete: rendering nothing
            would read as "this message has no formatting" when the markup is arriving.
          */}
          {bodyPending && (
            <p
              className="mt-3 text-[12px] text-ink-subtle"
              role="status"
              aria-live="polite"
            >
              Loading the formatted version…
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
              <p className="flex items-center gap-2 text-[12px] font-medium text-ink-muted">
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
                className="text-[12px] font-medium text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
            <p className="mt-6 max-w-[68ch] text-[12px] text-ink-subtle">
              This message&rsquo;s {blocked === 1 ? "image was" : "images were"} not loaded.
              Winnow will not ask again.
            </p>
          )}

          {email.attachments.length > 0 && (
            <div className="mt-6 max-w-[68ch]">
              <h3 className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-subtle">
                {email.attachments.length}{" "}
                {email.attachments.length === 1 ? "attachment" : "attachments"}
              </h3>
              <ul className="mt-2 flex flex-col gap-1.5">
                {email.attachments.map((attachment, index) => (
                  <li key={attachment.id}>
                    <button
                      type="button"
                      onClick={() => actions.onSaveAttachment({ ...attachment, index })}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-sheen focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      <Paperclip size={14} strokeWidth={1.9} className="shrink-0 text-ink-muted" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                        {attachment.filename}
                      </span>
                      <span className="shrink-0 text-[12px] tabular-nums text-ink-subtle">
                        {formatBytes(attachment.size)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
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
            32–40px and an uppercase micro label instead.
          */}
          {others.length > 0 && (
            <div className="mt-10 max-w-[68ch]">
              <h3 className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-subtle">
                {others.length} earlier {others.length === 1 ? "message" : "messages"} in this
                conversation
              </h3>
              <ul className="mt-2 flex flex-col gap-0.5">
                {others.map((message) => {
                  const subject = message.subject.trim();
                  // A changed subject is worth a prefix; the same one is noise. An empty
                  // body — a stub, or a message that was entirely a quote — falls back
                  // to the subject rather than to an empty row.
                  const preview = firstLine(message.body);
                  const lead = subject && subject !== email.subject.trim() ? `${subject} — ` : "";
                  return (
                    <li key={message.gmailId}>
                      <button
                        type="button"
                        onClick={() => actions.onOpenMessage(message.id)}
                        className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <span className="shrink-0 font-semibold text-ink-muted">
                          {displayName(message)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-ink-body">
                          {lead}
                          {preview || message.subject || "(no body)"}
                        </span>
                        {/*
                          Against the *store's* reference instant, not the open message's:
                          formatted relative to another message's timestamp it reads "in 3
                          days" for something that arrived three days ago. `now` rather
                          than `Date.now()` so the demo's fixed instant still governs.
                        */}
                        <span className="shrink-0 tabular-nums text-ink-subtle">
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
        <ReaderDock
          starred={email.starred}
          unread={email.unread}
          mailbox={mailbox}
          actions={actions}
          view={view}
          onViewChange={setView}
          hasHtml={Boolean(email.bodyHtml)}
          senderName={displayName(email)}
          onClose={onClose}
        />
      )}
    </div>
  );
}


