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
import { ArrowLeft, Check, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { Sheet } from "./Overlay";
import { InfoButton, RadioCards, Row, Section, SettingBlock, SettingLabel, Toggle } from "./SettingsControls";
import { offlineSummary, type OfflineView } from "../../core/offline/offlineSave";
import { BINDINGS } from "../../core/mail/keybinds";
import type { NotificationActions } from "../../core/notify/notifications";
import { driveLinksStatus, type DriveAccess } from "../../core/gmail/drive";
import { SETTINGS, categoryOf, type CategoryId, type SettingId } from "../settingsCatalog";
import { BACKGROUND_SYNC_NOTE, backgroundSyncOffer } from "../backgroundSyncSetting";
import { backgroundServiceHint, gmailListenerHint, type BackgroundServiceStatus } from "../../core/notify/backgroundService";
import { devUnlockTap } from "../devOptions";
import { DebugLogPanel } from "./DebugLogPanel";
import type { TestNotificationResult } from "../notificationActions";
import { devCheckView } from "../devCheckNow";
import { updateButtonShown } from "../updateButton";
import { betaAvailable } from "../../core/updates/updates";
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
import { UNDO_SEND_CHOICES, type UndoSendSeconds } from "../../core/mail/undoSend";
import { FILTER_LABELS } from "../../core/model/signals";
import type { ContactsAccessState, ImagePolicy } from "../../core/store/store";
import { APPEARANCES, CUSTOM_ACCENT, type AccentPreference, type Appearance } from "../../core/model/appearance";
import { CustomAccentField, CUSTOM_SWATCH_IDLE } from "./CustomAccentField";
import { formatRelative } from "../../core/mail/datetime";
import type { FeedbackEvent } from "../../core/learn/learning";
import type { FilterLearning, LearnableFilter } from "../../core/learn/filterLearning";
import { SmartFilterSettings } from "./SmartFilterSettings";
import { SelectMenu } from "./SelectMenu";
import type { CensorLevel } from "../../core/mail/censor";

/** Blur sensitive info's steps, each adding to the one before it. */
const CENSOR_CHOICES: { value: CensorLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "emails", label: "Email addresses" },
  { value: "passwords", label: "+ Passwords" },
  { value: "addresses", label: "+ Postal addresses" },
  { value: "names", label: "+ Names" },
];
import { useShortcutsAvailable } from "../physicalKeyboard";
import { remotePicturesPaused } from "../senderPictures";
import type { AccountSummary } from "../../core/store/store";
import { accountsSummary } from "../accountsPage";
import type { UpdatesController } from "../useUpdates";
import { operatorUpdate } from "../../core/updates/updates";
import { buttonClass } from "../button";
import { Icon } from "./Icon";

/** Where Winnow's code lives, linked from About. */
export const SOURCE_URL = "https://github.com/hxmbl/winnow";

/** Under a remote-picture switch that is on but paused by Remote images = Never. */
const REMOTE_PAUSED_HINT = "Paused: Remote images is set to Never";

/** How often the desktop app checks for mail while closed. */
const SYNC_INTERVALS: readonly { value: number; label: string }[] = [
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
  { value: 3600, label: "Every hour" },
];

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
  oled: "Very dark",
};

/** One accent as the picker shows it: its name and a swatch in the current mode. */
export type AccentChoice = { id: AccentPreference; label: string; swatch: string };

// ── Settings ────────────────────────────────────────────────────────────────

