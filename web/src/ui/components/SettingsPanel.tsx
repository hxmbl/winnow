/**
 * Settings.
 *
 * Layout and behaviour of the screen are in `../settingsView.ts`; what each setting is
 * called and its explanation are in `../settingsCatalog.ts`, which every row here names
 * by id. The learning section exists so "Winnow ranks your mail" is a claim the user can
 * inspect and correct. The composer that used to share this file lives in
 * `Composer.tsx`.
 */

import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronRight, RotateCcw } from "lucide-react";
import { Sheet } from "./Overlay";
import { InfoButton, RadioCards, Row, Section, SettingBlock, SettingLabel, Toggle } from "./SettingsControls";
import { BINDINGS } from "../../core/mail/keybinds";
import type { NotificationActions } from "../../core/notify/notifications";
import { categoryOf, type CategoryId, type SettingId } from "../settingsCatalog";
import { SettingsExplain } from "../settingsExplainContext";
import {
  INFO_CLOSED,
  PHONE_MAX,
  WIDE_SETTINGS_MIN,
  explanationFor,
  infoReducer,
  initialExplain,
  moveCategory,
  pointAt,
  selectCategory,
  settingsColumns,
  visibleCategories,
  type SettingsLayout,
} from "../settingsView";
import { SORT_OPTIONS, type SortBy } from "../../core/classify/scoring";
import { UNDO_SEND_CHOICES, undoSendLabel, type UndoSendSeconds } from "../../core/mail/undoSend";
import { FILTER_LABELS } from "../../core/model/signals";
import type { ContactsAccessState, ImagePolicy } from "../../core/store/store";
import { APPEARANCES, type AccentTheme, type Appearance } from "../../core/model/appearance";
import { formatRelative } from "../../core/mail/datetime";
import type { FeedbackEvent } from "../../core/learn/learning";
import type { FilterLearning, LearnableFilter } from "../../core/learn/filterLearning";
import { SmartFilterSettings } from "./SmartFilterSettings";

/** The notification buttons Settings can switch, in the order a notification shows them. */
const NOTIFICATION_BUTTONS: readonly { key: keyof NotificationActions; label: string }[] = [
  { key: "reply", label: "Reply" },
  { key: "read", label: "Mark read" },
  { key: "trash", label: "Delete" },
];

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

/** What the mode picker calls each mode. */
const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
  oled: "OLED",
};

/** One accent theme as the picker shows it: its name and a swatch in the current mode. */
export type AccentChoice = { id: AccentTheme; label: string; swatch: string };

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
  /**
   * Swipe actions on the list. Null hides the row: the gesture only exists in the phone
   * layout, so a desktop window does not offer a switch that changes nothing there.
   */
  swipeActions: boolean | null;
  onSwipeActions: (value: boolean) => void;
  /** Left-handed phone layout. Null hides the row (only the phone layout has thumb controls). */
  leftHanded: boolean | null;
  onLeftHanded: (value: boolean) => void;
  /** How long Send waits for Undo. 5s by default; see `Preferences.undoSendSeconds`. */
  undoSendSeconds: UndoSendSeconds;
  onUndoSendSeconds: (value: UndoSendSeconds) => void;
  /** Brand logos from BIMI in avatars. Off by default; see `Preferences.brandLogos`. */
  brandLogos: boolean;
  onBrandLogos: (value: boolean) => void;
  /** Gravatar photos in avatars. Off by default; see `Preferences.gravatars`. */
  gravatars: boolean;
  onGravatars: (value: boolean) => void;
  notificationsEnabled: boolean;
  onNotifications: (value: boolean) => void;
  /** Which buttons a notification offers, and the lock-screen privacy switch. */
  notificationActions: NotificationActions;
  notificationHidePreview: boolean;
  onNotificationSettings: (patch: { notificationActions?: NotificationActions; notificationHidePreview?: boolean }) => void;
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
  /** What "Change smart filters…" has taught; Settings → Smart filters. */
  filterLearning: FilterLearning;
  onRemoveFilterRule: (filter: LearnableFilter, key: string) => void;
  onResetFilterLearning: (filter?: LearnableFilter) => void;
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
  /** Which Winnow this is, for About: "Winnow 1.0.1", and where it runs. */
  version?: string | null;
  platformLabel?: string | null;
  /** The category Settings opens on. Reading unless a caller has a reason. */
  initialCategory?: CategoryId;
  onClose: () => void;
};

