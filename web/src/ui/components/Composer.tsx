/**
 * The composer: reply, forward and a new message.
 *
 * Moved out of `SettingsPanel.tsx`, where it lived because the two shared the sheet
 * chrome; the chrome is `Overlay.tsx`'s, and the composer has grown its own concerns.
 */

import { useEffect, useRef, useState } from "react";
import { Sheet, SheetHeader } from "./Overlay";
import { RecipientField } from "./RecipientField";
import { normaliseRecipients, recipientProblem } from "../../core/mail/compose";
import type { ContactIndex } from "../../core/contacts/index";

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
  /** Close, having said the word. No confirmation. */
  onDiscard: () => void;
  /** Close from Escape, the X, or the backdrop. May confirm. */
  onClose: () => void;
  /**
   * The phone layout: the composer takes the whole screen above the on-screen keyboard
   * (`--wn-keyboard`, see `useKeyboardInset`), and Send and Discard sit in a bar at its
   * bottom edge — which, with the keyboard up, is directly above it.
   */
  phone?: boolean;
};

export function Composer({
  mode,
  to,
  cc = [],
  bcc = [],
  from = null,
  subject,
  body,
  sending,
  error,
  contacts,
  improveSuggestions,
  onChange,
  onSend,
  onDiscard,
  onClose,
  phone = false,
}: ComposerProps) {
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
    if (placed.current || startsInTo) return;
    placed.current = true;
    bodyRef.current?.focus();
    bodyRef.current?.setSelectionRange(0, 0);
  }, [startsInTo]);

  const title = mode === "reply" ? "Reply" : mode === "forward" ? "Forward" : "New message";
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
      className="mt-1 shrink-0 rounded-ctl px-1.5 py-1 text-meta font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-10"
    >
      Cc/Bcc
    </button>
  );

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
          : "flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift"
      }
    >
      <SheetHeader title={title} onClose={onClose} touch={phone} />
      <div
        className={`thin-scroll min-h-0 flex-1 overflow-y-auto ${phone ? "flex flex-col" : ""}`}
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
      <div className={phone ? "flex flex-1 flex-col gap-3 px-4 py-3" : "flex flex-col gap-3 px-5 py-4"}>
        {/*
          Recipients.

          The plain comma-separated input this replaces let you type an address and could
          not tell you what it had. `RecipientField` turns each one into a chip, suggests
          people from the mail already in the store, and marks an address that cannot be
          delivered — which is the difference between a disabled Send button and a disabled
          Send button you can understand.
        */}
        {mode === "new" && from && (
          <div className="flex items-center gap-2 text-meta">
            <span className="w-12 shrink-0 text-ink-subtle">From</span>
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
          <p id="winnow-composer-recipients-error" role="alert" className="-mt-1 pl-14 text-meta font-medium text-danger">
            Add at least one recipient.
          </p>
        )}

        {improveSuggestions && (
          <div className="-mt-1 flex flex-col gap-1 pl-14 text-meta">
            <button
              type="button"
              onClick={improveSuggestions.onClick}
              disabled={improveSuggestions.busy}
              className="self-start text-ink-subtle underline-offset-2 transition-colors hover:text-ink-body hover:underline disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
          <span className="w-12 shrink-0 text-ink-subtle">Subject</span>
          <input
            type="text"
            aria-label="Subject"
            value={subject}
            onChange={(event) => onChange({ subject: event.target.value })}
            className="min-w-0 flex-1 rounded-ctl border border-hairline bg-surface px-2.5 py-1.5 text-ui text-ink outline-none focus-visible:border-accent max-sm:min-h-10 max-sm:text-read"
          />
        </div>

        <textarea
          ref={bodyRef}
          aria-label="Message"
          value={body}
          onChange={(event) => onChange({ body: event.target.value })}
          // Shorter on a new message, which has From and may have Cc and Bcc above it, so
          // Send stays inside the sheet on a 900px window rather than below its fold.
          rows={phone ? 8 : mode === "new" ? 12 : 16}
          spellCheck
          className={`selectable thin-scroll w-full rounded-ctl border border-hairline bg-surface p-3 leading-[1.7] text-ink-body outline-none focus-visible:border-accent ${
            // 16px on a phone: iOS zooms into any focused field smaller than that.
            phone ? "min-h-[10rem] flex-1 resize-none text-read" : "resize-y text-ui"
          }`}
        />

        {error && (
          <p role="alert" className="text-meta font-medium text-danger">
            {error}
          </p>
        )}

        {!phone && (
        <div className="flex flex-wrap items-center gap-2">
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
            className="inline-flex items-center gap-2 rounded-ctl bg-accent px-4 py-1.5 text-ui font-semibold text-on-accent transition-opacity disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-ctl border border-control-border px-4 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Discard
          </button>
          <span className="ml-auto max-w-[19rem] text-right text-meta leading-snug text-ink-subtle">
            {hint}
          </span>
        </div>
        )}
        {phone && hint && (
          <p className="text-meta leading-snug text-ink-subtle">{hint}</p>
        )}
      </div>
      </div>
      {/*
        The phone's action bar: outside the scroller, so it stays put at the bottom of the
        sheet — directly above the keyboard when it is up. Discard on the left and Send
        under the right thumb, both 44px tall.
      */}
      {phone && (
        <div className="flex shrink-0 items-center gap-2 bg-canvas px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
          <button
            type="button"
            onClick={onDiscard}
            className="h-11 rounded-ctl bg-sheen px-5 text-ui font-semibold text-ink-body transition-colors active:bg-surface-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={trySend}
            disabled={!canSend}
            title={sendTitle}
            className="h-11 flex-1 rounded-ctl bg-accent px-5 text-ui font-semibold text-on-accent transition-opacity disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