export type SettingsProps = {
  /** Offline saving for the open account (`core/offline/offlineSave.ts`); absent in tests and older callers. */
  offline?: OfflineView;
  onOfflineSave?: (on: boolean) => void;
  onRemoveDownloads?: () => void;
  sortBy: SortBy;
  onSortBy: (sort: SortBy) => void;
  appearance: Appearance;
  onAppearance: (value: Appearance) => void;
  /** The accent theme in force, and the choices with a swatch drawn in the current mode. */
  accentTheme: AccentPreference;
  accentChoices: readonly AccentChoice[];
  onAccentTheme: (value: AccentPreference) => void;
  /**
   * The custom colour as picked (1.4.0) and whether the mode on screen had to move it for
   * contrast; and the setter, which also selects Custom.
   */
  accentCustom: { value: string; adjusted: boolean };
  onAccentCustom: (hex: string) => void;
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
  /** Blur sensitive info on screen. See `Preferences.censorLevel`. */
  censorLevel: CensorLevel;
  onCensorLevel: (value: CensorLevel) => void;
  /** Email dark mode: message bodies drawn dark in the dark modes. See `Preferences.emailDarkMode`. */
  emailDarkMode: boolean;
  onEmailDarkMode: (value: boolean) => void;
  /** How long Send waits for Undo. 5s by default; see `Preferences.undoSendSeconds`. */
  undoSendSeconds: UndoSendSeconds;
  onUndoSendSeconds: (value: UndoSendSeconds) => void;
  /** What send later and snooze hold on this device, for the Compose row (1.4.0). */
  scheduledCount?: number;
  snoozedCount?: number;
  /** Open the Scheduled list (closing Settings). */
  onOpenScheduled?: () => void;
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
  unreadBadge: boolean;
  onUnreadBadge: (value: boolean) => void;
  onNotificationSettings: (patch: { notificationActions?: NotificationActions; notificationHidePreview?: boolean }) => void;
  /**
   * Whether this build can keep syncing with the window closed (`info.backgroundSync`):
   * true in the desktop app, false in the Android app, null on the web or before the
   * platform has answered. Only decides whether the switch is offered.
   */
  backgroundSyncAvailable: boolean | null;
  /** The user's choice (`preferences.backgroundSync`): what the switch shows. */
  backgroundSync: boolean;
  /** `info.os === "android"`: the switch runs the background service, with no interval. */
  isAndroid?: boolean;
  /**
   * Android: the background service's status, and its two system dialogs (battery
   * restrictions, the persistent notification's settings). Absent elsewhere.
   */
  backgroundService?: {
    status: BackgroundServiceStatus | null;
    onAllowBackground: () => void;
    onHideNotification: () => void;
    /** "Instant mail via the Gmail app" (STRM-442): the preference and its switch. */
    gmailListener: boolean;
    onGmailListener: (value: boolean) => void;
    /** Android's Notification access screen. */
    onNotificationAccess: () => void;
  } | null;
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
  /** 1.4.0: the signed-in accounts (or the demo's two), counted on the Accounts row. */
  accounts?: readonly AccountSummary[];
  /** Open the Accounts page (1.5), where each account's controls live. */
  onManageAccounts?: () => void;
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
  /** "Big files as Drive links" in Privacy: the local offer switch, and the grant as Google has it. */
  driveLinks: boolean;
  onDriveLinks: (value: boolean) => void;
  driveAccess: DriveAccess | null;
  /** Google's account page, where the grant can be removed. */
  onOpenGooglePermissions: () => void;
  /** Start the incremental-consent flow for the two contact scopes. */
  onImproveSuggestions: () => void;
  /** Which Winnow this is, for About: "Winnow 1.0.1", and where it runs. */
  version?: string | null;
  platformLabel?: string | null;
  /** Update checks (`useUpdates.ts`), for About. Absent in tests that do not need them. */
  updates?: UpdatesController | null;
  /** Dev Options is listed: unlocked by ten taps on About's version (`ui/devOptions.ts`). */
  devUnlocked: boolean;
  onUnlockDev: () => void;
  /** "Hide Dev Options": locks the category again and turns every switch in it off. */
  onHideDev: () => void;
  /** Dev Options → Pure Plain Text (`ui/devOptions.ts`): plain text exactly as sent. */
  purePlainText: boolean;
  onPurePlainText: (value: boolean) => void;
  /** Dev Options → View Original: the reader's ⋯ menu offers the raw source. */
  viewOriginal: boolean;
  onViewOriginal: (value: boolean) => void;
  /** Dev Options → Show filter scores: "Why it's here" shows its numbers. */
  filterScores: boolean;
  onFilterScores: (value: boolean) => void;
  /** Dev Options → Beta updates: update checks consider pre-releases (native builds only). */
  betaUpdates?: boolean;
  onBetaUpdates?: (value: boolean) => void;
  /** Dev Options → Debug log: record sync, update and notification events in memory. */
  debugLog: boolean;
  onDebugLog: (value: boolean) => void;
  /** Dev Options → Send test notification; absent on the web build and Docker (no native notifier). */
  onTestNotification?: () => Promise<TestNotificationResult>;
  /** The category Settings opens on (on a phone, straight to its page). Reading unless a caller has a reason. */
  initialCategory?: CategoryId;
  /** About › "Show the tour again": closes Settings and plays the first-run tour. */
  onShowTour?: () => void;
  /** Opens a page in the system browser (About → Source code). */
  onOpenLink?: (url: string) => void;
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
  "inline-flex items-center gap-1.5 rounded-ctl px-2 py-1.5 text-ui font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring";

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
  /**
   * The phone's two screens: the category list, or one category's page. A caller that
   * names a category (the Accounts page's link to Google account) opens on its page.
   */
  const [phonePage, setPhonePage] = useState<"list" | "category">(props.initialCategory ? "category" : "list");
  const [info, dispatchInfo] = useReducer(infoReducer, INFO_CLOSED);
  const shortcutsAvailable = useShortcutsAvailable();
  const categories = visibleCategories({ shortcuts: shortcutsAvailable, dev: props.devUnlocked });
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

  // A category that is not offered here (Keyboard shortcuts on a touch-only device with
  // no keyboard yet) is never the one shown.
  useEffect(() => {
    if (!categories.includes(explain.category)) setExplain((state) => selectCategory(state, categories[0]));
  }, [categories, explain.category]);

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
                          className="flex min-h-12 w-full items-center justify-between gap-3 rounded-ctl px-3 text-left text-read font-medium text-ink-body transition-colors active:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                        >
                          {categoryOf(id).label}
                          <Icon icon={ChevronRight} size={20} className="text-ink-subtle" />
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
                    // A small chevron in full ink (the owner's call, 1.3.3): small, so it
                    // does not compete with the title, but never faint. The 44px tap
                    // target stays; only the drawn glyph is small.
                    className="flex h-11 w-9 items-center justify-center rounded-ctl text-ink transition-colors active:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <Icon icon={ChevronLeft} size={20} />
                  </button>
                  <h2
                    ref={pageHeadingRef}
                    tabIndex={-1}
                    data-settings-title=""
                    className="text-read font-semibold text-ink outline-hidden"
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
              <Icon icon={ArrowLeft} size={16} />
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
                    className={`rounded-ctl px-2.5 py-2 text-left text-ui leading-snug wrap-anywhere transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
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
              <p className="text-meta font-semibold text-ink-muted">Settings</p>
              <h2 data-settings-title="" className="mt-0.5 text-title font-semibold text-ink">
                {category.label}
              </h2>
            </div>
            <div
              data-select-scope=""
              data-settings-body=""
              className="selectable scroll-shadow thin-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-8"
            >
              <div className="max-w-160">{content}</div>
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
              className="min-h-0 overflow-y-auto px-8 pt-19"
            >
              <p className="text-meta font-semibold text-ink-muted">
                {explanation.kind === "intro" ? "About this section" : "About this setting"}
              </p>
              <h3 className="mt-1 text-read font-semibold text-ink">{explanation.title}</h3>
              <p className="mt-2 max-w-md text-ui leading-relaxed text-ink-muted">{explanation.body}</p>
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

/**
 * About's version, which is also the way into Dev Options: ten taps unlock it, with a
 * countdown from the seventh (`devUnlockTap`). A single tap does nothing else, as the
 * plain text it replaced did nothing; the top bar's version shortcut and update button
 * are separate elements and are not involved. A button so a keyboard can reach it too.
 */
function VersionLabel({ version, unlocked, onUnlock }: { version: string; unlocked: boolean; onUnlock: () => void }) {
  const taps = useRef(0);
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), DEV_TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <>
      <button
        type="button"
        data-version-label=""
        onClick={() => {
          const step = devUnlockTap(taps.current, unlocked);
          taps.current = step.taps;
          if (step.toast) setToast({ text: step.toast, at: Date.now() });
          if (step.unlock) onUnlock();
        }}
        className="rounded-ctl px-1 text-meta font-semibold tabular-nums text-ink-body focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {version}
      </button>
      <p
        role="status"
        aria-live="polite"
        data-dev-toast=""
        className={`pointer-events-none fixed bottom-[calc(var(--wn-phone-tabs,env(safe-area-inset-bottom,0px))+1.5rem)] left-1/2 z-50 -translate-x-1/2 rounded-ctl bg-ink px-4 py-2 text-meta font-medium text-surface shadow-pane transition-opacity ${
          toast ? "opacity-100" : "opacity-0"
        }`}
      >
        {toast?.text ?? ""}
      </p>
    </>
  );
}

/** How long the unlock countdown's toast stays. */
const DEV_TOAST_MS = 2_000;

/** Dev Options → Pure Plain Text's one-line description, under its name. */
const PURE_PLAIN_TEXT_HINT = "Show plain text exactly as sent, with nothing removed";

/** One category's controls. Every setting row names its catalog id with `setting="…"`. */
function CategoryContent({ category, props }: { category: CategoryId; props: SettingsProps }) {
  /** Opens the custom colour's native picker; set by `CustomAccentField`. */
  const openCustomPicker = useRef<(() => void) | null>(null);
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
            <SelectMenu
              id="undo-send"
              label={SETTINGS.undoSend.label}
              options={UNDO_SEND_CHOICES.map((seconds) => ({
                value: seconds,
                label: seconds === 0 ? "Off" : `${seconds} seconds`,
                ariaLabel: seconds === 0 ? "Undo send off" : `Wait ${seconds} seconds`,
              }))}
              value={props.undoSendSeconds}
              onChange={props.onUndoSendSeconds}
            />
          </Row>
          <Row
            setting="sendLater"
            hint={`${props.scheduledCount ?? 0} scheduled · ${props.snoozedCount ?? 0} snoozed, on this device`}
          >
            {props.onOpenScheduled ? (
              <button
                type="button"
                data-settings-open-scheduled=""
                onClick={props.onOpenScheduled}
                className={buttonClass("secondary")}
              >
                Open Scheduled
              </button>
            ) : (
              <span />
            )}
          </Row>
        </Section>
      );
    case "appearance":
      return (
        <Section>
          <Row setting="themeMode">
            <SelectMenu
              id="theme-mode"
              label={SETTINGS.themeMode.label}
              options={APPEARANCES.map((option) => ({ value: option, label: APPEARANCE_LABELS[option] }))}
              value={props.appearance}
              onChange={props.onAppearance}
            />
          </Row>
          <RadioCards
            id="winnow-theme-accent"
            setting="accent"
            options={props.accentChoices.map((choice) => ({
              value: choice.id,
              label: choice.label,
              // Custom shows a soft colour wheel until it is the accent, then its colour.
              swatch: choice.id === CUSTOM_ACCENT && props.accentTheme !== CUSTOM_ACCENT ? CUSTOM_SWATCH_IDLE : choice.swatch,
            }))}
            value={props.accentTheme}
            onChange={props.onAccentTheme}
            onOptionClick={(value) => {
              if (value === CUSTOM_ACCENT) openCustomPicker.current?.();
            }}
            after={
              <CustomAccentField
                active={props.accentTheme === CUSTOM_ACCENT}
                value={props.accentCustom.value}
                adjusted={props.accentCustom.adjusted}
                onChange={props.onAccentCustom}
                openRef={openCustomPicker}
              />
            }
          />
          <Row setting="emailDarkMode">
            <Toggle checked={props.emailDarkMode} onChange={props.onEmailDarkMode} label={SETTINGS.emailDarkMode.label} />
          </Row>
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
          <Row setting="censorLevel">
            <SelectMenu
              id="censor-level"
              label={SETTINGS.censorLevel.label}
              options={CENSOR_CHOICES}
              value={props.censorLevel}
              onChange={props.onCensorLevel}
            />
          </Row>
          {/*
            Remote images: three states, because there are three intentions.

            This was a toggle, and a toggle has two positions. "Load" and "don't load"
            cannot say the third thing a user actually wants, which is *stop asking* —
            and that is not the same as "never": somebody who has been asked three times
            wants their mail to look like mail.

            A dropdown since 1.3.3 (it was a segmented control): one setting with three
            values, and "Ask each time" made the row too wide for a phone.
          */}
          <Row setting="remoteImages">
            <SelectMenu
              id="remote-images"
              label={SETTINGS.remoteImages.label}
              options={IMAGE_POLICY_CHOICES.map((choice) => ({
                value: choice.value,
                label: choice.label,
                disabled: !props.canLoadRemoteContent && choice.value !== "never",
              }))}
              value={props.imagePolicy}
              onChange={props.onImagePolicy}
            />
          </Row>
          <Row setting="brandLogos" hint={remotePicturesPaused(props.imagePolicy) && props.brandLogos ? REMOTE_PAUSED_HINT : undefined}>
            <Toggle checked={props.brandLogos} onChange={props.onBrandLogos} label="Show brand logos" />
          </Row>
          <Row setting="gravatars" hint={remotePicturesPaused(props.imagePolicy) && props.gravatars ? REMOTE_PAUSED_HINT : undefined}>
            <Toggle checked={props.gravatars} onChange={props.onGravatars} label="Gravatar photos" />
          </Row>
          <DriveLinksRow props={props} />
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
                        className={`rounded-ctl px-2.5 py-1 text-meta font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
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
          <Row setting="unreadBadge">
            <Toggle checked={props.unreadBadge} onChange={props.onUnreadBadge} label="Unread count on the app icon" />
          </Row>
          <OfflineMailRows props={props} />
          {(() => {
            /*
              The switch shows the preference, never the capability. It used to read
              `info.backgroundSync`, so in the Android app (which reports false) it sat at
              Off whatever was tapped, and on the desktop it sat at On, so turning it off
              paused automatic sync where nobody could see it and it never came back on.
            */
            const offer = backgroundSyncOffer({
              isNative: props.isDesktop,
              available: props.backgroundSyncAvailable,
              android: props.isAndroid === true,
            });
            if (offer === "service") {
              // Android: the switch starts and stops the background service (STRM-427).
              const service = props.backgroundService ?? null;
              const status = service?.status ?? null;
              const instant = service?.gmailListener === true;
              const hint = backgroundServiceHint(
                { backgroundSync: props.backgroundSync, notificationsEnabled: props.notificationsEnabled, gmailListener: instant },
                status,
              );
              const working = props.backgroundSync && props.notificationsEnabled;
              const instantHint = gmailListenerHint(instant, status);
              return (
                <>
                  <Row setting="backgroundSync" hint={hint ?? undefined} hintId="winnow-background-sync-hint">
                    <span data-background-sync="service" data-background-running={status?.running ? "" : undefined} className="contents">
                      <Toggle checked={props.backgroundSync} onChange={props.onBackgroundSync} label="Keep syncing while closed" describedBy={hint ? "winnow-background-sync-hint" : undefined} />
                    </span>
                  </Row>
                  {working && status && !status.batteryUnrestricted && (
                    <Row setting="batteryUnrestricted" hint="Without it, Android can delay new mail while the phone is idle.">
                      <button
                        type="button"
                        data-background-battery=""
                        onClick={service?.onAllowBackground}
                        className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        Allow
                      </button>
                    </Row>
                  )}
                  {working && service && (
                    <Row setting="gmailListener" hint={instantHint ?? undefined} hintId="winnow-gmail-listener-hint">
                      <span data-gmail-listener={instant ? "on" : "off"} data-gmail-listener-connected={status?.listenerConnected ? "" : undefined} className="contents">
                        <Toggle checked={instant} onChange={service.onGmailListener} label="Instant mail via the Gmail app" describedBy={instantHint ? "winnow-gmail-listener-hint" : undefined} />
                      </span>
                    </Row>
                  )}
                  {working && service && instant && (
                    <Row setting="gmailListenerAccess" hint={status?.listenerAccess ? "Allowed. Change it in Android's settings." : "Not allowed yet."}>
                      <button
                        type="button"
                        data-gmail-listener-access={status?.listenerAccess ? "granted" : "missing"}
                        onClick={service.onNotificationAccess}
                        className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        {status?.listenerAccess ? "Open" : "Allow"}
                      </button>
                    </Row>
                  )}
                  {working && (
                    <Row setting="syncNotification" hint="Silent. Hiding it doesn't stop syncing.">
                      <button
                        type="button"
                        data-background-hide-notification=""
                        onClick={service?.onHideNotification}
                        className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        Hide it
                      </button>
                    </Row>
                  )}
                </>
              );
            }
            if (offer === "switch") {
              return (
                <>
                  <Row setting="backgroundSync">
                    <Toggle checked={props.backgroundSync} onChange={props.onBackgroundSync} label="Keep syncing while closed" />
                  </Row>
                  {props.backgroundSync && (
                    <Row setting="syncInterval">
                      <SelectMenu
                        id="sync-interval"
                        label="Check for new mail every"
                        options={SYNC_INTERVALS}
                        value={props.backgroundSyncInterval}
                        onChange={props.onBackgroundSyncInterval}
                      />
                    </Row>
                  )}
                </>
              );
            }
            return (
              <p data-settings-empty="" data-background-sync-note={offer} className="pt-2 text-meta text-ink-subtle">
                {BACKGROUND_SYNC_NOTE[offer]}
              </p>
            );
          })()}
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
              className="grid max-w-136 grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)] items-baseline gap-x-5 gap-y-1.5"
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
            <VersionLabel version={props.version ?? "Unknown"} unlocked={props.devUnlocked} onUnlock={props.onUnlockDev} />
          </Row>
          {props.updates && <UpdateSettings updates={props.updates} />}
          {props.onShowTour && (
            <Row setting="tour">
              <button type="button" data-show-tour="" onClick={props.onShowTour} className={SECONDARY_BUTTON}>
                Show the tour again
              </button>
            </Row>
          )}
          <Row setting="source">
            <a
              href={SOURCE_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-source-link=""
              onClick={(event) => {
                if (!props.onOpenLink) return;
                event.preventDefault();
                props.onOpenLink(SOURCE_URL);
              }}
              className="text-meta font-semibold text-ink-body underline underline-offset-2 hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              github.com/hxmbl/winnow
            </a>
          </Row>
          <Row setting="licence">
            <span className="text-meta font-semibold text-ink-body">MIT</span>
          </Row>
        </Section>
      );
    case "dev":
      return (
        <Section>
          <Row setting="purePlainText" hint={PURE_PLAIN_TEXT_HINT} hintId="winnow-pure-plain-text-hint">
            <Toggle
              checked={props.purePlainText}
              onChange={props.onPurePlainText}
              label={SETTINGS.purePlainText.label}
              describedBy="winnow-pure-plain-text-hint"
            />
          </Row>
          <Row setting="viewOriginal" hint="Adds View Original to a message's ⋯ menu: raw headers and MIME parts" hintId="winnow-view-original-hint">
            <Toggle
              checked={props.viewOriginal}
              onChange={props.onViewOriginal}
              label={SETTINGS.viewOriginal.label}
              describedBy="winnow-view-original-hint"
            />
          </Row>
          <Row setting="filterScores" hint="Adds the numbers behind “Why it's here”" hintId="winnow-filter-scores-hint">
            <Toggle
              checked={props.filterScores}
              onChange={props.onFilterScores}
              label={SETTINGS.filterScores.label}
              describedBy="winnow-filter-scores-hint"
            />
          </Row>
          {props.onTestNotification && <TestNotificationRow send={props.onTestNotification} />}
          {props.updates && updateButtonShown(props.updates.runtime) && <DevCheckNowRow updates={props.updates} />}
          {props.updates && betaAvailable(props.updates.runtime) && props.onBetaUpdates && (
            <Row setting="betaUpdates" hint="Also offers pre-releases like 1.6.0-beta.1; off never downgrades" hintId="winnow-beta-updates-hint">
              <Toggle
                checked={props.betaUpdates === true}
                onChange={props.onBetaUpdates}
                label={SETTINGS.betaUpdates.label}
                describedBy="winnow-beta-updates-hint"
              />
            </Row>
          )}
          <Row setting="debugLog" hint="Sign-in, sync, network and app events, in memory, redacted" hintId="winnow-debug-log-hint">
            <Toggle
              checked={props.debugLog}
              onChange={props.onDebugLog}
              label={SETTINGS.debugLog.label}
              describedBy="winnow-debug-log-hint"
            />
          </Row>
          <DebugLogPanel recording={props.debugLog} />
          <div className="pt-4">
            <button type="button" data-hide-dev-options="" onClick={props.onHideDev} className={SECONDARY_BUTTON}>
              Hide Dev Options
            </button>
            <p className="mt-1.5 text-meta text-ink-subtle">Turns every switch here off and hides this section again.</p>
          </div>
        </Section>
      );
  }
}

