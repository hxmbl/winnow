/**
 * Settings, and the reply composer.
 *
 * Two panels in one file because they share the sheet chrome and the escape
 * handling, and because splitting them would mean two files each re-deciding
 * what a modal is.
 *
 * The interesting part of this screen is the learning section. It exists at all
 * because "Winnow ranks your mail" is a claim, and a claim the user cannot
 * inspect or correct is not one they can trust. So every weight is a slider with
 * its default shown, the *drift* from that default is displayed, and the event
 * log is one click away. A user who thinks the ranking is wrong can see exactly
 * which signal is responsible and move it.
 */

import { useEffect, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Sheet, SheetHeader } from "./Overlay";
import {
  SIGNAL_KEYS,
  adjustment,
  type SignalKey,
  type SignalWeights,
} from "../../core/classify/weights";
import { SORT_OPTIONS, type SortBy } from "../../core/classify/scoring";
import { FILTER_LABELS, type BuiltinSmartFilter } from "../../core/model/signals";
import { formatRelative } from "../../core/mail/datetime";
import type { FeedbackEvent } from "../../core/learn/learning";

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
   * True on both hosts — the reader puts the sender's HTML in a `sandbox=""` iframe,
   * which loads its images without running a line of it. The flag is here so a future
   * build that genuinely cannot (a webview without iframe isolation, say) hides the
   * row rather than offering a switch that would do nothing.
   */
  canLoadRemoteContent: boolean;
  loadRemoteContent: boolean;
  onLoadRemoteContent: (value: boolean) => void;
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
  // Signed, so the badge answers "tuned up or tuned down" rather than just "how
  // far". Computed through the shared helper so the panel and the learning loop
  // cannot disagree about what drift means.
  const drift = adjustment(weights, meta.key);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={`weight-${meta.key}`} className="text-[13px] font-medium text-ink-body">
          {meta.label}
        </label>
        <span className="flex items-baseline gap-1.5 text-[12px] tabular-nums">
          <span className="font-semibold text-ink">{value}</span>
          <span className="text-ink-subtle">default {meta.defaultValue}</span>
          {drift !== 0 && (
            <span
              className={`font-semibold ${drift > 0 ? "text-success" : "text-ink-muted"}`}
              title="How far your feedback has moved this from the default"
            >
              {drift > 0 ? `+${drift}` : drift}
            </span>
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
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-active accent-[var(--wn-inkBody)]"
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
      // The sheet scrolled its own body, not the panel, so the panel is not itself the
      // scroller — which keeps the focus trap's `offsetParent` check meaningful.
      className="flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift"
    >
      <SheetHeader title="Settings" onClose={props.onClose} />
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
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

        <Row
          label="Load remote images"
          hint="Off by default: an image confirms the message was opened and roughly where. On, messages are rendered in a sandbox that runs none of the sender's code."
        >
          <Toggle
            checked={props.canLoadRemoteContent && props.loadRemoteContent}
            onChange={props.onLoadRemoteContent}
            label="Load remote images"
          />
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
        <Row label="Appearance">
          <div className="flex gap-1 rounded-full border border-hairline p-0.5">
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

        <div className="mt-1 flex flex-col gap-4">
          {SIGNAL_KEYS.map((meta) => (
            <WeightSlider
              key={meta.key}
              meta={meta}
              weights={props.weights}
              value={props.weights[meta.key]}
              onChange={(value) => props.onWeight(meta.key, value)}
            />
          ))}
        </div>

        <div className="flex gap-2">
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
            className="rounded-full border border-control-border px-3 py-1.5 text-[12.5px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {showHistory ? "Hide" : "Show"} what I've learned ({props.events.length})
          </button>
        </div>

        {showHistory && (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-hairline bg-surface-sunken p-2">
            {props.events.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12.5px] text-ink-subtle">
                Nothing yet. Star a message, or hide a filter, and Winnow will record what it
                did and why.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {props.events.slice(0, 100).map((event) => (
                  <li
                    key={event.id}
                    className="flex items-baseline justify-between gap-3 px-2 py-1 text-[12px]"
                  >
                    <span className="min-w-0 truncate text-ink-body">
                      {event.action === "starred" && "Starred"}
                      {event.action === "unstarred" && "Unstarred"}
                      {event.action === "filter_rejected" &&
                        `Hid ${event.rejectedFilter ?? "a filter"}`}
                      {event.sender && <span className="text-ink-subtle"> · {event.sender}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums text-ink-subtle">
                      {event.predictedImportance !== undefined
                        ? `predicted ${event.predictedImportance}`
                        : formatRelative(event.at, Date.now())}
                    </span>
                  </li>
                ))}
              </ul>
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

        The rail also carries them, struck through, with a restore control on each — so
        this section is a second route rather than the only one. It exists because the
        rail is a strip that scrolls, and a bucket muted weeks ago is not something
        anyone scrolls to look for. A setting you cannot find is a setting you have to
        remember, and what would have to be remembered here is "which bucket did I
        kill".
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
  onChange,
  onSend,
  onDiscard,
  onClose,
}: ComposerProps) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  /** `true` until the mount effect has placed the caret. */
  const placed = useRef(false);

  /*
    Focus and caret placement, once per *mount*.

    This effect used to depend on `body.length`, which changes on every keystroke —
    so every character re-ran it and called `setSelectionRange(0, 0)`. Typing put the
    caret back at the start each time, which means `hello` came out as `olleh`: reply,
    the one thing a mail client cannot get wrong, was unusable. The comment above the
    old version argued the dependency was there on purpose, and it was the argument
    that kept it there.

    The intent it was defending is real and is now served explicitly: put the caret at
    the *top* of the body, above the quote, so what the user types goes above what is
    being replied to. A forward has no quote, so its caret goes to the top too, which
    is where a forward's own text belongs. `placed` makes it once-only without an empty
    dependency array, which would be a lie about what this depends on.

    **A forward does not touch the body at all.** `Sheet` is told to focus the To field
    for a forward (`initialFocus`), and this effect ran *after* that — React fires a
    child's effects before its parent's, so `Sheet` focused the To input, and then this
    immediately stole it for the textarea. The stated intent above ("a forward's caret
    goes to the top") is about the body once you have chosen to write in it; deciding
    *which* field you start in belongs to `Sheet`, and the two must not both answer it.
    Getting this wrong meant a forward opened with the caret in an empty body while Send
    stayed disabled for want of a recipient — the sheet looked broken and nothing said why.
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
      // close button still work, and both go through `onClose`, which *may* confirm —
      // so the destructive paths still exist and they still ask.
      dismissOnBackdrop={false}
      initialFocus={mode === "forward" ? toRef : bodyRef}
      className="flex max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift"
    >
      <SheetHeader title={title} onClose={onClose} />
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="w-12 shrink-0 text-ink-subtle">To</span>
          <input
            ref={toRef}
            type="text"
            aria-label="To"
            placeholder="name@example.com, another@example.com"
            value={to.join(", ")}
            onChange={(event) =>
              onChange({
                to: event.target.value
                  .split(",")
                  .map((address) => address.trim())
                  .filter(Boolean),
              })
            }
            className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-placeholder focus-visible:border-[var(--wn-inkBody)]"
          />
        </div>

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

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSend}
            // A forward with no recipient is unsendable, and a disabled Send is a
            // truthful statement about that. `title` says why, because a greyed-out
            // button with no explanation is its own small puzzle.
            disabled={sending || to.length === 0}
            title={to.length === 0 ? "Add at least one recipient" : undefined}
            className="rounded-full bg-[var(--wn-inkBody)] px-4 py-1.5 text-[13px] font-semibold text-[var(--wn-surface)] transition-opacity disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-full border border-control-border px-4 py-1.5 text-[13px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Discard
          </button>
          <span className="ml-auto text-right text-[11.5px] text-ink-subtle">
            {mode === "reply"
              ? "The quoted message is kept only if you leave it exactly as it is."
              : "The whole conversation is quoted below, without the reply markers."}
          </span>
        </div>
      </div>
      </div>
    </Sheet>
  );
}