/** Watch a media query. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return;
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function useSettingsLayout(): SettingsLayout {
  const phone = useMedia(`(max-width: ${PHONE_MAX}px)`);
  const wide = useMedia(`(min-width: ${WIDE_SETTINGS_MIN}px)`);
  return phone ? "phone" : wide ? "three" : "two";
}

/**
 * How far the phone sheet's scrollers pad their ends: past the floating dock (its top
 * edge's height above the screen's bottom, published by the dock) plus a little air, so
 * the last setting scrolls clear of the pill. The safe area is inside that height.
 */
const PHONE_SETTINGS_END = "calc(var(--wn-phone-tabs, env(safe-area-inset-bottom, 0px)) + 1rem)";

const BACK_BUTTON =
  "inline-flex items-center gap-1.5 rounded-ctl px-2 py-1.5 text-ui font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

/**
 * Settings: a full-window page that replaces the mail until Back (or Escape).
 *
 * From 1200px it is three columns separated by hairlines: the categories (with Back above
 * them), the chosen category's controls, and an explanation of the last setting pointed
 * at. Below 1200px the explanation column goes and every setting gets a (?) popover with
 * the same copy. On a phone it is a list of categories that opens one category at a time,
 * filling the screen behind the floating dock, whose tabs stay on top (any of them leaves
 * Settings).
 */