const TEST_NOTIFICATION_STATUS: Record<TestNotificationResult, string> = {
  sent: "Sent. Its buttons change nothing in your mailbox.",
  denied: "Notifications aren't allowed for Winnow on this device.",
  failed: "Couldn't post the test notification.",
};

/** Dev Options → Send test notification (native builds only), with what happened under it. */
function TestNotificationRow({ send }: { send: () => Promise<TestNotificationResult> }) {
  const [state, setState] = useState<"idle" | "sending" | TestNotificationResult>("idle");
  const hint = state === "idle" ? "A sample, through the real notification path" : state === "sending" ? "Sending…" : TEST_NOTIFICATION_STATUS[state];
  return (
    <Row setting="testNotification" hint={hint} hintId="winnow-test-notification-hint">
      <button
        type="button"
        data-dev-test-notification={state}
        aria-describedby="winnow-test-notification-hint"
        disabled={state === "sending"}
        onClick={() => {
          setState("sending");
          void send().then(setState, () => setState("failed"));
        }}
        className={`${SECONDARY_BUTTON} disabled:opacity-60`}
      >
        Send test notification
      </button>
    </Row>
  );
}

/**
 * Dev Options → Check now (native builds only): About's Check now, with the answer
 * inline (`ui/devCheckNow.ts`). Only checks; installing stays in About.
 */
