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
import { Check, RotateCcw, X } from "lucide-react";
import {
  SIGNAL_KEYS,
  adjustment,
  type SignalKey,
  type SignalWeights,
} from "../../core/classify/weights";
import { SORT_OPTIONS, type SortBy } from "../../core/classify/scoring";
import { formatRelative } from "../../core/mail/datetime";
import type { FeedbackEvent } from "../../core/learn/learning";

/** The sheet chrome both panels share. */
function Sheet({
  title,
  onClose,
  children,
  width = "max-w-[520px]",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className={`thin-scroll animate-sheet max-h-[85vh] w-full ${width} overflow-y-auto rounded-pane border border-hairline bg-chrome shadow-lift`}
      >
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-hairline bg-chrome px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
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
    <Sheet title="Settings" onClose={props.onClose}>
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
          hint="Tracking pixels confirm you opened a message. Turn this on for messages you trust."
        >
          <Toggle
            checked={props.loadRemoteContent}
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
  to: readonly string[];
  subject: string;
  body: string;
  quoteBlock?: string;
  sending: boolean;
  error: string | null;
  onChange: (patch: { to?: string[]; subject?: string; body?: string }) => void;
  onSend: () => void;
  onDiscard: () => void;
  onClose: () => void;
};

export function Composer({
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

  // The composer takes focus on open, and Escape returns it to the reader
  // without sending. A reply that requires you to click into a box before you
  // can read the quote is a reply nobody reads.
  //
  // `body.length` is in the dependency list even though it is only read as a
  // boolean: without it the effect is honest about what it depends on, and if
  // the composer is ever mounted against a body that arrives *later* — a draft
  // restored from a draft store, say — the caret still lands above the quote
  // instead of after it. An exhaustive-deps warning here is a real behaviour
  // change waiting to happen, not noise.
  useEffect(() => {
    bodyRef.current?.focus();
    if (bodyRef.current && body.length > 0) bodyRef.current.setSelectionRange(0, 0);
  }, [body.length]);

  return (
    <Sheet title="Reply" onClose={onClose} width="max-w-[640px]">
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="w-12 shrink-0 text-ink-subtle">To</span>
          <input
            type="text"
            value={to.join(", ")}
            onChange={(event) =>
              onChange({
                to: event.target.value
                  .split(",")
                  .map((address) => address.trim())
                  .filter(Boolean),
              })
            }
            className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus-visible:border-[var(--wn-inkBody)]"
          />
        </div>

        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="w-12 shrink-0 text-ink-subtle">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(event) => onChange({ subject: event.target.value })}
            className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus-visible:border-[var(--wn-inkBody)]"
          />
        </div>

        <textarea
          ref={bodyRef}
          value={body}
          onChange={(event) => onChange({ body: event.target.value })}
          rows={16}
          spellCheck
          className="selectable thin-scroll w-full resize-y rounded-md border border-hairline bg-surface p-3 font-mono text-[13px] leading-[1.7] text-ink-body outline-none focus-visible:border-[var(--wn-inkBody)]"
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
            disabled={sending || to.length === 0}
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
          <span className="ml-auto text-[11.5px] text-ink-subtle">
            The quoted message below is kept only if you leave it exactly as it is.
          </span>
        </div>
      </div>
    </Sheet>
  );
}