export function Settings(props: SettingsProps) {
  const layout = useSettingsLayout();
  const [explain, setExplain] = useState(() => initialExplain(props.initialCategory ?? "reading"));
  /** The phone's two screens: the category list, or one category's page. */
  const [phonePage, setPhonePage] = useState<"list" | "category">("list");
  const [info, dispatchInfo] = useReducer(infoReducer, INFO_CLOSED);
  const categories = visibleCategories();
  const tabRefs = useRef(new Map<CategoryId, HTMLButtonElement | null>());
  const pageHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const listButtonRefs = useRef(new Map<CategoryId, HTMLButtonElement | null>());

  const point = useCallback((setting: SettingId) => setExplain((state) => pointAt(state, setting)), []);
  const context = useMemo(
    () => ({
      mode: layout === "three" ? ("panel" as const) : ("popover" as const),
      point,
      pointed: explain.pointed,
      info,
      dispatchInfo,
    }),
    [layout, point, explain.pointed, info],
  );

  const choose = (category: CategoryId) => {
    setExplain((state) => selectCategory(state, category));
    dispatchInfo({ type: "outside" });
  };

  // The phone's page change moves focus with it: into the page's heading going in, back
  // to the category's row coming out, so a screen reader is never left on a removed node.
  const phoneFocus = useRef<"page" | "list" | null>(null);
  useEffect(() => {
    if (phoneFocus.current === "page") pageHeadingRef.current?.focus();
    if (phoneFocus.current === "list") listButtonRefs.current.get(explain.category)?.focus();
    phoneFocus.current = null;
  }, [phonePage, explain.category]);

  const explanation = explanationFor(explain);
  const category = categoryOf(explain.category);
  const content = <CategoryContent category={explain.category} props={props} />;

  if (layout === "phone") {
    return (
      <SettingsExplain.Provider value={context}>
        <Sheet
          label="Settings"
          onClose={props.onClose}
          placement="fill"
          dismissOnBackdrop={false}
          // Settings replaces the mail on a phone, so its backdrop is opaque chrome, not
          // the translucent scrim: the panel rises in from transparent, and over a scrim
          // the inbox showed through the sheet (its bottom edge included) for the length
          // of the motion. The app also stops painting the mail while this is open
          // (`main[data-covered]` in App), so nothing of the inbox can show below it.
          backdrop="opaque"
          // To the screen's bottom edge, behind the floating dock: the dock floats, so a
          // sheet that stopped at the pill's top left the inbox showing round the pill
          // and under the home indicator. The scrollers pad their ends to clear the pill
          // instead (`PHONE_SETTINGS_END`), and overscroll stays inside the sheet.
          className="flex h-full w-full flex-col overscroll-none bg-chrome"
        >
          <div data-settings-layout="phone" data-settings-page={phonePage} className="flex min-h-0 flex-1 flex-col">
            {phonePage === "list" ? (
              <>
                <div className="shrink-0 px-5 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
                  <h2 className="text-title font-semibold text-ink">Settings</h2>
                </div>
                <nav aria-label="Settings categories" data-settings-nav="" className="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3" style={{ paddingBottom: PHONE_SETTINGS_END }}>
                  <ul className="flex flex-col">
                    {categories.map((id) => (
                      <li key={id}>
                        <button
                          ref={(element) => {
                            listButtonRefs.current.set(id, element);
                          }}
                          type="button"
                          data-category={id}
                          onClick={() => {
                            choose(id);
                            phoneFocus.current = "page";
                            setPhonePage("category");
                          }}
                          className="flex min-h-12 w-full items-center justify-between gap-3 rounded-ctl px-3 text-left text-read font-medium text-ink-body transition-colors active:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                        >
                          {categoryOf(id).label}
                          <ChevronRight size={18} className="text-ink-subtle" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
              </>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-1 border-b border-hairline-soft px-2 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]">
                  <button
                    type="button"
                    data-settings-back=""
                    aria-label="Back to Settings"
                    onClick={() => {
                      phoneFocus.current = "list";
                      setPhonePage("list");
                      dispatchInfo({ type: "outside" });
                    }}
                    className="flex h-11 w-11 items-center justify-center rounded-ctl text-ink-icon transition-colors active:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <ArrowLeft size={20} aria-hidden="true" />
                  </button>
                  <h2
                    ref={pageHeadingRef}
                    tabIndex={-1}
                    data-settings-title=""
                    className="text-read font-semibold text-ink outline-none"
                  >
                    {category.label}
                  </h2>
                </div>
                <div
                  data-select-scope=""
                  data-settings-body=""
                  className="selectable scroll-shadow thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-4"
                  style={{ paddingBottom: PHONE_SETTINGS_END }}
                >
                  {content}
                </div>
              </>
            )}
          </div>
        </Sheet>
      </SettingsExplain.Provider>
    );
  }

  return (
    <SettingsExplain.Provider value={context}>
      <Sheet
        label="Settings"
        onClose={props.onClose}
        placement="fill"
        dismissOnBackdrop={false}
        className="flex h-full w-full bg-chrome"
      >
        <div
          data-settings-layout={layout}
          className="grid h-full min-h-0 w-full"
          style={{ gridTemplateColumns: settingsColumns(layout) }}
        >
          {/* Left: Back, then the categories. */}
          <div data-settings-column="nav" className="flex min-h-0 min-w-0 flex-col border-r border-hairline-soft px-2 py-4 min-[1400px]:px-3">
            <button type="button" data-settings-back="" onClick={props.onClose} className={`${BACK_BUTTON} self-start`}>
              <ArrowLeft size={16} aria-hidden="true" />
              Back
            </button>
            <div
              role="tablist"
              aria-orientation="vertical"
              aria-label="Settings categories"
              data-settings-nav=""
              className="thin-scroll mt-6 flex min-h-0 flex-col gap-0.5 overflow-y-auto"
            >
              {categories.map((id) => {
                const selected = id === explain.category;
                return (
                  <button
                    key={id}
                    ref={(element) => {
                      tabRefs.current.set(id, element);
                    }}
                    type="button"
                    role="tab"
                    id={`winnow-settings-tab-${id}`}
                    data-category={id}
                    aria-selected={selected}
                    aria-controls="winnow-settings-panel"
                    tabIndex={selected ? 0 : -1}
                    onClick={() => choose(id)}
                    onKeyDown={(event) => {
                      const next = moveCategory(categories, id, event.key);
                      if (next === id) return;
                      event.preventDefault();
                      choose(next);
                      tabRefs.current.get(next)?.focus();
                    }}
                    className={`rounded-ctl px-2.5 py-2 text-left text-ui leading-snug [overflow-wrap:anywhere] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                      selected
                        ? "bg-surface-selected font-semibold text-ink"
                        : "font-medium text-ink-muted hover:bg-surface-hover hover:text-ink-body"
                    }`}
                  >
                    {categoryOf(id).label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Middle: the category's title and its controls. */}
          <div
            role="tabpanel"
            id="winnow-settings-panel"
            aria-labelledby={`winnow-settings-tab-${explain.category}`}
            data-settings-column="content"
            className={`flex min-h-0 flex-col ${layout === "three" ? "border-r border-hairline-soft" : ""}`}
          >
            <div className="shrink-0 px-8 pb-4 pt-6">
              <p className="text-meta font-semibold text-ink-subtle">Settings</p>
              <h2 data-settings-title="" className="mt-0.5 text-title font-semibold text-ink">
                {category.label}
              </h2>
            </div>
            <div
              data-select-scope=""
              data-settings-body=""
              className="selectable scroll-shadow thin-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-8"
            >
              <div className="max-w-[40rem]">{content}</div>
            </div>
          </div>

          {/* Right: the explanation of the last setting pointed at. */}
          {layout === "three" && (
            <aside
              data-settings-column="explain"
              data-settings-explain={explanation.kind}
              data-explains={explanation.setting ?? undefined}
              aria-live="polite"
              aria-label="About this setting"
              className="min-h-0 overflow-y-auto px-8 pt-[4.75rem]"
            >
              <p className="text-meta font-semibold text-ink-subtle">
                {explanation.kind === "intro" ? "About this section" : "About this setting"}
              </p>
              <h3 className="mt-1 text-read font-semibold text-ink">{explanation.title}</h3>
              <p className="mt-2 max-w-[28rem] text-ui leading-relaxed text-ink-muted">{explanation.body}</p>
              {explanation.kind === "intro" && (
                <p className="mt-4 text-meta text-ink-subtle">Point at a setting to see what it does.</p>
              )}
            </aside>
          )}
        </div>
      </Sheet>
    </SettingsExplain.Provider>
  );
}

/** One category's controls. Every setting row names its catalog id with `setting="…"`. */
function CategoryContent({ category, props }: { category: CategoryId; props: SettingsProps }) {
  switch (category) {
    case "reading":
      return <ReadingSettings props={props} />;
    case "filters":
      return (
        <SmartFilterSettings
          model={props.filterLearning}
          onRemoveRule={props.onRemoveFilterRule}
          onReset={props.onResetFilterLearning}
        />
      );
    case "compose":
      return (
        <Section>
          <Row setting="undoSend">
            <div data-undo-send-choices="" className="flex gap-1 rounded-ctl border border-hairline p-0.5">
              {UNDO_SEND_CHOICES.map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  onClick={() => props.onUndoSendSeconds(seconds)}
                  aria-pressed={props.undoSendSeconds === seconds}
                  aria-label={seconds === 0 ? "Undo send off" : `Wait ${seconds} seconds`}
                  className={`rounded-ctl px-2 py-1 text-meta font-semibold tabular-nums transition-colors ${
                    props.undoSendSeconds === seconds ? "bg-surface-active text-ink" : "text-ink-muted hover:text-ink-body"
                  }`}
                >
                  {undoSendLabel(seconds)}
                </button>
              ))}
            </div>
          </Row>
        </Section>
      );
    case "appearance":
      return (
        <Section>
          <RadioCards
            id="winnow-theme-mode"
            setting="themeMode"
            options={APPEARANCES.map((option) => ({ value: option, label: APPEARANCE_LABELS[option] }))}
            value={props.appearance}
            onChange={props.onAppearance}
          />
          <RadioCards
            id="winnow-theme-accent"
            setting="accent"
            options={props.accentChoices.map((choice) => ({
              value: choice.id,
              label: choice.label,
              swatch: choice.swatch,
            }))}
            value={props.accentTheme}
            onChange={props.onAccentTheme}
          />
          {props.leftHanded !== null && (
            <Row setting="leftHanded">
              <Toggle checked={props.leftHanded} onChange={props.onLeftHanded} label="Left-handed" />
            </Row>
          )}
        </Section>
      );
    case "privacy":
      return (
        <Section>
          {/*
            Remote images: three states, because there are three intentions.

            This was a toggle, and a toggle has two positions. "Load" and "don't load"
            cannot say the third thing a user actually wants, which is *stop asking* —
            and that is not the same as "never": somebody who has been asked three times
            wants their mail to look like mail.

            A segmented control rather than three buttons because it is one setting with
            three values.
          */}
          <Row setting="remoteImages">
            <div role="radiogroup" aria-label="Remote images" className="flex items-center gap-0.5 rounded-ctl bg-sheen p-0.5">
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
          <Row setting="brandLogos">
            <Toggle checked={props.brandLogos} onChange={props.onBrandLogos} label="Show brand logos" />
          </Row>
          <Row setting="gravatars">
            <Toggle checked={props.gravatars} onChange={props.onGravatars} label="Gravatar photos" />
          </Row>
        </Section>
      );
    case "sync":
      return (
        <Section>
          <Row setting="notifications">
            <Toggle checked={props.notificationsEnabled} onChange={props.onNotifications} label="Notify about new mail" />
          </Row>
          {props.notificationsEnabled && (
            <>
              <Row setting="notificationActions">
                <div role="group" aria-label="Notification buttons" className="flex items-center gap-0.5 rounded-ctl bg-sheen p-0.5">
                  {NOTIFICATION_BUTTONS.map((button) => {
                    const on = props.notificationActions[button.key];
                    return (
                      <button
                        key={button.key}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          props.onNotificationSettings({
                            notificationActions: { ...props.notificationActions, [button.key]: !on },
                          })
                        }
                        className={`rounded-ctl px-2.5 py-1 text-meta font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                          on ? "bg-surface text-ink shadow-pane" : "text-ink-muted hover:text-ink-body"
                        }`}
                      >
                        {button.label}
                      </button>
                    );
                  })}
                </div>
              </Row>
              <Row setting="notificationPrivacy">
                <Toggle
                  checked={props.notificationHidePreview}
                  onChange={(value) => props.onNotificationSettings({ notificationHidePreview: value })}
                  label="Hide preview on lock screen"
                />
              </Row>
            </>
          )}
          {props.isDesktop && props.backgroundSync !== null ? (
            <>
              <Row setting="backgroundSync">
                <Toggle checked={props.backgroundSync} onChange={props.onBackgroundSync} label="Keep syncing while closed" />
              </Row>
              {props.backgroundSync && (
                <Row setting="syncInterval">
                  <select
                    value={props.backgroundSyncInterval}
                    onChange={(event) => props.onBackgroundSyncInterval(Number(event.target.value))}
                    aria-label="Check for new mail every"
                    className="rounded-ctl border border-hairline bg-surface px-4 py-1 text-meta font-semibold text-ink-body"
                  >
                    <option value={60}>Every minute</option>
                    <option value={300}>Every 5 minutes</option>
                    <option value={900}>Every 15 minutes</option>
                    <option value={3600}>Every hour</option>
                  </select>
                </Row>
              )}
            </>
          ) : (
            <p data-settings-empty="" className="pt-2 text-meta text-ink-subtle">
              Background sync is only in the desktop app. Here, Winnow syncs while this tab is open.
            </p>
          )}
        </Section>
      );
    case "google":
      return <GoogleSettings props={props} />;
    case "senders":
      return <SenderSettings props={props} />;
    case "shortcuts":
      return (
        <Section>
          <SettingBlock setting="shortcutList">
            {/*
              A two-column table no wider than it needs: the key, then what it does right
              beside it, read left to right. (It was keys on the left and descriptions
              right-aligned ~600px away on a wide window, which the eye could not follow.)
            */}
            <dl
              data-settings-shortcuts=""
              className="grid max-w-[34rem] grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)] items-baseline gap-x-5 gap-y-1.5"
            >
              {BINDINGS.map((binding) => (
                <div key={binding.keys} data-shortcut-row="" className="contents">
                  <dt>
                    <kbd className="whitespace-nowrap rounded-ctl border border-hairline bg-surface-sunken px-2 py-0.5 font-mono text-meta font-semibold text-ink-body">
                      {binding.keys}
                    </kbd>
                  </dt>
                  <dd className="text-meta text-ink-muted">{binding.help}</dd>
                </div>
              ))}
            </dl>
          </SettingBlock>
        </Section>
      );
    case "about":
      return (
        <Section>
          <Row setting="version" hint={props.platformLabel ?? undefined}>
            <span className="text-meta font-semibold tabular-nums text-ink-body">{props.version ?? "Unknown"}</span>
          </Row>
          <Row setting="licence">
            <span className="text-meta font-semibold text-ink-body">MIT</span>
          </Row>
        </Section>
      );
  }
}

function ReadingSettings({ props }: { props: SettingsProps }) {
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
    <>
      <Section>
        <Row setting="sortBy">
          <div className="flex gap-1 rounded-ctl border border-hairline p-0.5">
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => props.onSortBy(option.id)}
                aria-pressed={props.sortBy === option.id}
                className={`rounded-ctl px-2.5 py-1 text-meta font-semibold transition-colors ${
                  props.sortBy === option.id ? "bg-surface-active text-ink" : "text-ink-muted hover:text-ink-body"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </Row>
        <Row setting="markReadOnOpen">
          <Toggle checked={props.markReadOnOpen} onChange={props.onMarkReadOnOpen} label="Mark as read when opened" />
        </Row>
        {props.swipeActions !== null && (
          <Row setting="swipeActions">
            <Toggle checked={props.swipeActions} onChange={props.onSwipeActions} label="Swipe actions" />
          </Row>
        )}
      </Section>

      <Section title="How Winnow sorts">
        <p data-sorting-note="" className="pb-1 text-ui text-ink-body">
          Winnow learns from your stars and hides as you use it.
        </p>

        {/*
          One reset, confirmed inline: the weights are the sum of everything learned so
          far, and a single stray click must not throw that away. The log is kept either
          way (it is the audit trail), so the reset says only what it resets.
        */}
        <SettingBlock setting="resetSorting">
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
                  className={SECONDARY_BUTTON}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button type="button" onClick={() => setResetStep("confirm")} className={`inline-flex items-center gap-1.5 ${SECONDARY_BUTTON}`}>
                  <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
                  Reset sorting
                </button>
                {/* The (?) for Reset sorting, which has no label of its own beside the button. */}
                <InfoSlot setting="resetSorting" />
              </>
            )}
            <span role="status" aria-live="polite" className="text-meta font-medium text-success">
              {resetStep === "done" ? "Sorting reset" : ""}
            </span>
          </div>
        </SettingBlock>

        {resetStep !== "confirm" && (
          <SettingBlock setting="learningHistory">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowHistory((value) => !value)}
                aria-expanded={showHistory}
                aria-controls="winnow-learning-history"
                className={SECONDARY_BUTTON}
              >
                {showHistory ? "Hide" : "Show"} what I&apos;ve learned
                {props.events.length > 0 && ` (${props.events.length})`}
              </button>
              <InfoSlot setting="learningHistory" />
            </div>
            {showHistory && <LearningHistory events={props.events} />}
          </SettingBlock>
        )}
      </Section>
    </>
  );
}

/** The (?) for a setting whose control is its own label (a button), below 1200px only. */
function InfoSlot({ setting }: { setting: SettingId }) {
  const { mode } = useContext(SettingsExplain);
  return mode === "popover" ? <InfoButton setting={setting} /> : null;
}

const SECONDARY_BUTTON =
  "rounded-ctl border border-control-border px-3 py-1.5 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

function LearningHistory({ events }: { events: readonly FeedbackEvent[] }) {
  return (
    <div
      id="winnow-learning-history"
      className="mt-2 max-h-64 overflow-y-auto rounded-pane border border-hairline bg-surface-sunken p-2"
    >
      {events.length === 0 ? (
        <p className="px-2 py-3 text-center text-meta text-ink-subtle">
          Nothing yet. Star a message and Winnow will record what it did and why.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {events.slice(0, HISTORY_LIMIT).map((event) => (
              <li key={event.id} className="flex items-baseline justify-between gap-3 px-2 py-1 text-meta">
                <span className="min-w-0 truncate text-ink-body">
                  {describeEvent(event)}
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
          {/*
            The log is capped at `MAX_EVENTS`, so a long-lived install can have more here
            than the panel shows. The count on the button is the *total*, so a silent
            truncation would be a lie.
          */}
          {events.length > HISTORY_LIMIT && (
            <p className="px-2 py-2 text-center text-meta text-ink-subtle">
              Showing the {HISTORY_LIMIT} most recent of {events.length}. Older entries are kept, but not
              listed here.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function GoogleSettings({ props }: { props: SettingsProps }) {
  return (
    <Section>
      {/*
        The client first: Winnow ships no Google client, so until one is set up this is
        the row that decides whether Gmail can be connected at all.
      */}
      <Row
        setting="oauthClient"
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

      {/*
        Google contacts, as an opt-in rather than a sign-in permission: Winnow asks for
        mail at sign-in and nothing else, and this is where the user can choose to add
        their address book later. Shown only once there is an account to ask for, and not
        in the demo (whose address book is seeded).

        It is the grant behind contact *photos* as well as recipient suggestions, and it
        used to be labelled for suggestions alone — so someone who wanted their contacts'
        faces in the list had no way to tell this was the switch. It leads with photos.
      */}
      {props.contactsAccess === "not_granted" || props.contactsAccess === "granted" ? (
        <>
          <Row
            setting="googleContacts"
            hint={props.contactsAccess === "granted" ? "Connected, read-only." : "Read-only; Google asks you to approve it."}
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
        </>
      ) : (
        <SettingBlock setting="googleContacts">
          <SettingLabel setting="googleContacts" />
          <p data-settings-empty="" className="text-meta text-ink-subtle">
            Available once a Gmail account is connected.
          </p>
        </SettingBlock>
      )}
    </Section>
  );
}

function SenderSettings({ props }: { props: SettingsProps }) {
  return (
    <>
      <Section title={`Hidden senders (${props.blockedSenders.length})`}>
        <SettingBlock setting="hiddenSenders">
          <SettingLabel setting="hiddenSenders" />
          {props.blockedSenders.length === 0 ? (
            <p data-settings-empty="" className="text-meta text-ink-subtle">
              None. Hide a sender from the menu on their picture.
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              {props.blockedSenders.map((sender) => (
                <Row key={sender} label={sender}>
                  <button type="button" onClick={() => props.onUnblock(sender)} className={`inline-flex items-center gap-1.5 ${SENDER_BUTTON}`}>
                    <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                    Unhide
                  </button>
                </Row>
              ))}
            </div>
          )}
        </SettingBlock>
      </Section>

      <Section title={`Muted senders (${props.mutedSenders.length})`}>
        <SettingBlock setting="mutedSenders">
          <SettingLabel setting="mutedSenders" />
          <p className="text-meta text-ink-subtle">
            Still in your inbox, but they never notify and are not counted on the badge.
          </p>
          {props.mutedSenders.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {props.mutedSenders.map((sender) => (
                <Row key={sender} label={sender}>
                  <button type="button" onClick={() => props.onUnmute(sender)} className={`inline-flex items-center gap-1.5 ${SENDER_BUTTON}`}>
                    <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                    Unmute
                  </button>
                </Row>
              ))}
            </div>
          )}
        </SettingBlock>
      </Section>
    </>
  );
}

const SENDER_BUTTON =
  "rounded-ctl border border-control-border px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