function DevCheckNowRow({ updates }: { updates: UpdatesController }) {
  const [asked, setAsked] = useState(false);
  const view = devCheckView(asked, updates.status, updates.offer, updates.message);
  return (
    <Row setting="devCheckNow" hint={view.line ?? "Ignores the schedule; never installs"} hintId="winnow-dev-check-now-hint">
      <button
        type="button"
        data-dev-check-now={view.state}
        aria-describedby="winnow-dev-check-now-hint"
        disabled={updates.status === "checking" || updates.status === "installing"}
        onClick={() => {
          setAsked(true);
          updates.checkNow();
        }}
        className={`${SECONDARY_BUTTON} disabled:opacity-60`}
      >
        Check now
      </button>
    </Row>
  );
}

/**
 * About › Updates: the automatic-check switch, then what the last check found and the
 * one thing to do about it (Check now, Update, or what the operator runs: the git pull
 * for a web copy, a restart for the Docker image).
 */
function UpdateSettings({ updates }: { updates: UpdatesController }) {
  const { offer, status } = updates;
  const busy = status === "checking" || status === "installing";
  const line = offer
    ? `Winnow ${offer.version} is available (you have ${offer.current}).`
    : status === "checking"
      ? "Checking…"
      : status === "current"
        ? "You're up to date."
        : null;
  const operator = offer ? operatorUpdate(offer) : null;
  const button =
    offer && !operator
      ? { label: offer.action.kind === "page" ? "Download" : "Update", onClick: updates.install }
      : { label: "Check now", onClick: updates.checkNow };
  return (
    <>
      <Row setting="updates" hint={line ?? undefined}>
        <Toggle checked={updates.auto} onChange={updates.setAuto} label="Check for updates automatically" />
      </Row>
      <div data-settings-updates={offer ? offer.action.kind : status} className="flex flex-col gap-2 pb-1">
        {operator && (
          <p className="text-meta text-ink-muted">
            {operator.before}{" "}
            <code className="selectable rounded-ctl bg-surface-sunken px-1 py-0.5 font-mono text-ink-body">{operator.command}</code>
            {operator.after && ` ${operator.after}`}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-update-action=""
            disabled={busy}
            onClick={button.onClick}
            className={`${SECONDARY_BUTTON} disabled:opacity-60`}
          >
            {status === "installing" ? "Updating…" : button.label}
          </button>
          {offer && (
            <button type="button" data-update-whats-new="" onClick={updates.openWhatsNew} className={SECONDARY_BUTTON}>
              What's new
            </button>
          )}
        </div>
        {updates.message && (
          <p role="status" data-update-message="" className="selectable text-meta text-ink-muted">
            {updates.message}
          </p>
        )}
      </div>
    </>
  );
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
          <SelectMenu
            id="sort-by"
            label={SETTINGS.sortBy.label}
            options={SORT_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
            value={props.sortBy}
            onChange={props.onSortBy}
          />
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
                  className="rounded-ctl bg-danger px-3 py-1.5 text-meta font-semibold text-surface transition-opacity hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
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
                  <Icon icon={RotateCcw} size={12} />
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
  buttonClass("secondary", "sm");

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

/** Big files as Drive links (status words in `core/gmail/drive`). */
/**
 * Settings → Notifications & sync → Save mail offline: the large-mailbox question's
 * answer, the download's progress ("Saved 1,234 of 1,500 · 312 MB"), and Remove downloads.
 * Only shown for a signed-in account on a host with a durable store.
 */
function OfflineMailRows({ props }: { props: SettingsProps }) {
  const view = props.offline;
  if (!view?.available) return null;
  const on = view.decision === "on";
  const saved = view.progress?.saved ?? 0;
  return (
    <>
      <Row setting="offlineMail" hint={offlineSummary(view)} hintId="winnow-offline-mail-hint">
        <span data-offline-mail={view.progress?.state ?? "idle"} data-offline-saved={saved} data-offline-total={view.progress?.total ?? 0} className="contents">
          <Toggle checked={on} onChange={(value) => props.onOfflineSave?.(value)} label="Save mail offline" />
        </span>
      </Row>
      {(saved > 0 || on) && (
        <Row setting="removeDownloads">
          <button
            type="button"
            data-offline-remove=""
            onClick={() => props.onRemoveDownloads?.()}
            className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Remove downloads
          </button>
        </Row>
      )}
    </>
  );
}

function DriveLinksRow({ props }: { props: SettingsProps }) {
  return (
    <>
      <Row setting="driveLinks" hint={driveLinksStatus(props.driveAccess, props.driveLinks)}>
        <Toggle checked={props.driveLinks} onChange={props.onDriveLinks} label="Big files as Drive links" />
      </Row>
      {props.driveAccess === "granted" && (
        <div data-drive-settings="" className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-drive-revoke=""
            onClick={props.onOpenGooglePermissions}
            className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Remove at Google
          </button>
          <span className="text-meta text-ink-subtle">Google removes all of Winnow's access at once, so you'll sign in again.</span>
        </div>
      )}
    </>
  );
}

/**
 * The accounts on this device, as one row that opens the Accounts page (1.5), where
 * each account's colour, notifications and sign-out now live, so they are not in two
 * places.
 */
function AccountsSettings({ props }: { props: SettingsProps }) {
  return (
    <Section title="Accounts">
      <Row setting="accounts" hint={accountsSummary(props.accounts ?? [])}>
        <button
          type="button"
          data-settings-manage-accounts=""
          onClick={props.onManageAccounts}
          className={buttonClass("secondary", "sm", "gap-1")}
        >
          Manage
          <Icon icon={ChevronRight} size={16} />
        </button>
      </Row>
    </Section>
  );
}

function GoogleSettings({ props }: { props: SettingsProps }) {
  return (
    <>
    <AccountsSettings props={props} />
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
          className={buttonClass("secondary", "sm")}
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
                <Icon icon={Check} size={12} /> Connected
              </span>
            ) : (
              <button
                type="button"
                onClick={props.onImproveSuggestions}
                disabled={props.contactsBusy}
                className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
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
                  className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
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
    </>
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
                    <Icon icon={Check} size={12} />
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
                    <Icon icon={Check} size={12} />
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
  buttonClass("secondary", "sm");
