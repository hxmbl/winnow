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
  EyeOff,
  Forward,
  ImageOff,
  Mail,
  MailOpen,
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

/**
 * The first thing someone said, on one line.
 *
 * For a conversation list, where the column has to distinguish messages that share
 * a subject. Quote markers go first, because a reply whose body opens with
 * `> On Tuesday, you wrote:` would otherwise lead with the quoted text rather than
 * with the reply.
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

/**
 * A smart filter that applies to the open message.
 *
 * **Icon and word, never colour alone.** This was a chip whose whole identity was
 * a wash of the bucket's accent — an eleven-hue pill carrying no information a
 * screen could read without knowing the palette, and nothing at all to a reader
 * with a colour vision deficiency, in dark mode, or in a screenshot. `theme.ts`
 * spends a hundred lines deriving chip label colours that clear WCAG AA on their
 * own wash, which is a measure of how much machinery was committed to keeping a
 * colour legible rather than saying what it meant.
 *
 * So the shape and the word do the work, and the accent goes entirely rather than
 * being kept as a tint: an icon that still needed its bucket's hue to be
 * interpretable would be carrying the colour anyway, just more quietly, and
 * `theme.ts` records that the only accent that survived is `starred`, which tints
 * the star itself. The tag's glyph takes the row's own muted ink, so it reads as
 * part of the message rather than as a badge competing with it. Nothing here is a
 * border or an opaque fill either: the tags sit on the reader's own surface, and
 * the group is separated from the header above it by spacing.
 *
 * The `title` is the explanation from `ui/filterIcons`, so hovering says *why*
 * Winnow thinks this, which is the part a chip never communicated.
 */
