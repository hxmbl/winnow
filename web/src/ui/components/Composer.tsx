/**
 * The composer: reply, forward and a new message.
 *
 * Moved out of `SettingsPanel.tsx`, where it lived because the two shared the sheet
 * chrome; the chrome is `Overlay.tsx`'s, and the composer has grown its own concerns.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, CalendarClock, ChevronDown, Clock } from "lucide-react";
import { Sheet, SheetHeader } from "./Overlay";
import { Menu } from "./Menu";
import { anchorFromElement, type MenuAnchor, type MenuEntry } from "../menuPlacement";
import { whenPresets } from "../../core/mail/when";
import { RecipientField } from "./RecipientField";
import { normaliseRecipients, recipientProblem } from "../../core/mail/compose";
import { draftStatusLabel, type DraftSaveStatus } from "../../core/mail/drafts";
import type { ContactIndex } from "../../core/contacts/index";
import { buttonClass } from "../button";
import { Icon } from "./Icon";

/** How long a press on the phone's Send circle is held before it opens Send later. */
const SEND_LATER_PRESS_MS = 500;

/** Said in the Send later menu, because nothing on Google's side knows about the schedule. */
export const SEND_LATER_NOTE =
  "Winnow sends it from this device, so it needs to be open at that time. If it's closed, the message goes the next time you open Winnow.";

/** What the composer can change in its draft. */
export type ComposerPatch = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
};

export type ComposerProps = {
  /**
   * Reply, forward or a new message: the title, where the caret starts, and whether a
   * recipient is expected.
   */
  mode: "reply" | "forward" | "new";
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  /** The account the message goes out from, shown on a new message. */
  from?: string | null;
  /**
   * 1.4.0: the signed-in accounts it can go out from, with more than one. A reply starts
   * on the account that received the message; a new message on the open one.
   */
  fromOptions?: readonly { id: string; email: string }[];
  fromId?: string | null;
  onFromChange?: (id: string) => void;
  subject: string;
  body: string;
  quoteBlock?: string;
  sending: boolean;
  error: string | null;
  /**
   * Everyone the mail in the store knows about, for the recipient suggestions.
   *
   * `null` while there is none — an empty mailbox, or the index not having been derived
   * yet — and the field still works, it simply offers nobody.
   */
  contacts: ContactIndex | null;
  /**
   * The Google contacts opt-in, offered under the To field — or `null` where it is not
   * (already granted, the demo, or the web build, where asking would navigate away from
   * the draft).
   */
  improveSuggestions?: { busy: boolean; error: string | null; onClick: () => void } | null;
  onChange: (patch: ComposerPatch) => void;
  /**
   * Send, with the recipients as they stand — including any address typed into a field
   * and not yet turned into a chip, which `onChange` has been given too but which the
   * parent's state may not hold yet when the keyboard sends.
   */
  onSend: (recipients: { to: string[]; cc: string[]; bcc: string[] }) => void;
  /**
   * Send later (1.4.0): schedule with the recipients as they stand, at a preset time, or
   * `"custom"` for "Pick date & time…". Without it the composer offers no Send later.
   */
  onSendLater?: (recipients: { to: string[]; cc: string[]; bcc: string[] }, at: number | "custom") => void;
  /** Close, having said the word. No confirmation. */
  onDiscard: () => void;
  /** Close from Escape, the X, or the backdrop. May confirm. */
  onClose: () => void;
  /**
   * The phone layout: the composer takes the whole screen above the on-screen keyboard
   * (`--wn-keyboard`, see `useKeyboardInset`), under a top bar laid out like iOS Mail's:
   * Cancel at the leading edge, the title (the subject once there is one) in the middle,
   * and Send, an accent circle with an up arrow, at the trailing edge. Nothing that sends
   * or throws the draft away sits in the thumb zone above the keyboard; Cancel on a
   * written draft asks (Delete Draft / Save Draft, an action sheet in `App.tsx`).
   */
  phone?: boolean;
  /**
   * Docked at the bottom of the reader pane (desktop reply and forward) instead of a
   * centred sheet: the conversation above stays readable and scrollable while writing.
   * Not modal — no backdrop, no focus trap — so its Escape is handled here.
   */
  docked?: boolean;
  /** Reply all (default) or Reply. With `onReplyAllChange`, a reply shows the toggle. */
  replyAll?: boolean;
  onReplyAllChange?: (replyAll: boolean) => void;
  /** The autosave's state, said in the header. */
  saveStatus?: DraftSaveStatus;
  /** "Drafts need permission": ask for it (incremental consent). */
  onAllowDrafts?: (() => void) | null;
  allowingDrafts?: boolean;
  /** The attachment area (`ComposerAttachments`), under the message. */
  attachments?: ReactNode;
  /** Files dropped on the composer (desktop). Without it the composer takes no drops. */
  onFiles?: (files: File[]) => void;
};

