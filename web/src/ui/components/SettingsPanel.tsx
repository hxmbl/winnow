/**
 * Settings, and the reply composer.
 *
 * Two panels in one file because they share the sheet chrome and the escape handling.
 * The learning section exists so "Winnow ranks your mail" is a claim the user can
 * inspect and correct.
 */

import { useEffect, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Sheet, SheetHeader } from "./Overlay";
import { RecipientField } from "./RecipientField";
import { isValidAddress } from "../../core/contacts/addresses";
import type { ContactIndex } from "../../core/contacts/index";
import {
  SIGNAL_KEYS,
  adjustment,
  isPenalty,
  type SignalKey,
  type SignalWeights,
} from "../../core/classify/weights";
import { SORT_OPTIONS, type SortBy } from "../../core/classify/scoring";
import { FILTER_LABELS, type BuiltinSmartFilter } from "../../core/model/signals";
import type { ImagePolicy } from "../../core/store/store";
import { formatRelative } from "../../core/mail/datetime";
import type { FeedbackEvent } from "../../core/learn/learning";

/**
 * The three standing answers about remote images.
 *
 * Order is the order of escalating commitment. `never` is disabled rather than hidden
 * when the host cannot render HTML, because a group of three showing two reads as a
 * layout bug rather than a capability limit.
 */
const IMAGE_POLICY_CHOICES: readonly { value: ImagePolicy; label: string }[] = [
  { value: "ask", label: "Ask each time" },
  { value: "always", label: "Always" },
  { value: "never", label: "Never" },
];

/**
 * How many feedback events the panel lists.
 *
 * The log itself is capped at `MAX_EVENTS`; the panel shows the most recent ones,
 * because those explain the weights as they stand now.
 */
const HISTORY_LIMIT = 100;

/**
 * One event, in a sentence.
 *
 * The bucket name rather than the internal id, so the event log is readable rather
 * than a dump.
 */
