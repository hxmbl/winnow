/**
 * The reader.
 *
 * A mail client spends most of its life on this screen, so the decisions here
 * are about reading rather than about looking.
 *
 * **The body is text, not HTML.** A sender controls their message completely, so
 * rendering it as markup means running their code in the app's origin — with
 * access to everything the app knows. Winnow renders the plain text the sync
 * already extracted, which is also what the classifier read and what the quote
 * uses, so what you read is what Winnow decided about. The original HTML is one
 * click away, in your browser, which is a different origin entirely.
 *
 * **Remote content is blocked by default.** A tracking pixel confirms a message
 * was opened and roughly where; a remote stylesheet can exfiltrate anything in
 * the DOM. The count of blocked references is stated rather than hidden, so the
 * "images blocked" affordance is honest about what it is withholding.
 *
 * **The badges come from the same predicates as the filters.** One shared
 * threshold, so a message wearing an "Important" chip is in the Important pill
 * and vice versa. An earlier version had the filter at 56 and the badge at 70,
 * and users could not tell which they were looking at.
 */

import { useEffect, useRef } from "react";
import {
  Archive,
  Ban,
  CornerUpLeft,
  Forward,
  Mail,
  MailOpen,
  Paperclip,
  RotateCcw,
  Star,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { formatFullTime, formatRelative } from "../../core/mail/datetime";
import { countRemoteReferences } from "../../core/mail/html";
import { displayAddress, displayName, monogram, type Email } from "../../core/model/email";
import { badgeFilters, filterLabel, type EmailSignals } from "../../core/model/signals";
import { avatarColor, avatarTextColor } from "../avatarColor";
import { formatBytes } from "../../core/gmail/mime";
import type { Mailbox } from "../../core/model/email";

/** A bucket chip in the reader header. */
function Badge({ id }: { id: string }) {
  // Three custom properties, all written by `applyTheme` from the live palette:
  // the accent, a wash of it at 14%, and an edge at 34%. Reading the accent's
  // *name* and feeding it to a hex parser cannot work — JavaScript has no way to
  // ask the CSS engine what a custom property currently resolves to, and
  // `parseInt("ar(--wn-badge-urgent)", 16)` quietly answers `0x0A`. That is how
  // every chip in the reader ended up wearing the same near-black fill.
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-semibold"
      style={{
        background: `var(--wn-badge-${id}-wash)`,
        border: `1px solid var(--wn-badge-${id}-edge)`,
        color: `var(--wn-badge-${id})`,
      }}
    >
      {filterLabel({ kind: "builtin", id: id as never })}
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
  /** Turn image loading on for the whole mailbox, from the blocked-content note. */
  onLoadRemoteContent: () => void;
  /** Open another message in the conversation. */
  onOpenMessage: (id: number) => void;
  onSaveAttachment: (attachment: { filename: string; mimeType: string; size: number; index: number }) => void;
};

const ICON_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

function Toolbar({ starred, unread, mailbox, actions }: {
  starred: boolean;
  unread: boolean;
  mailbox: Mailbox;
  actions: Actions;
}) {
  // Context-sensitive, and the label follows the action rather than the verb:
  // "Restore" in the bin, because that is what the button will do.
  const archiveLabel =
    mailbox === "inbox" ? "Archive" : mailbox === "archive" ? "Move to inbox" : "Restore";
  const trashLabel = mailbox === "trash" ? "Delete permanently" : "Move to trash";

  /*
    No "not spam" outside the spam folder.

    It is here, and only here, because the spam folder had no way out: `GmailClient`
    implemented `markNotSpam` and nothing in the app called it, so a message Gmail
    misfiled was recoverable only by going to Gmail on the web. One button, in the one
    folder where the question arises.
  */
  const inSpam = mailbox === "spam";

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={actions.onStar}
        aria-pressed={starred}
        aria-label={starred ? "Unstar" : "Star"}
        title={starred ? "Unstar (s)" : "Star (s)"}
        className={`${ICON_BUTTON} ${starred ? "text-[#B8860B]" : ""}`}
      >
        <Star size={15} strokeWidth={1.9} fill={starred ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        onClick={actions.onRead}
        aria-label={unread ? "Mark read" : "Mark unread"}
        title={unread ? "Mark read" : "Mark unread (u)"}
        className={ICON_BUTTON}
      >
        {unread ? <Mail size={15} strokeWidth={1.9} /> : <MailOpen size={15} strokeWidth={1.9} />}
      </button>
      <span className="mx-1 h-4 w-px bg-divider" aria-hidden="true" />
      <button
        type="button"
        onClick={actions.onReply}
        aria-label="Reply to all"
        title="Reply to all (r)"
        className={ICON_BUTTON}
      >
        <CornerUpLeft size={15} strokeWidth={1.9} />
      </button>
      <button
        type="button"
        onClick={actions.onForward}
        aria-label="Forward"
        title="Forward (f)"
        className={ICON_BUTTON}
      >
        <Forward size={15} strokeWidth={1.9} />
      </button>
      <button
        type="button"
        onClick={actions.onArchive}
        aria-label={archiveLabel}
        title={`${archiveLabel} (e)`}
        className={ICON_BUTTON}
      >
        {mailbox === "inbox" ? (
          <Archive size={15} strokeWidth={1.9} />
        ) : (
          <RotateCcw size={15} strokeWidth={1.9} />
        )}
      </button>
      <button
        type="button"
        onClick={actions.onTrash}
        aria-label={trashLabel}
        title={`${trashLabel} (#)`}
        className={ICON_BUTTON}
      >
        <Trash2 size={15} strokeWidth={1.9} />
      </button>
      {inSpam && (
        <>
          <span className="mx-1 h-4 w-px bg-divider" aria-hidden="true" />
          <button
            type="button"
            onClick={actions.onNotSpam}
            aria-label="Not spam — move to inbox"
            title="Not spam — move to inbox"
            className={ICON_BUTTON}
          >
            <Undo2 size={15} strokeWidth={1.9} />
          </button>
        </>
      )}
    </div>
  );
}

type Props = {
  email: Email | null;
  conversation: readonly Email[];
  signals: EmailSignals | null;
  mailbox: Mailbox;
  loadRemoteContent: boolean;
  accountAddress: string | null;
  /**
   * The reference instant for relative timestamps in this pane.
   *
   * Passed in rather than read from the clock so the demo's fixed instant governs the
   * demo's timestamps, and so the reader cannot disagree with the list beside it —
   * two "2h ago"s a minute apart is the kind of detail that makes an app feel broken.
   */
  now: number;
  onClose: () => void;
  actions: Actions;
  /** Scroll the reader by whole steps, for the arrow keys. */
  scrollStep: number;
};

export function Reader({
  email,
  conversation,
  signals,
  mailbox,
  loadRemoteContent,
  accountAddress,
  now,
  onClose,
  actions,
  scrollStep,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // The arrow keys scroll the reader rather than moving the list. A discrete
  // step per keypress, applied as an effect, so holding the key down scrolls
  // repeatedly — which is what a key repeat is *for*.
  useEffect(() => {
    if (scrollStep === 0 || !bodyRef.current) return;
    bodyRef.current.scrollBy({ top: scrollStep * 120, behavior: "auto" });
  }, [scrollStep]);

  if (!email) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-panel px-6 text-center">
        <MailOpen size={28} strokeWidth={1.4} className="text-ink-subtle" aria-hidden="true" />
        <p className="text-[13.5px] font-medium text-ink-muted">Nothing selected</p>
        <p className="max-w-[24rem] text-preview text-ink-subtle">
          Pick a message from the list, or press <kbd className="font-mono">j</kbd> to move
          through it.
        </p>
      </div>
    );
  }

  const badges = signals ? badgeFilters(signals) : [];
  const blocked = email.bodyHtml ? countRemoteReferences(email.bodyHtml) : 0;
  const isOwnMessage = accountAddress !== null && email.sender === accountAddress;
  const others = conversation.filter((m) => m.gmailId !== email.gmailId);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      {/* Mobile-only back bar. On a wide screen the reader is a pane beside the
          list, so closing it would be redundant. */}
      <div className="flex items-center gap-1 border-b border-hairline px-3 py-2 lg:hidden">
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

      <div className="flex items-start gap-3 border-b border-hairline px-5 py-4">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold"
          style={{ background: avatarColor(email.sender), color: avatarTextColor(email.sender) }}
        >
          {monogram(email)}
        </span>

        <div className="min-w-0 flex-1">
          {/* The sender is the h2 and the subject the h1 — inverted from the
              usual pattern, and deliberately: the subject is the page's title, so
              it is the document's h1 and the sender is subordinate to it. */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold leading-snug text-ink">
                {displayName(email)}
              </h2>
              <p className="selectable truncate text-[12.5px] text-ink-muted">
                {displayAddress(email)}
              </p>
            </div>
            <Toolbar
              starred={email.starred}
              unread={email.unread}
              mailbox={mailbox}
              actions={actions}
            />
          </div>

          <p className="mt-1 text-[12.5px] text-ink-subtle">
            <time dateTime={new Date(email.receivedAt).toISOString()}>
              {formatFullTime(email.receivedAt)}
            </time>
            {isOwnMessage && " · sent by you"}
          </p>

          {badges.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {badges.map((id) => (
                <Badge key={id} id={id} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div ref={bodyRef} className="thin-scroll selectable min-h-0 flex-1 overflow-y-auto">
        <article className="px-6 py-6">
          <h1 className="max-w-[42ch] text-subject font-semibold leading-tight text-ink">
            {email.subject || "(no subject)"}
          </h1>

          {/*
            The sender controls this text entirely, so it is rendered as text.

            `whitespace-pre-wrap` preserves the sender's own paragraph breaks
            without re-wrapping to the pane width — an email body is
            pre-formatted by convention, and reflowing it would shred the quoted
            reply underneath. The *font* is the system sans rather than a
            monospace one, because this is prose a person wrote, and monospace
            makes ordinary email read as a log file. The monospace stack is
            still used for the one place it is right: nothing here, which is
            the point — there is no code in an email body worth a monospace
            treatment, and pretending otherwise costs legibility on every
            message.
          */}
          <div className="selectable mt-4 max-w-[68ch] whitespace-pre-wrap text-body text-ink-body">
            {email.body}
          </div>

          {/*
            Rich rendering, behind the setting.

            This is the *only* place in the app where a sender's markup is rendered,
            and it is behind both an explicit opt-in and a sandbox that grants nothing:
            no scripts, no forms, no popups, no same-origin. So a message can show its
            own images and layout, and cannot execute anything, read anything, or
            navigate the window.

            The cost is real and is stated on screen — the sender learns the message was
            opened and roughly where — which is why it is off by default and why the
            text rendering above is what most messages get. A toggle that only removed
            this panel, as it used to, was a control that changed nothing and took away
            the app's own explanation of itself.

            `key` on the iframe: the document changes when the message does, and a reused
            frame would keep the previous message's scroll position and its already-loaded
            images. The reader is already remounted per selection by its parent, so this
            is belt to that braces.
          */}
          {email.bodyHtml && loadRemoteContent && (
            <div className="mt-5 max-w-[68ch]">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-[12px] font-semibold text-ink-muted">
                  <TriangleAlert size={13} strokeWidth={1.9} aria-hidden="true" />
                  {blocked} remote {blocked === 1 ? "reference is" : "references are"} loading
                </p>
                <button
                  type="button"
                  onClick={actions.onShowOriginal}
                  className="text-[12px] font-semibold text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Open the original
                </button>
              </div>
              <iframe
                key={email.id}
                title={`Message from ${displayName(email)}`}
                srcDoc={email.bodyHtml}
                // An empty `sandbox`, deliberately. Empty is the *most* restrictive
                // value there is: every capability is off. Naming `allow-same-origin`
                // here would give the frame access to this app's own origin, which is
                // the one thing that would make rendering a sender's markup dangerous.
                sandbox=""
                referrerPolicy="no-referrer"
                className="h-[32rem] w-full rounded-pane border border-hairline bg-surface"
              />
            </div>
          )}

          {/*
            The blocked-content note.

            Only when there is remote content and it is *not* being loaded, which is the
            default and the only state in which the note is about blocking. It carries
            the escape hatch — the original, in the user's own browser — plus the one
            click that turns images on, so neither route out of the text-only reader is
            hidden behind a settings panel.
          */}
          {email.bodyHtml && blocked > 0 && !loadRemoteContent && (
            <div className="mt-5 max-w-[68ch] rounded-pane border border-hairline bg-surface-sunken px-4 py-3">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-ink-body">
                <TriangleAlert size={14} strokeWidth={1.9} className="text-ink-muted" aria-hidden="true" />
                {blocked} remote {blocked === 1 ? "reference was" : "references were"} blocked
              </p>
              <p className="mt-1 text-preview text-ink-muted">
                Winnow shows the plain text of every message, so images and stylesheets
                from the sender are not loaded — they can confirm you opened a message and
                roughly where you are.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={actions.onShowOriginal}
                  className="rounded-full border border-control-border px-3 py-1 text-[12.5px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Open the original in your browser
                </button>
                <button
                  type="button"
                  onClick={actions.onLoadRemoteContent}
                  className="rounded-full border border-control-border px-3 py-1 text-[12.5px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Load images
                </button>
              </div>
            </div>
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
                      className="flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
            a thread. The list was previously a set of `<span>`s with no handler, so the
            only way to see an earlier message was to find it in the inbox list and open
            it there — and a message that has been archived is not in the inbox list at
            all, so for those it was not reachable at all.

            `focusMessage` is the right entry point rather than a local selection swap:
            it handles the case where the message is not in the current view at all,
            clearing the search and filters that were hiding it.
          */}
          {others.length > 0 && (
            <div className="mt-8 max-w-[68ch] border-t border-hairline pt-4">
              <h3 className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-subtle">
                {others.length} earlier {others.length === 1 ? "message" : "messages"} in this
                conversation
              </h3>
              <ul className="mt-2 flex flex-col gap-0.5">
                {others.map((message) => (
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
                        {message.subject || "(no subject)"}
                      </span>
                      {/*
                        Against the *store's* reference instant, not the open message's.

                        Formatted relative to another message's timestamp it reads "in 3
                        days" for something that arrived three days ago — which is how
                        the conversation list said the opposite of what it meant. And
                        `now` rather than `Date.now()`, so the demo's fixed instant still
                        governs the demo's timestamps.
                      */}
                      <span className="shrink-0 tabular-nums text-ink-subtle">
                        {formatRelative(message.receivedAt, now)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-8 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={actions.onBlockSender}
              className="inline-flex items-center gap-1.5 rounded-full border border-control-border px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Ban size={13} strokeWidth={1.9} aria-hidden="true" />
              Hide everything from {displayName(email)}
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}