/** Whether a drag carries files (not text or a link dragged out of the message). */
function carriesFiles(event: React.DragEvent): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

/** Reply / Reply all: two pressed-state buttons, because both choices are always visible. */
function ReplyAllToggle({ replyAll, onChange }: { replyAll: boolean; onChange: (replyAll: boolean) => void }) {
  const option = (value: boolean, label: string) => (
    <button
      type="button"
      aria-pressed={replyAll === value}
      data-reply-all={value ? "all" : "one"}
      onClick={() => onChange(value)}
      className={`rounded-ctl px-2 py-0.5 text-meta font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-9 ${
        replyAll === value ? "bg-surface-active text-ink" : "text-ink-subtle hover:bg-surface-hover hover:text-ink-body"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Reply to" className="flex shrink-0 items-center gap-0.5 rounded-ctl border border-hairline p-0.5">
      {option(false, "Reply")}
      {option(true, "Reply all")}
    </div>
  );
}

/** "Saving…", "Saved", "Couldn't save", or "Drafts need permission" with its button. */
function DraftStatus({
  status,
  onAllow,
  allowing,
}: {
  status: DraftSaveStatus;
  onAllow?: (() => void) | null;
  allowing?: boolean;
}) {
  const label = draftStatusLabel(status);
  return (
    <span className="ml-auto flex min-w-0 items-center gap-1.5 text-meta">
      <span
        data-draft-status={status.kind}
        role="status"
        aria-live="polite"
        title={status.kind === "error" ? status.message : undefined}
        className={`truncate ${status.kind === "error" ? "font-medium text-danger" : "text-ink-subtle"}`}
      >
        {label}
      </span>
      {status.kind === "permission" && onAllow && (
        <button
          type="button"
          data-allow-drafts=""
          onClick={onAllow}
          disabled={allowing}
          className="shrink-0 rounded-ctl px-1.5 py-0.5 font-medium text-accent underline-offset-2 hover:underline disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {allowing ? "Waiting for Google…" : "Allow"}
        </button>
      )}
    </span>
  );
}

export function Composer({
  mode,
  to,
  cc = [],
  bcc = [],
  from = null,
  fromOptions = [],
  fromId = null,
  onFromChange,
  subject,
  body,
  sending,
  error,
  contacts,
  improveSuggestions,
  onChange,
  onSend,
  onSendLater,
  onDiscard,
  onClose,
  phone = false,
  docked = false,
  replyAll = true,
  onReplyAllChange,
  saveStatus = { kind: "idle" },
  onAllowDrafts = null,
  allowingDrafts = false,
  attachments = null,
  onFiles,
}: ComposerProps) {
  /** Files are being dragged over the composer: the drop hint is up. */
  const [dropping, setDropping] = useState(false);
  /** Nested `dragenter`/`dragleave` pairs, so crossing a child does not drop the hint. */
  const dragDepth = useRef(0);
  const dropProps = onFiles && !phone
    ? {
        onDragEnter: (event: React.DragEvent) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDropping(true);
        },
        onDragOver: (event: React.DragEvent) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (event: React.DragEvent) => {
          if (!carriesFiles(event)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropping(false);
        },
        onDrop: (event: React.DragEvent) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDropping(false);
          onFiles([...event.dataTransfer.files]);
        },
      }
    : {};
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const ccRef = useRef<HTMLInputElement>(null);
  const bccRef = useRef<HTMLInputElement>(null);
  /** `true` until the mount effect has placed the caret. */
  const placed = useRef(false);
  /**
   * Cc and Bcc, revealed on demand: most mail has neither, and two empty rows on every
   * draft push the body down for the rare one that does. Open from the start when the
   * draft already has someone there (a `mailto:` with `cc=`).
   */
  const [showCopies, setShowCopies] = useState(cc.length > 0 || bcc.length > 0);
  /** What is typed in each field and not yet a chip. See `RecipientField.query`. */
  const [pending, setPending] = useState({ to: "", cc: "", bcc: "" });
  /** Set when a send was refused, so the reason is said in place rather than in a tooltip. */
  const [attempted, setAttempted] = useState(false);

  /** The recipients with anything still typed in a field folded in, as Send would see them. */
  const recipients = {
    to: [...to, ...normaliseRecipients([pending.to])].filter((v, i, all) => all.indexOf(v) === i),
    cc: [...cc, ...normaliseRecipients([pending.cc])].filter((v, i, all) => all.indexOf(v) === i),
    bcc: [...bcc, ...normaliseRecipients([pending.bcc])].filter((v, i, all) => all.indexOf(v) === i),
  };
  /**
   * Nobody to send to, or somebody who is not an address. Either one stops Send — a
   * forward with no recipient cannot be sent, and neither can a message addressed to
   * something undeliverable.
   */
  const problem = recipientProblem(recipients);
  const canSend = !sending && problem === null;

  /** Send if the recipients allow it; otherwise say why, beside the fields. */
  const trySend = () => {
    if (sending) return;
    if (problem !== null) {
      setAttempted(true);
      return;
    }
    const typed = pending.to.trim() !== "" || pending.cc.trim() !== "" || pending.bcc.trim() !== "";
    if (typed) {
      onChange(recipients);
      setPending({ to: "", cc: "", bcc: "" });
    }
    onSend(recipients);
  };

  /** The Send later menu, open beside its button (or the phone's Send circle). */
  const [laterMenu, setLaterMenu] = useState<{ anchor: MenuAnchor; trigger: HTMLElement } | null>(null);
  const openLater = (trigger: HTMLElement) => {
    if (sending || !onSendLater) return;
    if (problem !== null) {
      setAttempted(true);
      return;
    }
    setLaterMenu({ anchor: anchorFromElement(trigger), trigger });
  };
  /** Schedule, with the same recipient rules as Send. */
  const trySendLater = (at: number | "custom") => {
    if (sending || !onSendLater || problem !== null) return;
    const typed = pending.to.trim() !== "" || pending.cc.trim() !== "" || pending.bcc.trim() !== "";
    if (typed) {
      onChange(recipients);
      setPending({ to: "", cc: "", bcc: "" });
    }
    onSendLater(recipients, at);
  };
  const laterItems = (): MenuEntry[] => [
    ...whenPresets(Date.now()).map((preset) => ({
      kind: "item" as const,
      id: `later-${preset.id}`,
      label: preset.label,
      hint: preset.detail,
      onSelect: () => trySendLater(preset.at),
    })),
    { kind: "divider", id: "later-d" },
    { kind: "item", id: "later-custom", label: "Pick date & time…", icon: CalendarClock, onSelect: () => trySendLater("custom") },
  ];
  /** A long press on the phone's Send circle opens Send later instead of sending. */
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressFired = useRef(false);
  const longPress = onSendLater
    ? {
        onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
          pressFired.current = false;
          const target = event.currentTarget;
          if (pressTimer.current) clearTimeout(pressTimer.current);
          pressTimer.current = setTimeout(() => {
            pressFired.current = true;
            openLater(target);
          }, SEND_LATER_PRESS_MS);
        },
        onPointerUp: () => {
          if (pressTimer.current) clearTimeout(pressTimer.current);
        },
        onPointerLeave: () => {
          if (pressTimer.current) clearTimeout(pressTimer.current);
        },
        onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          openLater(event.currentTarget);
        },
        /** The click that ends a long press is not a Send. */
        swallowClick: () => {
          const fired = pressFired.current;
          pressFired.current = false;
          return fired;
        },
      }
    : null;
  const laterMenuElement = laterMenu && onSendLater && (
    <Menu
      testId="send-later"
      label="Send later"
      anchor={laterMenu.anchor}
      returnFocus={laterMenu.trigger}
      onClose={() => setLaterMenu(null)}
      header={
        <span data-send-later-note="" className="block max-w-68 text-meta leading-snug text-ink-muted">
          {SEND_LATER_NOTE}
        </span>
      }
      items={laterItems()}
    />
  );

  /*
    Focus and caret placement, once per *mount*.

    This used to depend on `body.length`, so every keystroke re-ran it and reset the
    caret to the start — which means `hello` came out as `olleh`. `placed` makes it
    once-only without an empty dependency array that would be a lie about what this
    depends on.

    The intent is still to put the caret at the *top* of the body, above the quote, so
    what the user types goes above what is being replied to.

    **A forward does not touch the body at all.** `Sheet` focuses the To field for a
    forward (`initialFocus`), and React fires a child's effects before its parent's, so
    this immediately stole it for the textarea. Deciding *which* field you start in
    belongs to `Sheet`, and the two must not both answer it.
  */
  /*
    A new message starts in To, like a forward — unless it already has someone to send
    to (a `mailto:` link), in which case the next thing to write is the message.
  */
  // Decided once, as the sheet opens: adding the first recipient must not then move the
  // caret to the body.
  const [startsInTo] = useState(() => mode === "forward" || (mode === "new" && to.length === 0));

  useEffect(() => {
    if (placed.current) return;
    if (startsInTo) {
      // The sheet's `initialFocus` places a forward's caret; docked there is no sheet.
      if (docked) toRef.current?.focus();
      placed.current = true;
      return;
    }
    placed.current = true;
    bodyRef.current?.focus();
    bodyRef.current?.setSelectionRange(0, 0);
  }, [startsInTo, docked]);

  const title = mode === "reply" ? "Reply" : mode === "forward" ? "Forward" : "New message";
  /** The phone bar's title, as iOS Mail's: the subject once there is one. */
  const phoneTitle = subject.trim() !== "" ? subject.trim() : mode === "new" ? "New Message" : title;
  /*
    What will actually happen to the quoted text: it is *dropped* when you leave it alone
    and kept when you edit it, so both sentences say what the recipient will see.
  */
  const hint =
    mode === "reply"
      ? "Winnow adds your text above the quote, and drops the quote if you leave it untouched."
      : mode === "forward"
        ? "The whole conversation is quoted below, without the reply markers."
        : "";
  const sendTitle =
    problem === "none"
      ? "Add at least one recipient"
      : problem === "invalid"
        ? "Fix the recipient that is not an email address"
        : "Send (⌘ or Ctrl + ⏎)";

  const copiesToggle = showCopies ? null : (
    <button
      type="button"
      data-show-copies=""
      onClick={() => {
        setShowCopies(true);
        // Straight into the field that was asked for; the effect is a frame late.
        requestAnimationFrame(() => ccRef.current?.focus());
      }}
      title="Add Cc and Bcc recipients"
      className="mt-1 shrink-0 rounded-ctl px-1.5 py-1 text-meta font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink-body focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-10"
    >
      Cc/Bcc
    </button>
  );

  const content = (
    <>
      <div
        data-composer={mode}
        {...dropProps}
        data-dropping={dropping ? "" : undefined}
        className={`thin-scroll relative min-h-0 flex-1 overflow-y-auto ${phone ? "flex flex-col" : ""}`}
        onKeyDown={(event) => {
          /*
            Send from the keyboard.

            ⌘⏎ / Ctrl⏎ is what every mail client on every platform accepts for this, and
            without it a reply is mouse-only. It cannot live in `keybinds.ts` — the
            composer's keys are a hard stop there, because every one of them belongs to
            the field the user is typing into.

            Guarded on the same condition as the button, and `preventDefault`ed so the
            textarea does not also insert a newline.
          */
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            trySend();
          }
        }}
      >
      <div className={phone ? "flex flex-1 flex-col gap-3 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3" : "flex flex-col gap-3 px-5 py-4"}>
        {/*
          Recipients.

          The plain comma-separated input this replaces let you type an address and could
          not tell you what it had. `RecipientField` turns each one into a chip, suggests
          people from the mail already in the store, and marks an address that cannot be
          delivered — which is the difference between a disabled Send button and a disabled
          Send button you can understand.
        */}
        {fromOptions.length > 1 && onFromChange ? (
          <div className="flex items-center gap-2 text-meta">
            <label htmlFor="winnow-composer-from" className="w-(--wn-composer-label) shrink-0 text-ink-subtle">
              From
            </label>
            <select
              id="winnow-composer-from"
              data-composer-from-picker=""
              value={fromId ?? fromOptions[0].id}
              onChange={(event) => onFromChange(event.target.value)}
              className="min-w-0 flex-1 truncate rounded-ctl bg-transparent px-1 text-ui text-ink-body focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {fromOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.email}
                </option>
              ))}
            </select>
          </div>
        ) : mode === "new" && from && (
          <div className="flex items-center gap-2 text-meta">
            <span className="w-(--wn-composer-label) shrink-0 text-ink-subtle">From</span>
            <span data-composer-from="" className="selectable min-w-0 truncate px-1 text-ui text-ink-body">
              {from}
            </span>
          </div>
        )}

        <RecipientField
          id="winnow-composer-to"
          recipients={to}
          contacts={contacts}
          inputRef={toRef}
          query={pending.to}
          onQueryChange={(query) => setPending((current) => ({ ...current, to: query }))}
          onChange={(next) => onChange({ to: next })}
          trailing={copiesToggle}
        />

        {showCopies && (
          <>
            <RecipientField
              id="winnow-composer-cc"
              label="Cc"
              recipients={cc}
              contacts={contacts}
              inputRef={ccRef}
              query={pending.cc}
              onQueryChange={(query) => setPending((current) => ({ ...current, cc: query }))}
              onChange={(next) => onChange({ cc: next })}
            />
            <RecipientField
              id="winnow-composer-bcc"
              label="Bcc"
              recipients={bcc}
              contacts={contacts}
              inputRef={bccRef}
              query={pending.bcc}
              onQueryChange={(query) => setPending((current) => ({ ...current, bcc: query }))}
              onChange={(next) => onChange({ bcc: next })}
            />
          </>
        )}

        {attempted && problem === "none" && (
          <p id="winnow-composer-recipients-error" role="alert" className="-mt-1 pl-[calc(var(--wn-composer-label)+0.5rem)] text-meta font-medium text-danger">
            Add at least one recipient.
          </p>
        )}

        {improveSuggestions && (
          <div className="-mt-1 flex flex-col gap-1 pl-[calc(var(--wn-composer-label)+0.5rem)] text-meta">
            <button
              type="button"
              onClick={improveSuggestions.onClick}
              disabled={improveSuggestions.busy}
              className="self-start text-ink-subtle underline-offset-2 transition-colors hover:text-ink-body hover:underline disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {improveSuggestions.busy
                ? "Waiting for Google…"
                : "Improve suggestions from Google contacts"}
            </button>
            {improveSuggestions.error && (
              <p role="alert" className="font-medium text-danger">
                {improveSuggestions.error}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 text-meta">
          <span className="w-(--wn-composer-label) shrink-0 text-ink-subtle">Subject</span>
          <input
            type="text"
            aria-label="Subject"
            value={subject}
            onChange={(event) => onChange({ subject: event.target.value })}
            className="min-w-0 flex-1 rounded-ctl border border-hairline bg-surface px-4 py-1.5 text-ui text-ink outline-hidden focus-visible:border-accent max-sm:min-h-10 max-sm:text-read"
          />
        </div>

        <textarea
          ref={bodyRef}
          aria-label="Message"
          value={body}
          onChange={(event) => onChange({ body: event.target.value })}
          // Shorter on a new message, which has From and may have Cc and Bcc above it, so
          // Send stays inside the sheet on a 900px window rather than below its fold.
          rows={phone ? 8 : docked ? 6 : mode === "new" ? 12 : 16}
          spellCheck
          className={`selectable thin-scroll w-full rounded-pane border border-hairline bg-surface p-3 text-ink-body outline-hidden focus-visible:border-accent ${
            // 16px on a phone: iOS zooms into any focused field smaller than that.
            phone ? "min-h-40 flex-1 resize-none text-read" : "resize-y text-ui"
          }`}
        />

        {attachments}

        {error && (
          <p role="alert" className="text-meta font-medium text-danger">
            {error}
          </p>
        )}

        {!phone && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-stretch gap-px">
          <button
            type="button"
            onClick={trySend}
            // A forward with no recipient is unsendable, and so is one addressed to
            // something undeliverable. A disabled Send is a truthful statement about that,
            // and `title` says why — a greyed-out button with no explanation is its own
            // small puzzle, and the person who cannot work out why has to guess which of
            // their recipients is wrong.
            disabled={!canSend}
            title={sendTitle}
            className={buttonClass("primary", "md", "gap-2")}
          >
            {sending ? "Sending…" : "Send"}
            {!sending && (
              <kbd
                aria-hidden="true"
                className="rounded-ctl border border-current/30 px-1 py-px font-mono text-meta opacity-70"
              >
                ⌘⏎
              </kbd>
            )}
          </button>
          {onSendLater && (
            <button
              type="button"
              data-send-later=""
              aria-haspopup="menu"
              aria-expanded={laterMenu !== null}
              aria-label="Send later"
              title="Send later…"
              disabled={!canSend}
              onClick={(event) => openLater(event.currentTarget)}
              className="inline-flex items-center rounded-ctl bg-accent px-2 text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Icon icon={ChevronDown} size={16} />
            </button>
          )}
          </span>
          <button
            type="button"
            onClick={onDiscard}
            className={buttonClass("secondary")}
          >
            Discard
          </button>
          <span className="ml-auto max-w-76 text-right text-meta leading-snug text-ink-subtle">
            {hint}
          </span>
        </div>
        )}
        {phone && hint && (
          <p className="text-meta leading-snug text-ink-subtle">{hint}</p>
        )}
      </div>
      {laterMenuElement}
      {dropping && (
        <div
          aria-hidden="true"
          data-drop-hint=""
          className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-pane border-2 border-dashed border-accent bg-chrome text-ui font-semibold text-accent"
        >
          Drop files to attach
        </div>
      )}
      </div>
    </>
  );

  const headerControls = (
    <>
      {mode === "reply" && onReplyAllChange && <ReplyAllToggle replyAll={replyAll} onChange={onReplyAllChange} />}
      <DraftStatus status={saveStatus} onAllow={onAllowDrafts} allowing={allowingDrafts} />
    </>
  );

  if (docked) {
    return (
      <section
        data-composer-dock=""
        aria-label={title}
        // Docked under the conversation: at most half the pane, scrolling inside itself,
        // so the message above keeps its own scroll and stays readable while writing.
        className="flex max-h-[50%] min-h-0 shrink-0 flex-col border-t border-hairline bg-chrome shadow-lift"
        onKeyDown={(event) => {
          // Not a modal, so no `Sheet` handles Escape: closing goes through `onClose`,
          // which asks when there is something to lose. A recipient list that is open
          // consumed its own Escape already (`RecipientField`).
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.stopPropagation();
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-hairline-soft px-4 py-2">
          <h2 className="shrink-0 text-ui font-semibold text-ink">{title}</h2>
          <div className="flex min-w-0 flex-1 items-center gap-2">{headerControls}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {content}
      </section>
    );
  }

  return (
    <Sheet
      label={title}
      onClose={onClose}
      // The composer is not dismissable by clicking away from it. A click just
      // outside a 640px dialog is not "I have decided to abandon this", and it used to
      // destroy a typed reply with no confirmation and no draft kept. Escape and the
      // close button still work, and both go through `onClose`, which *may* confirm.
      dismissOnBackdrop={false}
      initialFocus={startsInTo ? toRef : bodyRef}
      placement={phone ? "fill" : "center"}
      className={
        phone
          ? "flex h-[calc(100dvh-var(--wn-keyboard,0px))] w-full flex-col overflow-hidden bg-chrome"
          : "flex max-h-(--wn-sheet-max-h) w-full max-w-sheet-lg flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift"
      }
    >
      {phone ? (
        <>
          <PhoneComposerBar
            title={phoneTitle}
            onCancel={onClose}
            onSend={() => {
              if (longPress?.swallowClick()) return;
              trySend();
            }}
            canSend={canSend}
            sending={sending}
            sendTitle={sendTitle}
            onSendLater={onSendLater ? openLater : undefined}
            sendPress={longPress ?? undefined}
          />
          {(mode === "reply" && onReplyAllChange) || draftStatusLabel(saveStatus) !== null ? (
            <div data-composer-status="" className="flex shrink-0 items-center gap-2 px-4 pt-2">
              {headerControls}
            </div>
          ) : null}
        </>
      ) : (
        <SheetHeader title={title} onClose={onClose} touch={phone}>
          {headerControls}
        </SheetHeader>
      )}
      {content}
    </Sheet>
  );
}

/**
 * The phone composer's top bar, after iOS Mail: Cancel leading, the title centred, Send
 * trailing as an accent circle with an up arrow (disabled, and saying why in its title,
 * until the recipients are sendable). In the top bar rather than above the keyboard, so
 * neither sending nor throwing the draft away is one stray thumb away. Clear of the
 * status bar (`safe-area-inset-top`); 44px targets.
 */
function PhoneComposerBar({
  title,
  onCancel,
  onSend,
  canSend,
  sending,
  sendTitle,
  onSendLater,
  sendPress,
}: {
  title: string;
  onCancel: () => void;
  onSend: () => void;
  canSend: boolean;
  sending: boolean;
  sendTitle: string;
  /** Send later: the clock beside Send (and a long press on Send) opens its menu. */
  onSendLater?: (trigger: HTMLElement) => void;
  sendPress?: {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
  };
}) {
  return (
    <div
      data-composer-bar=""
      className="sticky top-0 z-10 grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-2 border-b border-hairline bg-chrome pb-1.5 pl-1.5 pr-2 pt-[max(0.375rem,env(safe-area-inset-top))]"
    >
      <button
        type="button"
        data-composer-cancel=""
        onClick={onCancel}
        className="flex h-11 items-center justify-self-start rounded-ctl px-3 text-read text-accent transition-colors active:bg-sheen focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Cancel
      </button>
      <h2 data-composer-title="" className="min-w-0 truncate text-center text-read font-semibold text-ink">
        {title}
      </h2>
      <span className="flex items-center justify-self-end">
      {onSendLater && (
        <button
          type="button"
          data-composer-send-later=""
          aria-haspopup="menu"
          aria-label="Send later"
          title="Send later (or hold Send)"
          disabled={!canSend}
          onClick={(event) => onSendLater(event.currentTarget)}
          className="flex h-11 w-11 items-center justify-center rounded-ctl text-accent transition-colors active:bg-sheen disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Icon icon={Clock} size={20} />
        </button>
      )}
      <button
        type="button"
        data-composer-send=""
        onClick={onSend}
        disabled={!canSend}
        title={sendTitle}
        onPointerDown={sendPress?.onPointerDown}
        onPointerUp={sendPress?.onPointerUp}
        onPointerLeave={sendPress?.onPointerLeave}
        onContextMenu={sendPress?.onContextMenu}
        className="group flex h-11 w-11 items-center justify-center rounded-ctl [-webkit-touch-callout:none] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span
          aria-hidden="true"
          className={`flex h-8 w-8 items-center justify-center rounded-ctl bg-accent text-on-accent transition-opacity group-disabled:opacity-40 ${
            sending ? "animate-pulse" : ""
          }`}
        >
          <Icon icon={ArrowUp} size={20} />
        </span>
        <span className="sr-only">{sending ? "Sending…" : "Send"}</span>
      </button>
      </span>
    </div>
  );
}