function describeEvent(event: FeedbackEvent): string {
  switch (event.action) {
    case "starred":
      return "Starred";
    case "unstarred":
      return "Unstarred";
    case "filter_rejected":
      return event.rejectedFilter
        ? `Hid ${FILTER_LABELS[event.rejectedFilter]}`
        : "Hid a bucket";
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-hairline-soft px-5 py-4 last:border-b-0">
      <h3 className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-subtle">
        {title}
      </h3>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** A labelled row: a name, an explanation, and a control. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink-body">{label}</p>
        {hint && <p className="text-[12px] text-ink-subtle">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

export type SettingsProps = {
  sortBy: SortBy;
  onSortBy: (sort: SortBy) => void;
  appearance: "system" | "light" | "dark";
  onAppearance: (value: "system" | "light" | "dark") => void;
  /**
   * Whether the reader can render a message's own markup at all.
   *
   * True on both hosts; here so a future build that genuinely cannot (a webview
   * without iframe isolation, say) hides the row rather than offering a switch that
   * would do nothing.
   */
  canLoadRemoteContent: boolean;
  /** The standing answer about remote images. See `IMAGE_POLICY_CHOICES`. */
  imagePolicy: ImagePolicy;
  onImagePolicy: (value: ImagePolicy) => void;
  notificationsEnabled: boolean;
  onNotifications: (value: boolean) => void;
  /** Null on the web, where there is no background thread to hand. */
  backgroundSync: boolean | null;
  onBackgroundSync: (value: boolean) => void;
  backgroundSyncInterval: number;
  onBackgroundSyncInterval: (value: number) => void;
  weights: SignalWeights;
  onWeight: (key: SignalKey, value: number) => void;
  adaptive: boolean;
  onAdaptive: (value: boolean) => void;
  onResetWeights: () => void;
  /**
   * The feedback log, **newest first** (`LearningModel.history`). `events` is
   * oldest-first, so slicing that would show the beginning of the log rather than
   * the part that explains the weights on screen.
   */
  events: readonly FeedbackEvent[];
  blockedSenders: readonly string[];
  onUnblock: (sender: string) => void;
  /** Buckets the user has silenced, so a mute can be undone from here too. */
  mutedFilters: readonly BuiltinSmartFilter[];
  onRestoreFilter: (id: BuiltinSmartFilter) => void;
  /** True when the build is a desktop shell, so the OS-only rows make sense. */
  isDesktop: boolean;
  onClose: () => void;
};

/** One weight, with its drift from the default. */
function WeightSlider({
  meta,
  weights,
  value,
  onChange,
}: {
  meta: (typeof SIGNAL_KEYS)[number];
  weights: SignalWeights;
  value: number;
  onChange: (value: number) => void;
}) {
  // Signed, and computed through the shared helper so the panel and the learning
  // loop cannot disagree about what drift means.
  const drift = adjustment(weights, meta.key);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={`weight-${meta.key}`} className="text-[13px] font-medium text-ink-body">
          {meta.label}
        </label>
        <span className="flex items-baseline gap-1.5 text-[12px] tabular-nums">
          <span className="font-semibold text-ink">{value}</span>
          {/*
            The default is only worth saying when the value has moved off it: printed
            unconditionally it read as `22  default 22` — two numbers with no
            indication that they were the same one. With a drift, it answers "where
            did this come from".
          */}
          {drift !== 0 && (
            <>
              <span className="text-ink-subtle">from {meta.defaultValue}</span>
              <span
                className={`font-semibold ${drift > 0 ? "text-success" : "text-ink-muted"}`}
                title="How far your feedback has moved this from the default"
              >
                {drift > 0 ? `+${drift}` : drift}
              </span>
            </>
          )}
        </span>
      </div>
      <input
        id={`weight-${meta.key}`}
        type="range"
        min={meta.min}
        max={meta.max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-describedby={`weight-help-${meta.key}`}
        aria-valuetext={`${value} points, ${meta.label.toLowerCase()}`}
        // `appearance-none` switches `accent-color` off, so the fill is drawn via
        // `--wn-range-fill` — the one thing a range cannot express on its own.
        style={{ "--wn-range-fill": `${((value - meta.min) / (meta.max - meta.min)) * 100}%` } as React.CSSProperties}
        className="wn-range h-1.5 w-full cursor-pointer appearance-none rounded-full"
      />
      <p id={`weight-help-${meta.key}`} className="text-[12px] text-ink-subtle">
        {meta.explanation}
      </p>
    </div>
  );
}

export function Settings(props: SettingsProps) {
  const [showHistory, setShowHistory] = useState(false);

  return (
    <Sheet
      label="Settings"
      onClose={props.onClose}
      // The sheet's body scrolls, not the panel, so the panel is not itself the
      // scroller — which keeps the focus trap's `offsetParent` check meaningful.
      className="flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift"
    >
      <SheetHeader title="Settings" onClose={props.onClose} />
      {/*
        The scroller, with a shadow that says so.

        A `scroll-shadow` on the scroller itself turns the below-the-fold content into
        an obvious cue, and unlike a one-sided fade it also appears at the *top* once
        you have scrolled.

        No wrapper element: `scroll-shadow` paints its own background, so it has to be
        the element that scrolls.
      */}
      <div className="scroll-shadow thin-scroll min-h-0 flex-1 overflow-y-auto">
        <Section title="Reading">
        <Row label="Sort messages by">
          <div className="flex gap-1 rounded-full border border-hairline p-0.5">
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => props.onSortBy(option.id)}
                aria-pressed={props.sortBy === option.id}
                className={`rounded-full px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                  props.sortBy === option.id
                    ? "bg-surface-active text-ink"
                    : "text-ink-muted hover:text-ink-body"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </Row>

        {/*
          Remote images: three states, because there are three intentions.

          This was a toggle, and a toggle has two positions. "Load" and "don't load"
          cannot say the third thing a user actually wants, which is *stop asking* —
          and that is not the same as "never": somebody who has been asked three times
          wants their mail to look like mail.

          A segmented control rather than three buttons because it is one setting with
          three values.
        */}
        <Row
          label="Remote images"
          hint="Images confirm a message was opened and roughly where. Winnow asks per message by default; a message that has images allowed is rendered in a sandbox that runs none of the sender's code."
        >
          <div
            role="radiogroup"
            aria-label="Remote images"
            className="flex items-center gap-0.5 rounded-full bg-sheen p-0.5"
          >
            {IMAGE_POLICY_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={props.imagePolicy === choice.value}
                disabled={!props.canLoadRemoteContent && choice.value !== "never"}
                onClick={() => props.onImagePolicy(choice.value)}
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 ${
                  props.imagePolicy === choice.value
                    ? "bg-surface text-ink shadow-pane"
                    : "text-ink-muted hover:text-ink-body"
                }`}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </Row>

        <Row
          label="Notify me about new mail"
          hint="A system notification, only for messages that arrived since the last sync."
        >
          <Toggle
            checked={props.notificationsEnabled}
            onChange={props.onNotifications}
            label="Notify about new mail"
          />
        </Row>
      </Section>

      {/*
        Appearance, on its own.

        It was the first row under "How Winnow sorts", a heading that makes a claim
        about everything under it — and a claim about the *sort* says nothing about
        light and dark.
      */}
      <Section title="Appearance">
        <Row label="Theme">
          <div
            role="group"
            aria-label="Theme"
            className="flex gap-1 rounded-full border border-hairline p-0.5"
          >
            {(["system", "light", "dark"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => props.onAppearance(option)}
                aria-pressed={props.appearance === option}
                className={`rounded-full px-2.5 py-1 text-[12px] font-semibold capitalize transition-colors ${
                  props.appearance === option
                    ? "bg-surface-active text-ink"
                    : "text-ink-muted hover:text-ink-body"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      {props.isDesktop && props.backgroundSync !== null && (
        <Section title="Background">
          <Row
            label="Keep syncing while closed"
            hint="Winnow stays in the tray and syncs on a timer. With this off it only syncs while a window is open."
          >
            <Toggle
              checked={props.backgroundSync}
              onChange={props.onBackgroundSync}
              label="Keep syncing while closed"
            />
          </Row>
          {props.backgroundSync && (
            <Row label="Check every" hint="Faster means more requests to Google.">
              <select
                value={props.backgroundSyncInterval}
                onChange={(event) =>
                  props.onBackgroundSyncInterval(Number(event.target.value))
                }
                aria-label="Check for new mail every"
                className="rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] font-semibold text-ink-body"
              >
                <option value={60}>Every minute</option>
                <option value={300}>Every 5 minutes</option>
                <option value={900}>Every 15 minutes</option>
                <option value={3600}>Every hour</option>
              </select>
            </Row>
          )}
        </Section>
      )}

      <Section title="How Winnow sorts">
        <Row
          label="Learn from what I star"
          hint="Starring a message nudges the signals it carries. Off means only the sliders below change anything."
        >
          <Toggle
            checked={props.adaptive}
            onChange={props.onAdaptive}
            label="Learn from stars"
          />
        </Row>

        {/*
          The sliders, in a titled sub-block.

          They were directly inside the section's own `flex flex-col gap-3`, which put
          ten sliders in the same visual group as the two toggles above them — so the
          eye read the toggles as the eleventh and twelfth sliders.
        */}
        <div className="mt-1 flex flex-col gap-4 border-t border-hairline-soft pt-4">
          <p className="-mt-1 text-[12px] text-ink-subtle">
            Weights start at these values and move as you star, unstar and hide
            buckets. Adjusting one by hand is always allowed.
          </p>

          {/*
            Ten identical rows in one column is a form dump: the eye has to read all
            ten labels to find the one it wants. Splitting on the one distinction that
            already exists in the model — `isPenalty`, the same function the learning
            loop uses — halves the search space.

            The order inside each group is `SIGNAL_KEYS`'s, by how much the weight
            matters.
          */}
          {([
            {
              title: "Signals that raise importance",
              note: "Points added to a message's score.",
              keys: SIGNAL_KEYS.filter((meta) => !isPenalty(meta.key)),
            },
            {
              title: "Signals that lower it",
              note: "Points taken back off.",
              keys: SIGNAL_KEYS.filter((meta) => isPenalty(meta.key)),
            },
          ]).map((group) =>
            group.keys.length === 0 ? null : (
              <fieldset key={group.title} className="flex flex-col gap-4">
                <legend className="sr-only">{group.title}</legend>
                <div className="-mb-2 flex items-baseline gap-2">
                  <h4 className="text-[12.5px] font-semibold text-ink-body">{group.title}</h4>
                  <p className="text-[12px] text-ink-subtle">{group.note}</p>
                </div>
                {group.keys.map((meta) => (
                  <WeightSlider
                    key={meta.key}
                    meta={meta}
                    weights={props.weights}
                    value={props.weights[meta.key]}
                    onChange={(value) => props.onWeight(meta.key, value)}
                  />
                ))}
              </fieldset>
            ),
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={props.onResetWeights}
            className="inline-flex items-center gap-1.5 rounded-full border border-control-border px-3 py-1.5 text-[12.5px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={() => setShowHistory((value) => !value)}
            aria-expanded={showHistory}
            aria-controls="winnow-learning-history"
            className="rounded-full border border-control-border px-3 py-1.5 text-[12.5px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {showHistory ? "Hide" : "Show"} what I&apos;ve learned
            {props.events.length > 0 && ` (${props.events.length})`}
          </button>
        </div>

        {showHistory && (
          <div
            id="winnow-learning-history"
            className="max-h-64 overflow-y-auto rounded-lg border border-hairline bg-surface-sunken p-2"
          >
            {props.events.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12.5px] text-ink-subtle">
                Nothing yet. Star a message, or hide a filter, and Winnow will record what it
                did and why.
              </p>
            ) : (
              <>
                <ul className="flex flex-col gap-1">
                  {props.events.slice(0, HISTORY_LIMIT).map((event) => (
                    <li
                      key={event.id}
                      className="flex items-baseline justify-between gap-3 px-2 py-1 text-[12px]"
                    >
                      <span className="min-w-0 truncate text-ink-body">
                        {describeEvent(event)}
                        {event.sender && (
                          <span className="text-ink-subtle"> · {event.sender}</span>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums text-ink-subtle">
                        {event.predictedImportance !== undefined
                          ? `predicted ${event.predictedImportance}`
                          : formatRelative(event.at, Date.now())}
                      </span>
                    </li>
                  ))}
                </ul>
                {/*
                  The log is capped at `MAX_EVENTS`, so a long-lived install can have
                  more here than the panel shows. The count on the button is the
                  *total*, so a silent truncation would be a lie.
                */}
                {props.events.length > HISTORY_LIMIT && (
                  <p className="px-2 py-2 text-center text-[11.5px] text-ink-subtle">
                    Showing the {HISTORY_LIMIT} most recent of {props.events.length}. Older
                    entries are kept, but not listed here.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Section>

      {props.blockedSenders.length > 0 && (
        <Section title={`Hidden senders (${props.blockedSenders.length})`}>
          {props.blockedSenders.map((sender) => (
            <Row key={sender} label={sender}>
              <button
                type="button"
                onClick={() => props.onUnblock(sender)}
                className="inline-flex items-center gap-1.5 rounded-full border border-control-border px-3 py-1 text-[12px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                Unhide
              </button>
            </Row>
          ))}
        </Section>
      )}

      {/*
        The muted buckets.

        A second route to unmute, because the rail is a strip that scrolls and a bucket
        muted weeks ago is not something anyone scrolls to look for.
      */}
      {props.mutedFilters.length > 0 && (
        <Section title={`Hidden buckets (${props.mutedFilters.length})`}>
          <p className="-mt-1 text-[12px] text-ink-subtle">
            Not counted or shown in your inbox, and Winnow has learned they were
            over-firing.
          </p>
          {props.mutedFilters.map((id) => (
            <Row key={id} label={FILTER_LABELS[id]}>
              <button
                type="button"
                onClick={() => props.onRestoreFilter(id)}
                className="inline-flex items-center gap-1.5 rounded-full border border-control-border px-3 py-1 text-[12px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                Show again
              </button>
            </Row>
          ))}
        </Section>
      )}
      </div>
    </Sheet>
  );
}

/** A switch. A real checkbox, visually restyled — not a `div` with a click handler. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
        checked ? "bg-[var(--wn-inkBody)]" : "bg-surface-active"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow-pane transition-transform ${
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

export type ComposerProps = {
  /** Reply or forward: the title, and whether a recipient is expected. */
  mode: "reply" | "forward";
  to: readonly string[];
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
  onChange: (patch: { to?: string[]; subject?: string; body?: string }) => void;
  onSend: () => void;
  /** Close, having said the word. No confirmation. */
  onDiscard: () => void;
  /** Close from Escape, the X, or the backdrop. May confirm. */
  onClose: () => void;
};

export function Composer({
  mode,
  to,
  subject,
  body,
  sending,
  error,
  contacts,
  onChange,
  onSend,
  onDiscard,
  onClose,
}: ComposerProps) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  /** `true` until the mount effect has placed the caret. */
  const placed = useRef(false);
  /**
   * A forward with no recipient cannot be sent, and neither can one addressed to something
   * undeliverable — so the button asks about the addresses rather than about their count.
   */
  const canSend = !sending && to.length > 0 && to.every((address) => isValidAddress(address));

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
  useEffect(() => {
    if (placed.current || mode === "forward") return;
    placed.current = true;
    bodyRef.current?.focus();
    bodyRef.current?.setSelectionRange(0, 0);
  }, [mode]);

  const title = mode === "reply" ? "Reply" : "Forward";

  return (
    <Sheet
      label={title}
      onClose={onClose}
      // The composer is not dismissable by clicking away from it. A click just
      // outside a 640px dialog is not "I have decided to abandon this", and it used to
      // destroy a typed reply with no confirmation and no draft kept. Escape and the
      // close button still work, and both go through `onClose`, which *may* confirm.
      dismissOnBackdrop={false}
      initialFocus={mode === "forward" ? toRef : bodyRef}
      className="flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift"
    >
      <SheetHeader title={title} onClose={onClose} />
      <div
        className="thin-scroll min-h-0 flex-1 overflow-y-auto"
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
            if (canSend) onSend();
          }
        }}
      >
      <div className="flex flex-col gap-3 px-5 py-4">
        {/*
          Recipients.

          The plain comma-separated input this replaces let you type an address and could
          not tell you what it had. `RecipientField` turns each one into a chip, suggests
          people from the mail already in the store, and marks an address that cannot be
          delivered — which is the difference between a disabled Send button and a disabled
          Send button you can understand.
        */}
        <RecipientField
          id="winnow-composer-to"
          recipients={to}
          contacts={contacts}
          inputRef={toRef}
          onChange={(next) => onChange({ to: next })}
        />

        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="w-12 shrink-0 text-ink-subtle">Subject</span>
          <input
            type="text"
            aria-label="Subject"
            value={subject}
            onChange={(event) => onChange({ subject: event.target.value })}
            className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus-visible:border-[var(--wn-inkBody)]"
          />
        </div>

        <textarea
          ref={bodyRef}
          aria-label="Message"
          value={body}
          onChange={(event) => onChange({ body: event.target.value })}
          rows={16}
          spellCheck
          className="selectable thin-scroll w-full resize-y rounded-md border border-hairline bg-surface p-3 text-[13.5px] leading-[1.7] text-ink-body outline-none focus-visible:border-[var(--wn-inkBody)]"
        />

        {error && (
          <p role="alert" className="text-[12.5px] font-medium text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onSend}
            // A forward with no recipient is unsendable, and so is one addressed to
            // something undeliverable. A disabled Send is a truthful statement about that,
            // and `title` says why — a greyed-out button with no explanation is its own
            // small puzzle, and the person who cannot work out why has to guess which of
            // their recipients is wrong.
            disabled={!canSend}
            title={
              to.length === 0
                ? "Add at least one recipient"
                : !canSend
                  ? "Fix the recipient that is not an email address"
                  : "Send (⌘ or Ctrl + ⏎)"
            }
            className="inline-flex items-center gap-2 rounded-full bg-[var(--wn-inkBody)] px-4 py-1.5 text-[13px] font-semibold text-[var(--wn-surface)] transition-opacity disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {sending ? "Sending…" : "Send"}
            {!sending && (
              <kbd
                aria-hidden="true"
                className="rounded border border-current/30 px-1 py-px font-mono text-[10.5px] opacity-70"
              >
                ⌘⏎
              </kbd>
            )}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-full border border-control-border px-4 py-1.5 text-[13px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Discard
          </button>
          {/*
            What will actually happen to the quoted text: it is *dropped* when you leave
            it alone and kept when you edit it, so both sentences say what the recipient
            will see.
          */}
          <span className="ml-auto max-w-[19rem] text-right text-[11.5px] leading-snug text-ink-subtle">
            {mode === "reply"
              ? "Winnow adds your text above the quote, and drops the quote if you leave it untouched."
              : "The whole conversation is quoted below, without the reply markers."}
          </span>
        </div>
      </div>
      </div>
    </Sheet>
  );
}
