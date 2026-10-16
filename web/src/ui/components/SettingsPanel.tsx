/**
 * Settings.
 *
 * The learning section exists so "Winnow ranks your mail" is a claim the user can
 * inspect and correct. The composer that used to share this file lives in
 * `Composer.tsx`.
 */

import { useEffect, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Sheet, SheetHeader } from "./Overlay";
import { SORT_OPTIONS, type SortBy } from "../../core/classify/scoring";
import { FILTER_LABELS } from "../../core/model/signals";
import type { ContactsAccessState, ImagePolicy } from "../../core/store/store";
import { APPEARANCES, type AccentTheme, type Appearance } from "../../core/model/appearance";
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
      <h3 className="text-meta font-semibold text-ink-subtle">
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
    /*
      Wraps rather than squeezes. The label wants at least 14rem; a control that will not
      fit beside that (a segmented control on a phone) drops to its own line under the
      label, and the label keeps the full width. A small control (a switch, a button)
      still sits on the right.
    */
    <div data-settings-row="" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-[1_1_14rem]">
        <p className="text-ui font-medium text-ink-body">{label}</p>
        {hint && <p className="text-meta text-ink-subtle">{hint}</p>}
      </div>
      <div data-settings-control="" className="max-w-full shrink-0">{children}</div>
    </div>
  );
}

/** What the mode picker calls each mode. */
const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
  oled: "OLED",
};

/** One accent theme as the picker shows it: its name and a swatch in the current mode. */
export type AccentChoice = { id: AccentTheme; label: string; swatch: string };

/**
 * A labelled group of radios, laid out as a row of equal cells.
 *
 * A real radio group to assistive technology and to the keyboard: one tab stop (the
 * checked option), arrow keys move the choice and the focus together, Home and End jump
 * to the ends — the behaviour a screen-reader user expects from `role="radiogroup"`.
 * The label is a visible heading the group points at, not an `aria-label` only a screen
 * reader would hear.
 */