function FilterTag({ id }: { id: BuiltinSmartFilter }) {
  const { Icon, label, title } = filterIcon(id);
  return (
    <span
      // `data-filter-tag` so the smoke test can find these by what they *are* rather
      // than by a `title` attribute, which the list rows also carry and which a
      // future explanatory tooltip elsewhere would collide with.
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
  /**
   * Turn image loading on for this message only.
   *
   * Per-message, and labelled accordingly — the button used to say "Load images"
   * while setting a global preference that persisted, which meant a decision about
   * one message silently became a decision about all of them.
   */
  onLoadRemoteContent: () => void;
  /**
   * Load images from now on, for every message.
   *
   * The second of the three answers, and the one that needed a real destination: the
   * offer previously had "load this one" and nothing else, so a user who had decided
   * they trusted their mail had to say it again on every single message.
   */
  onAlwaysLoadRemoteContent: () => void;
  /**
   * Stop being asked — load images for nobody, silently, from now on.
   *
   * Not the same as declining *this* message. Someone who has been asked three times
   * wants their mail to render, and a boolean-only model had nowhere to record that,
   * so the choice simply did not exist and the offer would have repeated forever.
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
 * `bg-sheen` rather than a bordered pill. There are four of these in the reader and
 * every one is secondary — an escape hatch beside the thing it escapes from — and
 * four outlined pills in a column is a column of boxes. At rest they are almost
 * invisible; the fill is the hover, and the text is always legible.
 */
const QUIET_BUTTON =
  "rounded-full bg-sheen px-3 py-1.5 text-[12.5px] font-medium text-ink-body transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

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
    The verbs, and which mailbox decides which.

    Three rules, one per mailbox, and each is about not offering the same action twice:

      - **Inbox.** Archive and bin. The ordinary pair.
      - **Spam.** "Not spam" and bin. Archive is *not* offered, because from Spam it
        means "move to the inbox" — which is exactly what the not-spam button does. Two
        icons with two tooltips, one action. It read as a toolbar with a bug in it.
      - **Bin.** Restore and delete-permanently. Archive is the restore.

    The "not spam" button exists because the spam folder had no way out at all:
    `GmailClient` implemented `markNotSpam` and nothing in the app called it, so a
    message Gmail misfiled was recoverable only by going to Gmail on the web.
  */
  const inSpam = mailbox === "spam";

  // The starred fill is the palette's own accent, the same custom property the
  // list row and the reader's "Starred" chip read. It was a literal `#B8860B` here
  // and only here, which is exactly the drift the token exists to prevent: the list
  // row had already been moved onto `--wn-badge-starred` with a comment explaining
  // why, and this one was missed. The visible symptom is that a starred message
  // shows a near-invisible dark-gold star in dark mode, where the palette's value
  // is `#FACC15`.
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
      {/*
        In Spam this *is* the not-spam button, not a second one beside it. Both meant
        "move to the inbox", so the folder showed two icons and two tooltips for one
        action — which reads as a toolbar with a duplicated control rather than as a
        deliberate pair.
      */}
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
   * Resolved by `App.tsx` from the global policy and the per-message override, so
   * the reader never has to know which of the two is in force — and so "should the
   * offer appear" is one boolean rather than the reader re-deriving a three-way
   * policy it was handed pieces of.
   */
  imagesAllowed: boolean;
  /**
   * Whether to offer the choice at all.
   *
   * `false` once the user has answered for good. A preference to "never be asked"
   * that still showed the question would not be a preference.
   */
  askAboutImages: boolean;
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
  /**
   * True when this message's HTML body has not arrived yet.
   *
   * A separate prop rather than something the reader infers from `email.bodyHtml`
   * being absent, because absent means two different things: not fetched yet, or a
   * plain-text message that will never have one. The store knows which, and a reader
   * that guessed would either spin forever on plain-text mail or show an empty body
   * with no explanation.
   */
  bodyPending: boolean;
  /** Ask for the HTML body of the open message. */
  onLoadBody: () => void;
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
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * Ask for the HTML body when this message does not have one.
   *
   * The store keeps HTML for a recent window and drops it from the rest, so opening
   * something older is the normal case rather than an edge one. Keyed on the message
   * id so holding `j` down the list walks through the fetches rather than re-asking
   * for the first one.
   */
  const emailId = email?.id ?? null;
  const hasHtml = email?.bodyHtml !== undefined;

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
   * `blocked > 0` because a message with no remote references has no trade-off to
   * put to anybody, and an offer with nothing behind it is noise. `askAboutImages`
   * because "never ask again" has to actually mean never — re-asking somebody who
   * already answered is how a preference stops being one.
   */
  const offerImages = email.bodyHtml !== undefined && blocked > 0 && !imagesAllowed && askAboutImages;

  return (
    // `data-reader` so a test can reach the pane as a whole. The header's `<time>`
    // lives outside `<article>`, so "which message is open" cannot be answered from
    // the article alone — and answering it from the article is what made the
    // conversation check compare a subject it knew was identical across all three
    // messages against a timestamp that was never there.
    <div data-reader="" className="flex min-h-0 flex-1 flex-col">
      {/* Mobile-only back bar. On a wide screen the reader is a pane beside the
          list, so closing it would be redundant. */}
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

      {/*
        The header.

        No rule under it. The reader's surface is the same one the message body sits
        on, and a `border-b` here drew a hard line across the pane that the flat
        layout does not otherwise have — the separation is the 20px of padding below
        it and the change in type size, which is enough.
      */}
      <div className="flex items-start gap-3 px-5 pb-4 pt-4">
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
              it is the document's h1 and the sender is subordinate to it.

              A column unless the window is wide enough to afford a row. Six 28px
              icons and a `shrink-0` toolbar need about 200px, and the pane is 37.9%
              of the window — so side by side, the name is what gives way: it read
              "Dana Whitfi…" on a phone and "Dana at North…" at 1100px. The one
              thing you read first, ellipsised to make room for controls you reach
              for later, and the reader's own sender line is the wrong place to be
              stingy.

              1200px rather than `lg` (1024) because `lg` is the width at which the
              pane appears at all, not the width at which it fits: at 1024 the pane
              is 388px, which is exactly the case that needed fixing. At 1200 the
              pane is 455px and the name has its 150px back. */}
          <div className="flex flex-col gap-2.5 min-[1200px]:flex-row min-[1200px]:items-start min-[1200px]:justify-between min-[1200px]:gap-3">
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

            It goes *here* rather than at the bottom of the message, and rather than
            in Settings, because it is a decision about this message that has to be
            made before reading it — and because the thing it governs is not an
            optional extra at the end, it is whether the mail looks like the mail
            the sender sent. The previous version put a bordered card under the
            body, where it read as an attachment notice: something to scroll to
            after you had already decided the message did not need it.

            Three answers, because there are three distinct intentions and a
            two-button offer cannot express the third:

              · **this message** — you opened this one, you want to see it, and you
                have made no claim about the next one;
              · **from now on** — you have decided you trust your mail;
              · **don't ask** — you have decided you would rather read it as text
                and stop being interrupted about it.

            The third is the one the old boolean could not hold, and without it the
            first two were the only available answers, so somebody who wanted plain
            text forever had to decline on every message, forever.
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
            The rich version is on its way.

            Worth saying out loud rather than rendering nothing: the plain text above is
            already complete, so a reader who opens an older message would otherwise
            conclude the message simply had no formatting — when in fact the markup is
            arriving, and the reason it was not resident is that Winnow does not keep
            two thirds of every message in memory for the sake of one open pane.
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
            The message as its sender wrote it.

            **This is the only place in the app where a sender's markup is rendered**,
            and the sandbox is the whole security argument. `sandbox=""` — the empty
            string, with *no token named* — is the most restrictive value the attribute
            can take: no scripts, no forms, no popups, no top-level navigation, no
            plugins, and an opaque origin rather than this app's. Every one of those is
            load-bearing. Adding `allow-same-origin` would hand a message the ability
            to reach `localStorage`, the store and the keybind listener; adding
            `allow-scripts` would let it run code at all. Neither is negotiable for
            "faithful rendering", and neither is needed for it — tables, styles, and
            images all work fine with nothing granted.

            The frame is only ever mounted once `imagesAllowed` is true, and that is
            the second half of the boundary rather than a detail: a sandbox does *not*
            block remote images, so rendering the frame at all would fetch them. The
            offer above is therefore the thing standing between a tracking pixel and
            the sender, and it is a real choice rather than a disclosure that happens
            after the fact. The rule behind `imagesAllowed` is in
            `core/mail/imageConsent`, which is where it is tested.

            All of it sits behind an explicit opt-in because the cost is real and is
            stated on screen — the sender learns the message was opened and roughly
            where — which is why it is off by default and why the text rendering above
            is what most messages get. A toggle that only removed this panel, as it
            used to, was a control that changed nothing and took away the app's own
            explanation of itself.

            `referrerPolicy="no-referrer"` so that even once images are allowed, the
            request does not carry the URL of the message being read.

            `key` on the frame: the document changes when the message does, and a
            reused frame would keep the previous message's scroll position and its
            already-loaded images. The reader is already remounted per selection by
            its parent, so this is belt to those braces.
          */}
          {email.bodyHtml && imagesAllowed && (
            <div className="mt-6 max-w-[68ch]">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-[12px] font-medium text-ink-muted">
                  <EyeOff size={13} strokeWidth={1.9} aria-hidden="true" />
                  {blocked} remote {blocked === 1 ? "thing is" : "things are"} loading · scripts
                  and links are blocked
                </p>
                <button
                  type="button"
                  onClick={actions.onShowOriginal}
                  className="text-[12px] font-medium text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
                className="h-[32rem] w-full rounded-pane bg-surface-sunken"
              />
            </div>
          )}

          {/*
            When images are off *and* the user has said never to ask, there is nothing
            left to say about it — the offer above is suppressed and this one line is
            the whole of it.

            It is here, at the end, rather than at the top with the offer, because it
            is a *status* and not a question: there is no button, so it cannot be the
            first thing in the message, and a card-shaped notice with no action in it
            is the exact shape the redesign is removing. One muted sentence at the
            bottom of a text-only message is enough to explain why it looks like this.
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
            a thread. The list was previously a set of `<span>`s with no handler, so the
            only way to see an earlier message was to find it in the inbox list and open
            it there — and a message that has been archived is not in the inbox list at
            all, so for those it was not reachable at all.

            `focusMessage` is the right entry point rather than a local selection swap:
            it handles the case where the message is not in the current view at all,
            clearing the search and filters that were hiding it.

            Each row leads with the message's own words rather than its subject. In a
            thread the subjects are the same string three times over — `Re: the
            migration plan`, `Re: the migration plan`, `Re: the migration plan` — so the
            column that identifies which message you are about to open was carrying no
            information at all, while the one thing that does differ, "the sort spills",
            "I think I know what is happening", was nowhere on screen. The subject is
            still shown when it genuinely changed, because that *is* information.
          */}
          {/*
            Spacing, not a rule.

            Both of these used to carry a `border-t`, which in a scrolling document
            draws a line across the full measure every time the reader moves to a
            different message with a different number of replies. They are separated
            now by 32–40px and an uppercase micro label, which is enough structure
            without a mark that appears and disappears as the message changes.
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
                  // A different subject is worth a prefix; the same one is noise. And an
                  // empty body — a stub, or a message that was entirely a quote — falls
                  // back to the subject rather than to an empty row.
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
                  );
                })}
              </ul>
            </div>
          )}

          {/*
            The sender-level action, as a footer.

            It was the last thing in the flow, directly under the conversation list,
            styled as a neutral outlined chip. Two problems with that. It reads as part
            of the conversation — a button about the *sender* sitting inside a list of
            *messages*, one tap away from a click that throws away every message from
            that person across every folder. And it inherits the conversation's `mt-8`,
            so when there is no conversation it floats in the middle of the body with
            nothing above it.

            A labelled footer, separated by its own rule, is the standard shape for the
            actions that apply to the message as a whole rather than to its content, and
            it makes the scope legible before the click rather than after.
          */}
          <footer className="mt-10 max-w-[68ch]">
            <h3 className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-subtle">
              This sender
            </h3>
            <p className="mt-1.5 text-preview text-ink-muted">
              Everything from {displayName(email)} disappears from every folder, and you can
              bring it back in Settings.
            </p>
            <button
              type="button"
              onClick={actions.onBlockSender}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-sheen px-3 py-1.5 text-[12.5px] font-medium text-ink-body transition-colors hover:bg-danger-wash hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Ban size={13} strokeWidth={1.9} aria-hidden="true" />
              Hide everything from {displayName(email)}
            </button>
          </footer>
        </article>
      </div>
    </div>
  );
}