function RadioCards<T extends string>({
  id,
  label,
  hint,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  options: readonly { value: T; label: string; swatch?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (index: number) => {
    const next = (index + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p id={`${id}-label`} className="text-ui font-medium text-ink-body">
          {label}
        </p>
        {hint && (
          <p id={`${id}-hint`} className="text-meta text-ink-subtle">
            {hint}
          </p>
        )}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        data-picker={id}
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option, index) => {
          const checked = option.value === value;
          return (
            <button
              key={option.value}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              data-value={option.value}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") move(index + 1);
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(index - 1);
                else if (event.key === "Home") move(0);
                else if (event.key === "End") move(options.length - 1);
                else return;
                event.preventDefault();
              }}
              className={`flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-ctl border px-2 py-1.5 text-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-11 ${
                checked
                  ? "border-accent bg-surface-selected font-semibold text-ink"
                  : "border-hairline font-medium text-ink-muted hover:bg-surface-hover hover:text-ink-body"
              }`}
            >
              {option.swatch && (
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: option.swatch }}
                />
              )}
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

export type SettingsProps = {
  sortBy: SortBy;
  onSortBy: (sort: SortBy) => void;
  appearance: Appearance;
  onAppearance: (value: Appearance) => void;
  /** The accent theme in force, and the choices with a swatch drawn in the current mode. */
  accentTheme: AccentTheme;
  accentChoices: readonly AccentChoice[];
  onAccentTheme: (value: AccentTheme) => void;
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
  /** Read on open. On by default; see `Preferences.markReadOnOpen`. */
  markReadOnOpen: boolean;
  onMarkReadOnOpen: (value: boolean) => void;
  /** Brand logos from BIMI in avatars. Off by default; see `Preferences.brandLogos`. */
  brandLogos: boolean;
  onBrandLogos: (value: boolean) => void;
  /** Gravatar photos in avatars. Off by default; see `Preferences.gravatars`. */
  gravatars: boolean;
  onGravatars: (value: boolean) => void;
  notificationsEnabled: boolean;
  onNotifications: (value: boolean) => void;
  /** Null on the web, where there is no background thread to hand. */
  backgroundSync: boolean | null;
  onBackgroundSync: (value: boolean) => void;
  backgroundSyncInterval: number;
  onBackgroundSyncInterval: (value: number) => void;
  /** "Reset sorting": back to the shipped weights. Learning itself is always on. */
  onResetSorting: () => void;
  /**
   * The feedback log, **newest first** (`LearningModel.history`). `events` is
   * oldest-first, so slicing that would show the beginning of the log rather than
   * the part that explains the weights on screen.
   */
  events: readonly FeedbackEvent[];
  blockedSenders: readonly string[];
  onUnblock: (sender: string) => void;
  /** Senders muted from the sender menu: listed, but silent. */
  mutedSenders: readonly string[];
  onUnmute: (sender: string) => void;
  /** True when the build is a desktop shell, so the OS-only rows make sense. */
  isDesktop: boolean;
  /** The user's own Google OAuth client, shortened for display, or `null` before setup. */
  googleClient: string | null;
  /** Whether a Gmail account is connected. */
  signedIn: boolean;
  /** Open the Google account sheet (set up, change or remove the OAuth client). */
  onGoogleAccount: () => void;
  /** Where Google contacts stand. The row only shows for a signed-in account. */
  contactsAccess: ContactsAccessState;
  contactsBusy: boolean;
  contactsError: string | null;
  /**
   * Connected, but nothing can arrive, for a reason the user can fix (the People API is
   * off in their Cloud project). Said under the row, with Google's link to the switch.
   */
  contactsProblem?: { message: string; url: string | null } | null;
  onOpenContactsHelp?: (url: string) => void;
  /** Start the incremental-consent flow for the two contact scopes. */
  onImproveSuggestions: () => void;
  onClose: () => void;
};

export function Settings(props: SettingsProps) {
  const [showHistory, setShowHistory] = useState(false);
  /** The inline confirmation for "Reset sorting": idle, asking, or just done. */
  const [resetStep, setResetStep] = useState<"idle" | "confirm" | "done">("idle");
  const confirmResetRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (resetStep === "confirm") confirmResetRef.current?.focus();
    if (resetStep !== "done") return;
    const timer = window.setTimeout(() => setResetStep("idle"), 2_500);
    return () => window.clearTimeout(timer);
  }, [resetStep]);

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
      <div data-select-scope="" data-settings-body="" className="selectable scroll-shadow thin-scroll min-h-0 flex-1 overflow-y-auto">
        {/*
          Google account first: Winnow ships no Google client, so until one is set up
          this is the row that decides whether Gmail can be connected at all.
        */}
        <Section title="Google account">
          <Row
            label="Your Google OAuth client"
            hint={
              props.googleClient
                ? `${props.googleClient}${props.signedIn ? " · connected" : ""}`
                : "Not set up. Winnow uses a client from your own Google Cloud project."
            }
          >
            <button
              type="button"
              onClick={props.onGoogleAccount}
              className="rounded-ctl border border-control-border px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {props.googleClient ? "Change" : "Set up"}
            </button>
          </Row>
        </Section>

        <Section title="Reading">
        <Row label="Sort messages by">
          <div className="flex gap-1 rounded-ctl border border-hairline p-0.5">
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => props.onSortBy(option.id)}
                aria-pressed={props.sortBy === option.id}
                className={`rounded-ctl px-2.5 py-1 text-meta font-semibold transition-colors ${
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
          label="Mark as read when opened"
          hint="Opening a message or conversation marks it read. Off, mail stays unread until you mark it."
        >
          <Toggle checked={props.markReadOnOpen} onChange={props.onMarkReadOnOpen} label="Mark as read when opened" />
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
            className="flex items-center gap-0.5 rounded-ctl bg-sheen p-0.5"
          >
            {IMAGE_POLICY_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={props.imagePolicy === choice.value}
                disabled={!props.canLoadRemoteContent && choice.value !== "never"}
                onClick={() => props.onImagePolicy(choice.value)}
                className={`rounded-ctl px-2.5 py-1 text-meta font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 ${
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
          label="Show brand logos"
          hint="Shows a company's logo beside its mail, from the logo it publishes for email (BIMI). Turning this on sends each sender's domain to Cloudflare's DNS resolver and loads the logo from the sender's own site."
        >
          <Toggle checked={props.brandLogos} onChange={props.onBrandLogos} label="Show brand logos" />
        </Row>

        <Row
          label="Gravatar photos"
          hint="Shows a sender's Gravatar when they are not in your contacts. Turning this on sends a hashed copy of each sender's address to Gravatar."
        >
          <Toggle checked={props.gravatars} onChange={props.onGravatars} label="Gravatar photos" />
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
        <RadioCards
          id="winnow-theme-mode"
          label="Mode"
          hint="System follows your device between light and dark. OLED is dark on true black."
          options={APPEARANCES.map((option) => ({ value: option, label: APPEARANCE_LABELS[option] }))}
          value={props.appearance}
          onChange={props.onAppearance}
        />
        <RadioCards
          id="winnow-theme-accent"
          label="Accent"
          hint="The one colour Winnow uses for unread, selection and the main action."
          options={props.accentChoices.map((choice) => ({
            value: choice.id,
            label: choice.label,
            swatch: choice.swatch,
          }))}
          value={props.accentTheme}
          onChange={props.onAccentTheme}
        />
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
                className="rounded-ctl border border-hairline bg-surface px-3 py-1 text-meta font-semibold text-ink-body"
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

      {/*
        Google contacts, as an opt-in rather than a sign-in permission: Winnow asks for
        mail at sign-in and nothing else, and this is where the user can choose to add
        their address book later. Hidden in the demo (whose address book is seeded) and
        while signed out (there is no account to ask for).

        It is the grant behind contact *photos* as well as recipient suggestions, and it
        used to be labelled for suggestions alone — so someone who wanted their contacts'
        faces in the list had no way to tell this was the switch. It leads with photos.
      */}
      {(props.contactsAccess === "not_granted" || props.contactsAccess === "granted") && (
        <Section title="Google contacts">
          <Row
            label="Contact photos and suggestions"
            hint={
              props.contactsAccess === "granted"
                ? "Your contacts' photos appear beside their mail, and your saved contacts and the people Google remembers you writing to are suggested as recipients."
                : "Shows your contacts' photos beside their mail and suggests them as recipients. Read-only; Google asks you to approve it."
            }
          >
            {props.contactsAccess === "granted" ? (
              <span className="inline-flex items-center gap-1 text-meta font-semibold text-ink-muted">
                <Check size={13} aria-hidden="true" /> Connected
              </span>
            ) : (
              <button
                type="button"
                onClick={props.onImproveSuggestions}
                disabled={props.contactsBusy}
                className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                {props.contactsBusy ? "Waiting for Google…" : "Connect"}
              </button>
            )}
          </Row>
          {props.contactsError && (
            <p role="alert" className="text-meta font-medium text-danger">
              {props.contactsError}
            </p>
          )}
          {props.contactsAccess === "granted" && props.contactsProblem && (
            <div data-contacts-problem="" role="alert" className="flex flex-col items-start gap-1.5">
              <p className="text-meta font-medium text-danger">{props.contactsProblem.message}</p>
              {props.contactsProblem.url && props.onOpenContactsHelp && (
                <button
                  type="button"
                  onClick={() => props.onOpenContactsHelp?.(props.contactsProblem!.url!)}
                  className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Turn on the People API
                </button>
              )}
            </div>
          )}
        </Section>
      )}

      <Section title="How Winnow sorts">
        <p data-sorting-note="" className="text-ui text-ink-body">
          Winnow learns from your stars and hides as you use it.
        </p>

        {/*
          One reset, confirmed inline: the weights are the sum of everything learned so
          far, and a single stray click must not throw that away. The log is kept either
          way (it is the audit trail), so the reset says only what it resets.
        */}
        <div data-sorting-reset={resetStep} className="flex flex-wrap items-center gap-2">
          {resetStep === "confirm" ? (
            <div role="group" aria-label="Reset sorting?" className="flex flex-wrap items-center gap-2">
              <span className="text-meta font-medium text-ink-body">
                Forget what Winnow has learned and go back to the default sorting?
              </span>
              <button
                ref={confirmResetRef}
                type="button"
                onClick={() => {
                  props.onResetSorting();
                  setResetStep("done");
                }}
                className="rounded-ctl bg-danger px-3 py-1.5 text-meta font-semibold text-surface transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => setResetStep("idle")}
                className="rounded-ctl border border-control-border px-3 py-1.5 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setResetStep("confirm")}
              className="inline-flex items-center gap-1.5 rounded-ctl border border-control-border px-3 py-1.5 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
              Reset sorting
            </button>
          )}
          {resetStep !== "confirm" && (
            <button
              type="button"
              onClick={() => setShowHistory((value) => !value)}
              aria-expanded={showHistory}
              aria-controls="winnow-learning-history"
              className="rounded-ctl border border-control-border px-3 py-1.5 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {showHistory ? "Hide" : "Show"} what I&apos;ve learned
              {props.events.length > 0 && ` (${props.events.length})`}
            </button>
          )}
          <span role="status" aria-live="polite" className="text-meta font-medium text-success">
            {resetStep === "done" ? "Sorting reset" : ""}
          </span>
        </div>

        {showHistory && (
          <div
            id="winnow-learning-history"
            className="max-h-64 overflow-y-auto rounded-ctl border border-hairline bg-surface-sunken p-2"
          >
            {props.events.length === 0 ? (
              <p className="px-2 py-3 text-center text-meta text-ink-subtle">
                Nothing yet. Star a message and Winnow will record what it did and why.
              </p>
            ) : (
              <>
                <ul className="flex flex-col gap-1">
                  {props.events.slice(0, HISTORY_LIMIT).map((event) => (
                    <li
                      key={event.id}
                      className="flex items-baseline justify-between gap-3 px-2 py-1 text-meta"
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
                  <p className="px-2 py-2 text-center text-meta text-ink-subtle">
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
                className="inline-flex items-center gap-1.5 rounded-ctl border border-control-border px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                Unhide
              </button>
            </Row>
          ))}
        </Section>
      )}

      {props.mutedSenders.length > 0 && (
        <Section title={`Muted senders (${props.mutedSenders.length})`}>
          <p className="-mt-1 text-meta text-ink-subtle">
            Still in your inbox, but they never notify and are not counted on the badge.
          </p>
          {props.mutedSenders.map((sender) => (
            <Row key={sender} label={sender}>
              <button
                type="button"
                onClick={() => props.onUnmute(sender)}
                className="inline-flex items-center gap-1.5 rounded-ctl border border-control-border px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                Unmute
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
        checked ? "bg-accent" : "bg-surface-active"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-surface transition-transform ${
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
