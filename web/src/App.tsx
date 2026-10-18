/**
 * The application.
 *
 * The only file that knows about all three of the store, the platform, and React.
 * Everything it does is wiring — the store owns the logic, the platform owns the OS, and
 * the components own the pixels.
 *
 * Three responsibilities are worth naming:
 *
 * 1. **The keyboard.** One `keydown` listener on `window`, resolved through
 *    `core/mail/keybinds.ts` — on `window` rather than a container because focus is
 *    wherever the last click left it, and a scoped listener would stop working the moment
 *    a sheet took focus.
 * 2. **The theme.** Resolved from the preference against the OS and applied as CSS custom
 *    properties rather than a class, so switching schemes is one property sweep, not a
 *    re-render of every styled element.
 * 3. **The layout.** Panes sit apart on a tinted canvas so each reads as its own object;
 *    on small screens the reader covers the list outright, since there is nothing
 *    underneath to be above.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogIn, RefreshCw, X } from "lucide-react";
import {
  NO_CURSOR,
  readoutIndex,
  STORAGE_PROMPT,
  STORAGE_SAVE_FAILED,
  WinnowStore,
  MAILBOX_ORDER,
  type Snapshot,
} from "./core/store/store";
import { commandForKey, shouldSwallow, type KeyContext } from "./core/mail/keybinds";
import {
  badgeFilters,
  FILTER_LABELS,
  NAVIGATION_ITEMS,
} from "./core/model/signals";
import { displayName, MAILBOX_LABEL, type Email, type Mailbox } from "./core/model/email";
import { buildForward, buildReply, stripQuote, withReplyAll } from "./core/mail/reply";
import {
  DraftAutosaver,
  LocalDrafts,
  draftContextKey,
  draftRowFrom,
  reopenDraft,
  type DraftSaveStatus,
  type LocalDraft,
} from "./core/mail/drafts";
import {
  buildNewDraft,
  draftFromMailto,
  isUntouchedNewDraft,
  needsSubjectConfirmation,
} from "./core/mail/compose";
import { attentionSentence } from "./core/classify/attention";
import { formatRelative } from "./core/mail/datetime";
import { resolveImageConsent } from "./core/mail/imageConsent";
import type { Draft, GmailId } from "./core/model/email";
import { DEMO_ACCOUNT, demoMailbox } from "./core/data/demo";
import { createSessionBridge, type SessionBridge } from "./core/session/bridge";
import type { DraftsAccess } from "./core/session/session";
import { readOwnParams } from "./core/session/redirect";
import { DelayedSend } from "./core/mail/undoSend";
import { desktopPlatformExtras, platform, type PlatformInfo } from "./platform";
import type { AppSigningInfo } from "./platform/types";
import { POPOVER_SELECTOR, backTarget, isSheetElement, type BackState } from "./ui/backLayers";
import { useStore } from "./ui/useStore";
import { useOnline } from "./ui/useOnline";
import { syncStatus } from "./ui/syncStatus";
import { ACCENTS, applyTheme, paletteFor, resolveScheme } from "./ui/theme";
import { ACCENT_THEMES } from "./core/model/appearance";
import { Masthead } from "./ui/components/Masthead";
import { PhoneDock, PhoneTopBar } from "./ui/components/PhoneChrome";
import { PullRefresh } from "./ui/components/PullRefresh";
import { scrollListToTop } from "./ui/listScroll";
import { useKeyboardInset, usePhoneLayout } from "./ui/usePhoneLayout";
import { Sidebar, type NavProps } from "./ui/components/MailNav";
import { buildPills } from "./ui/rail";
import MessageList from "./ui/components/MessageList";
import type { SwipeAction } from "./ui/swipe";
import { Reader } from "./ui/components/Reader";
import { ReaderSplitHandle } from "./ui/components/ReaderSplitHandle";
import { ShortcutSheet } from "./ui/components/ShortcutSheet";
import { NavigationPalette } from "./ui/components/NavigationPalette";
import { Composer } from "./ui/components/Composer";
import { SendingStrip } from "./ui/components/SendingStrip";
import { LabelPicker } from "./ui/components/LabelPicker";
import { Settings } from "./ui/components/SettingsPanel";
import { ConfirmDialog } from "./ui/components/Overlay";
import { ErrorText } from "./ui/components/ErrorText";
import { isSelectAll, selectAllScope } from "./ui/textSelection";
import { SignInScreen } from "./ui/SignInScreen";
import { GoogleSetup, SETUP_GUIDE_URL } from "./ui/components/GoogleSetup";
import { describeFailure } from "./core/session/errors";
import { maskClientId, type OAuthClientCredentials } from "./core/session/credentials";
import { Menu } from "./ui/components/Menu";
import { anchorFromElement, type MenuAnchor } from "./ui/menuPlacement";
import { SelectionBar } from "./ui/components/SelectionBar";
import { buildRowMenu, buildSenderMenu } from "./ui/menus";
import {
  EMPTY_SELECTION,
  orderedSelection,
  pruneSelection,
  toggleId,
  type Selection,
} from "./ui/selection";
import { mailtoAddress } from "./core/mail/unsubscribe";
import { copyText } from "./ui/clipboard";
import { CodeBar } from "./ui/components/CodeCopy";
import { Avatar } from "./ui/components/Avatar";
import { imageProbe, SenderPicturesContext, type SenderPictures } from "./ui/senderPictures";
import { GravatarCache } from "./core/avatars/gravatar";
import { contactPhotoMap } from "./core/avatars/photos";
import { BrandLogoCache } from "./core/avatars/logoCache";
import { dohResolver } from "./core/avatars/bimi";
import { contactsFailureNotice } from "./core/gmail/people";
import { DEMO_LOGO_SOURCE } from "./ui/demoPictures";

/** Which popover menu is open, and what it acts on. */
type OpenMenu = {
  kind: "sender" | "row";
  /** The message whose sender or row was clicked. */
  id: number;
  /** For a row menu: the messages it acts on (the selection, or just `id`). */
  ids: number[];
  anchor: MenuAnchor;
  /** Gets focus back when the menu closes by Escape or a choice. */
  trigger: HTMLElement | null;
};

type Props = {
  /** The one piece of global state. Everything else is derived from it. */
  store: WinnowStore;
};

/**
 * Whether the one-time session restore has already been started.
 *
 * Module scope on purpose: a `useRef` would be reset by StrictMode's teardown-and-rebuild
 * — the very thing it is meant to survive — and a `useState` would render differently on
 * the second pass, a StrictMode warning of its own.
 */
let sessionRestoreStarted = false;

/**
 * How stale Google contacts may get before opening the composer refreshes them.
 *
 * Fifteen minutes: an incremental refresh is one cheap request per listing, but the
 * composer opens far more often than anyone adds a contact.
 */
const CONTACTS_REFRESH_MS = 15 * 60_000;

const HALF_GRANT_MESSAGE =
  "Google did not grant both contact permissions. Tick both boxes on Google's screen to use them.";

/**
 * The composer's state, including what it is for.
 *
 * `mode` drives the title and the body-field behaviour: a forward has no recipient until
 * the user picks one, a reply's does. It also matters to the Escape/discard logic, which
 * needs to know whether there is anything worth keeping.
 */
type ComposerState = {
  draft: Draft;
  sending: boolean;
  error: string | null;
  mode: "reply" | "forward" | "new";
  /**
   * A new message's recipients and subject as it opened (blank, or from a `mailto:`),
   * so closing an untouched one does not ask. Replies and forwards judge by the body.
   */
  initial?: Pick<Draft, "to" | "cc" | "bcc" | "subject">;
  /** The message a reply or forward answers: where it docks, and what it threads on. */
  replyTo?: GmailId;
  /** Reply all (the default) or Reply, for a reply. */
  replyAll?: boolean;
  /** Which draft this is, for the autosave and the device copy. See `draftContextKey`. */
  context: string;
  /** What the autosave last said. */
  status: DraftSaveStatus;
  /**
   * Reopened from the Drafts mailbox: always a sheet (never docked, never parked by
   * the selection moving), closing keeps it rather than asking, and `baseline` is the
   * draft as it opened, so an untouched reopen neither re-saves nor counts as an edit.
   */
  fromDrafts?: { draftId: string; row: Email; baseline: Draft };
};

/**
 * A sent message waiting out its undo window: the composer as it was when Send was
 * pressed, its autosave (still attached to the Gmail draft), and the message a reply
 * threads on.
 */
type PendingSend = { composer: ComposerState; saver: DraftAutosaver | null; inReplyTo?: GmailId };

/** What `startComposer` is given: the composer, less the state it owns itself. */
type ComposerStart = Omit<ComposerState, "sending" | "error" | "status">;

/** A blank new message's recipients and subject, the baseline for "untouched". */
const BLANK_INITIAL: NonNullable<ComposerState["initial"]> = { to: [], cc: [], bcc: [], subject: "" };

/** How long "Draft saved." stays up after a half-written reply is put away, in ms. */
const DRAFT_NOTICE_MS = 4000;

/** `localStorage`, or `null` where reading it throws (storage disabled). */
/** Where this Winnow runs, for Settings → About: "Desktop app · linux x86_64", "Browser". */
function platformLabel(info: PlatformInfo): string {
  if (info.kind === "web") return "Browser";
  if (info.os === "android") return "Android app";
  return `Desktop app · ${info.os}${info.arch && info.arch !== "unknown" ? ` ${info.arch}` : ""}`;
}

function deviceStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The user's own address, for leaving it off a reply-all: the demo's is its seeded account. */
function selfAddressOf(snap: Pick<Snapshot, "contactsAccess" | "account">): string | undefined {
  return snap.account?.email ?? (snap.contactsAccess === "demo" ? DEMO_ACCOUNT.email : undefined);
}

/** Whose drafts these are: the signed-in address, `demo`, or `null` before either. */
function draftAccount(snap: Pick<Snapshot, "contactsAccess" | "account">): string | null {
  if (snap.contactsAccess === "demo") return "demo";
  return snap.account?.email ?? null;
}

/** How long "Message sent." stays up before it clears itself, in ms. */
const SENT_NOTICE_MS = 6000;

/**
 * Whether discarding this draft would lose anything the user wrote.
 *
 * Not "is the body empty" but "is the user's *contribution* empty": a reply's body starts
 * as the quoted original, so `stripQuote` removes an untouched quote suffix, and a
 * forward's baseline is recorded in `Draft.prefilled`.
 *
 * Getting this wrong is not cosmetic: testing the body for emptiness made *every* forward
 * "written", so opening one with `f` and pressing Escape asked whether to throw away text
 * Winnow had just put there — which trains people to click through confirmations.
 */
function isUntouchedDraft(draft: Draft, initial?: ComposerState["initial"]): boolean {
  if (initial) return isUntouchedNewDraft(draft, initial);
  const written = stripQuote(draft.body, draft.quoteBlock).trim();
  return written === (draft.prefilled ?? "").trim();
}

export function App({ store }: Props) {
  const snapshot = useStore(store);
  const { view, preferences } = snapshot;
  /**
   * Brand logos (BIMI), behind "Show brand logos". One cache for the app's lifetime,
   * cleared on sign-out and when the setting is turned off.
   */
  const [logoCache] = useState(
    () =>
      new BrandLogoCache({
        resolve: dohResolver((input, init) => fetch(input, init)),
        isOnline: () => globalThis.navigator?.onLine !== false,
      }),
  );
  /** Gravatar photos, behind "Gravatar photos": the same lifetime and clearing. */
  const [gravatarCache] = useState(() => {
    const isOnline = () => globalThis.navigator?.onLine !== false;
    return new GravatarCache({ probe: imageProbe(isOnline), isOnline });
  });

  // ── Refs the keyboard handler reads ─────────────────────────────────────
  // The handler is registered once and reads through these, because
  // re-registering a `keydown` listener on every state change would mean
  // adding and removing a listener per keystroke — and would race the keypress
  // that triggered the change.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const storeRef = useRef(store);
  storeRef.current = store;

  /**
   * The search input.
   *
   * Held here rather than inside `Masthead` because `/` is routed by the keyboard
   * handler below, which lives in this component. One ref, shared by both — see
   * the note on `Masthead`'s `searchRef` prop.
   */
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollStep, setScrollStep] = useState(0);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  /** The composer as of this render, for the keyboard handler and `openCompose`. */
  const composerRef = useRef<ComposerState | null>(null);
  composerRef.current = composer;

  /**
   * What the sync line and button say. Derived in one place (see `syncStatus`) so a
   * syncing label only ever shows while a sync runs, and an idle one only while none
   * does. `snapshot.now` ticks every minute in live mode, which keeps "3 min ago" true.
   */
  const online = useOnline();
  const sync = syncStatus({
    signedIn: snapshot.account !== null,
    syncing: snapshot.syncing,
    syncPhase: snapshot.syncPhase,
    syncStage: snapshot.syncStage,
    syncFetched: snapshot.syncFetched,
    syncTotal: snapshot.syncTotal,
    lastSyncedAt: snapshot.lastSyncedAt,
    syncError: snapshot.syncError,
    syncFailed: snapshot.syncFailed,
    sending: composer?.sending ?? false,
    online,
    paused: !preferences.backgroundSync,
    now: Math.max(snapshot.now, snapshot.lastSyncedAt ?? 0),
  });

  /**
   * The multi-row selection (drag on the desktop, long-press on a phone). Kept here
   * rather than in the store: it is a gesture's state, never persisted, and the store's
   * single `selectedId` keeps meaning "the open message".
   */
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  /** The phone top bar's height, which the selection bar keeps while it stands in for it. */
  const [phoneBarHeight, setPhoneBarHeight] = useState(0);
  const phoneBarObserver = useRef<ResizeObserver | null>(null);
  const measurePhoneBar = useCallback((element: HTMLDivElement | null) => {
    phoneBarObserver.current?.disconnect();
    phoneBarObserver.current = null;
    if (!element) return;
    setPhoneBarHeight(element.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setPhoneBarHeight(element.getBoundingClientRect().height));
    observer.observe(element);
    phoneBarObserver.current = observer;
  }, []);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;

  /**
   * The phone arrangement: a top bar and a bottom dock instead of the masthead, and the
   * reader's actions at the bottom edge. Same store, same handlers, same components —
   * only where they sit changes. See `usePhoneLayout`.
   */
  const phone = usePhoneLayout();
  // For handlers that are created once and read the layout when they fire.
  const phoneRef = useRef(phone);
  /** The two panes' container, which the reader split is a fraction of. */
  const mainRef = useRef<HTMLElement | null>(null);
  phoneRef.current = phone;

  /**
   * The desktop's floating list header, measured: the list pads its top by this much so
   * its first row clears the glass at rest. A callback ref, since the header unmounts in
   * the phone layout.
   */
  const [listChromeHeight, setListChromeHeight] = useState(0);
  const listChromeObserver = useRef<ResizeObserver | null>(null);
  const measureListChrome = useCallback((element: HTMLDivElement | null) => {
    listChromeObserver.current?.disconnect();
    listChromeObserver.current = null;
    if (!element) return;
    const read = () => setListChromeHeight(Math.round(element.getBoundingClientRect().height));
    read();
    if (typeof ResizeObserver !== "undefined") {
      listChromeObserver.current = new ResizeObserver(read);
      listChromeObserver.current.observe(element);
    }
  }, []);
  /** The list's pane, where the phone's pull to refresh listens. */
  const listPaneRef = useRef<HTMLDivElement | null>(null);
  /** What is waiting on you, for the pull's result; null when nothing is. */
  const attentionRef = useRef<string | null>(null);
  /** A wheel over the floating header scrolls the list under it, except over the rail. */
  const forwardChromeWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-rail-scroller], [role='menu'], [role='dialog']")) return;
    const scroller = event.currentTarget.parentElement?.querySelector<HTMLElement>("[data-row-count]");
    if (!scroller || event.deltaY === 0) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
    scroller.scrollTop += event.deltaY * unit;
  }, []);
  useKeyboardInset(phone && composer !== null);

  // ── Theme ────────────────────────────────────────────────────────────────
  const [systemDark, setSystemDark] = useState(
    () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );

  useEffect(() => {
    const query = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    // Subscribed rather than read once: a user who switches their system to dark
    // at 6pm should not have to reload a mail client to see it.
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const themeMode = resolveScheme(preferences.appearance, systemDark);

  useEffect(() => {
    applyTheme(document.documentElement, themeMode, preferences.accent);
  }, [themeMode, preferences.accent]);

  /** The picker's swatches, drawn in the mode on screen so each one shows what it will look like. */
  const accentChoices = useMemo(
    () =>
      ACCENT_THEMES.map((id) => ({
        id,
        label: ACCENTS[id].label,
        swatch: paletteFor(themeMode, id).color.accent,
      })),
    [themeMode],
  );

  // ── What this build can do ───────────────────────────────────────────────
  // Read once from the OS. Null until it lands, and the UI treats null as "not
  // the desktop build" — the demo mailbox does not care whether there is a tray.
  const [info, setInfo] = useState<PlatformInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void platform.info().then((value) => {
      if (!cancelled) setInfo(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Sign-in ──────────────────────────────────────────────────────────────

  /**
   * Apply a link the user arrived on.
   *
   * Runs whether or not there is a session: a signed-out reader gets the demo mailbox,
   * and a link into the demo is just as followable as one into a real inbox.
   *
   * The order matters: the mailbox is set *after* `connect`, because `connect` resets the
   * view, and the message is opened last, because focusing it only works once its mailbox
   * is on screen.
   *
   * Anything unrecognised is ignored: a link is untrusted input.
   */
  const applySharedLink = useCallback((link: Record<string, string> | null | undefined) => {
    if (!link) return;

    const mailbox = link.view as Mailbox | undefined;
    if (mailbox && Object.hasOwn(MAILBOX_LABEL, mailbox)) store.setMailbox(mailbox);

    const messageId = Number(link.message);
    if (Number.isSafeInteger(messageId) && messageId >= 0) {
      // `focusMessage` switches mailbox itself, so it goes last and wins.
      store.focusMessage(messageId);
    }
  }, [store]);

  const sessionRef = useRef<SessionBridge | null>(null);

  // ── Google contacts ──────────────────────────────────────────────────────

  /**
   * Bring the store's copy of Google's address book up to date.
   *
   * The stored copy is adopted first, so suggestions include it the moment a session
   * connects, and the network refresh follows only when the last one is older than
   * `CONTACTS_REFRESH_MS` (or `force` says so). A failed refresh keeps the stored copy:
   * stale suggestions are still suggestions, and an error banner over the composer for a
   * convenience feature would be out of proportion.
   *
   * With no grant the store is told so, which is what makes the opt-in appear.
   */
  /**
   * Why contacts are connected but not arriving, when the user can fix it: today, the
   * People API switched off in their Cloud project. Shown in Settings with a link.
   */
  const [contactsProblem, setContactsProblem] = useState<{ message: string; url: string | null } | null>(null);
  const syncGoogleContacts = useCallback(async (force = false): Promise<{ message: string; url: string | null } | null> => {
    const bridge = sessionRef.current;
    if (!bridge || !store.getSnapshot().account) return null;
    try {
      const access = await bridge.contactsAccess();
      if (access !== "granted") {
        store.setGoogleContacts([], access);
        return null;
      }
      store.setGoogleContacts(await bridge.cachedContacts(), "granted");
      const last = await bridge.contactsSyncedAt();
      if (!force && last !== null && Date.now() - last < CONTACTS_REFRESH_MS) return null;
      const fresh = await bridge.refreshContacts();
      if (fresh) store.setGoogleContacts(fresh, "granted");
      else store.setGoogleContacts([], await bridge.contactsAccess());
      setContactsProblem(null);
      return null;
    } catch (error) {
      // A failure the user can fix is said where the switch is (Settings → Google
      // contacts); anything else keeps the stored copy and tries again next time.
      const notice = contactsFailureNotice(error);
      if (notice) setContactsProblem(notice);
      else console.warn("winnow: could not refresh Google contacts:", error);
      return notice;
    }
  }, [store]);

  /**
   * The opt-in: "Improve suggestions from Google contacts".
   *
   * Incremental consent through the same platform flow as sign-in. On the desktop this
   * resolves when the user comes back from the browser; on the web it navigates away and
   * the outcome arrives through `completeWebRedirect` on reload.
   */
  const [contactsBusy, setContactsBusy] = useState(false);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const improveSuggestions = useCallback(async (notify = false): Promise<void> => {
    const bridge = sessionRef.current;
    if (!bridge) return;
    setContactsError(null);
    setContactsBusy(true);
    // From the sender menu there is no inline place for the outcome, so it is a notice.
    const fail = (message: string) => {
      setContactsError(message);
      if (notify) store.setNotice(message);
    };
    try {
      const access = await bridge.grantContacts();
      if (access === "granted") {
        const problem = await syncGoogleContacts(true);
        if (problem && notify) store.setNotice(problem.message);
      } else {
        store.setGoogleContacts([], access);
        fail(HALF_GRANT_MESSAGE);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Google contacts were not connected.");
    } finally {
      setContactsBusy(false);
    }
  }, [store, syncGoogleContacts]);
  const onImproveSuggestions = useCallback(() => void improveSuggestions(), [improveSuggestions]);
  const onConnectContactPhotos = useCallback(() => void improveSuggestions(true), [improveSuggestions]);

  const [restoringSession, setRestoringSession] = useState(false);
  /** Set beside the drafts code below; `signOut` is declared before it. */
  const forgetDraftsRef = useRef<() => void>(() => undefined);
  const [signingIn, setSigningIn] = useState(false);
  /** Set from the URL on mount, and applied once a session exists. */
  const launchLink = useRef<Record<string, string> | null>(null);

  /**
   * Start a sign-in.
   *
   * The bridge owns the whole flow — PKCE, the loopback listener or the page redirect,
   * the token exchange — and this only asks. `store.connect` then turns the signed-in
   * account into a populated inbox, so the two steps are sequenced here rather than in a
   * layer that does not know about the UI.
   *
   * On the web build this promise does not resolve: `beginSignIn` navigates away and the
   * sign-in completes in `completeWebRedirect` on the way back. It resolves only if the
   * navigation was blocked, which surfaces as a cancellation.
   *
   * `signingIn` is cleared in a `finally` because the desktop flow *does* resolve — on
   * success, on a decline, and on a timeout — and a button left spinning needs a second
   * click to recover.
   */
  /**
   * The user's own Google OAuth client, as last read from its store.
   *
   * `undefined` until the bridge has read it, `null` when there is none. Winnow ships no
   * client, so "none" is the normal first-run state, and every route into sign-in opens
   * the setup sheet instead of failing.
   */
  const [oauthClient, setOauthClient] = useState<OAuthClientCredentials | null | undefined>(undefined);
  const [setupOpen, setSetupOpen] = useState(false);
  const [redirectUri, setRedirectUri] = useState("");
  /** Android only: package name and signing certificate, for setup's native sign-in step. */
  const [androidSigning, setAndroidSigning] = useState<AppSigningInfo | null>(null);

  const runSignIn = useCallback(async (): Promise<void> => {
    const bridge = sessionRef.current;
    if (!bridge) throw new Error("Sign-in is still starting up. Try again in a moment.");
    setSigningIn(true);
    try {
      const account = await bridge.signIn();
      await store.connect(bridge.backend(), { email: account.email });
      void syncGoogleContacts();
    } finally {
      setSigningIn(false);
    }
  }, [store, syncGoogleContacts]);

  /**
   * Start a sign-in, or the setup that has to come first.
   *
   * With no OAuth client stored, there is nothing to sign in *with*, so the setup sheet
   * opens instead and "Save and connect" there carries on into the sign-in.
   */
  const signIn = useCallback(async (): Promise<void> => {
    const bridge = sessionRef.current;
    const stored = bridge ? await bridge.credentials() : null;
    setOauthClient(stored);
    if (!stored) {
      setSetupOpen(true);
      return;
    }
    await runSignIn();
  }, [runSignIn]);

  /**
   * Sign out for real.
   *
   * Through the bridge, not straight to `store.signOut`: the store half clears the
   * screen, but the bridge half is what deletes the tokens (OS keychain on desktop and
   * Android, `localStorage` on the web), wipes the cached mail and asks Google to revoke
   * the grant. Calling only the store left a working refresh token behind — on a shared
   * machine, "signed out, but the next person can read your mail".
   *
   * The revoke is best effort and never waited on, so a slow or offline Google cannot
   * hold the sign-out up. The demo revokes nothing: it has no grant of its own.
   *
   * The store is still cleared if the bridge half fails: leaving a populated inbox on
   * screen after someone pressed "sign out" is worse than leaving a token behind.
   */
  const signOut = useCallback(async () => {
    // The composer and the drafts kept on this device are the account's words: they go
    // first, while the snapshot still says whose they are. See `forgetDeviceDrafts`.
    forgetDraftsRef.current();
    // Brand logos are cached per sender domain: a list of who mails this account.
    logoCache.clear();
    gravatarCache.clear();
    const bridge = sessionRef.current;
    try {
      if (bridge) {
        await bridge.signOut({ revoke: store.getSnapshot().contactsAccess !== "demo" });
        return;
      }
    } catch (error) {
      store.setError(
        error instanceof Error
          ? `Signed out, but the saved session could not be erased: ${error.message}`
          : "Signed out, but the saved session could not be erased.",
      );
    }
    await store.signOut();
  }, [store, logoCache, gravatarCache]);

  /**
   * Sign in from the demo mailbox.
   *
   * The same `signIn` the sign-in screen calls, plus two things specific to this route:
   * the failure renders *beside the button* rather than in the app-wide error strip, and
   * the old message is cleared on the way in.
   *
   * The demo is left in place until the account actually connects, so a decline at
   * Google's consent screen leaves the user looking at the mailbox they were looking at,
   * with an explanation, rather than an empty sign-in screen.
   */
  const [connectError, setConnectError] = useState<string | null>(null);

  const connectFromDemo = useCallback(async () => {
    setConnectError(null);
    try {
      await signIn();
      // A link the user arrived on is honoured here too: signing in from a shared
      // link should land on the message the link named, not on the inbox.
      applySharedLink(launchLink.current);
    } catch (error) {
      setConnectError(
        error instanceof Error ? error.message : "Sign-in did not complete.",
      );
    }
  }, [signIn, applySharedLink]);

  /**
   * Build the session bridge and adopt any existing session.
   *
   * Mounted unconditionally, in demo mode too, because the demo is what the user sees
   * until this resolves. With no session, nothing happens and the demo stays — the nav
   * drawer's "Connect Gmail" is the route into sign-in from there.
   *
   * **StrictMode runs this effect twice**, and the second run would call
   * `completeWebRedirect` again — which *consumes* the PKCE verifier from
   * `sessionStorage` on read — so it finds nothing, throws "sign-in could not be
   * verified", and paints an error on a sign-in that had just succeeded. Both runs could
   * also race `exchangeCode` on the same single-use code.
   *
   * Hence the module-level flag: StrictMode tears down and rebuilds the component but not
   * the module, which is exactly the lifetime this needs.
   */
  useEffect(() => {
    if (sessionRestoreStarted) return;
    sessionRestoreStarted = true;

    // Read the app's own parameters now, while they are in the URL. On a shared
    // link that arrives while signed out, the trip to Google and back would
    // otherwise cost the user the link they were sent.
    launchLink.current = readOwnParams(globalThis.location?.search ?? "");

    void (async () => {
      try {
        const bridge = createSessionBridge(platform, store);
        sessionRef.current = bridge;
        setRestoringSession(true);
        // Read once up front so Settings can say whether a client is set up, and the
        // setup sheet can show the redirect URI a web user has to register.
        setOauthClient(await bridge.credentials());
        setRedirectUri(await bridge.redirectUriToRegister().catch(() => ""));
        void platform.appSigningInfo?.().then(setAndroidSigning, () => undefined);

        // First, in case this page load *is* the redirect back from Google: the code is in
        // the URL and the verifier in `sessionStorage`, and both are consumed on the spot.
        // It has to happen before `hasSession`, which would otherwise report "signed out"
        // and bounce the user back to the sign-in screen moments after signing in.
        const completed = await bridge.completeWebRedirect();
        if (completed) {
          await store.connect(bridge.backend(), { email: completed.email });
          applySharedLink(completed.view);
          // Back from the contacts opt-in rather than a sign-in: say how it went.
          if (completed.contacts === "declined") {
            store.setNotice(completed.contactsMessage ?? "Google contacts were not connected.");
          } else if (completed.contacts === "not_granted") {
            store.setNotice(HALF_GRANT_MESSAGE);
          }
          // Back from the drafts opt-in: the draft itself comes back through the restore
          // offer, from the copy kept on this device.
          if (completed.drafts === "declined") {
            store.setNotice(completed.draftsMessage ?? "Drafts were not allowed.");
          }
          void syncGoogleContacts(completed.contacts === "granted").then((problem) => {
            // Just granted, and it still cannot read them: say so now, not only in Settings.
            if (problem && completed.contacts === "granted") store.setNotice(problem.message);
          });
          return;
        }

        if (await bridge.hasSession()) {
          await store.connect(bridge.backend(), { email: await bridge.accountEmail() });
          void syncGoogleContacts();
        }

        /**
         * Honoured on *both* paths, and the demo path is the one that matters: a shared
         * link read on boot is meant for the person who is *not* signed in
         * (`readOwnParams` whitelists `view`/`message` so the OAuth parser leaves them
         * alone).
         *
         * Outside the `if` on purpose: after `connect` the mailbox must be set
         * *afterwards*, because `connect` resets the view.
         */
        applySharedLink(launchLink.current);
      } catch (error) {
        // A bridge that cannot be built is not a reason to hide the demo inbox — the
        // classification is the product, and it works with no account.
        store.setError(error instanceof Error ? error.message : null);
      } finally {
        setRestoringSession(false);
      }
    })();
  }, [store, applySharedLink, syncGoogleContacts]);

  // ── Derived view ─────────────────────────────────────────────────────────

  /**
   * The rail's data, from the store's own inbox-wide counts.
   *
   * A count on a pill is a claim about your mail, not about the current result set, and
   * the rail is ranked against the inbox precisely so it stays put when you change
   * mailbox — so both denominators are computed in the store, the only place that knows
   * which set the rail was ranked against.
   */
  const pills = useMemo(
    () =>
      buildPills(
        view.rail,
        view.inboxCounts,
        view.profile.topSenders,
        view.inboxSenderCounts,
        snapshot.activeFilters,
      ),
    [view.rail, view.inboxCounts, view.profile.topSenders, view.inboxSenderCounts, snapshot.activeFilters],
  );

  const unreadIds = useMemo(
    () => new Set(view.emails.filter((email) => email.unread).map((email) => email.id)),
    [view.emails],
  );

  // `MAILBOX_ORDER` rather than a second list of the same names: the drawer's rows were
  // written out here, so a mailbox added to the model and to the `!` palette was
  // invisible in the drawer — which is how "Sent" could have shipped with no way to open
  // it on a phone, where the drawer *is* the navigation.
  const mailboxes = useMemo(
    () =>
      MAILBOX_ORDER.map((id) => ({
        id,
        label: MAILBOX_LABEL[id],
        unread: snapshot.all.filter((email) => email.mailbox === id && email.unread).length,
      })),
    [snapshot.all],
  );

  /**
   * Whether the sidebar is open.
   *
   * The sidebar is an overlay on every screen (`Sidebar` in `MailNav.tsx`), opened from
   * the masthead's toggle on the desktop and a second tap on the dock's Inbox tab on a
   * phone, where it rises from the dock as a bottom sheet.
   * Local state rather than a store `overlay`, because the sidebar handles its own
   * Escape and must not inherit the keyboard router's: two Escape handlers on one
   * keypress is how a sheet closes the reader *and* itself.
   */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);

  /**
   * The sidebar's destinations. The Inbox
   * count is the unfiltered inbox list's own number of conversations. The smart filters
   * are not here; they are the rail (`FilterStrip`).
   */
  const navProps: NavProps = {
    inboxCount: view.inboxThreadCount,
    inboxUnread: mailboxes.find((mailbox) => mailbox.id === "inbox")?.unread ?? 0,
    mailbox: snapshot.mailbox,
    folders: mailboxes.filter((mailbox) => mailbox.id !== "inbox"),
    filtering: snapshot.activeFilters.length > 0,
    onInbox: () => {
      // On a phone, the panel's Inbox row on the plain inbox is the dock tab's "home"
      // gesture: nothing to switch to, so the list goes back to its top instead.
      const already = snapshot.mailbox === "inbox" && snapshot.activeFilters.length === 0 && snapshot.overlay === "none";
      store.setOverlay("none");
      store.setMailbox("inbox");
      store.clearFilters();
      if (already && phoneRef.current) scrollListToTop();
    },
    onSelectMailbox: (mailbox) => {
      store.setOverlay("none");
      store.setMailbox(mailbox);
    },
    accountEmail: snapshot.account?.email ?? null,
    signingIn,
    onConnect: () => {
      void connectFromDemo();
    },
    onSignOut: () => {
      void signOut();
    },
    syncing: sync.busy,
    syncLabel: sync.button,
    onRefresh: () => {
      void store.refresh();
    },
    settingsOpen: snapshot.overlay === "settings",
    onOpenSettings: () => store.setOverlay("settings"),
  };

  const paletteUnread = useMemo(
    () =>
      Object.fromEntries(
        mailboxes.map((mailbox) => [mailbox.id, mailbox.unread]),
      ) as Partial<Record<Mailbox, number>>,
    [mailboxes],
  );

  // ── Actions ──────────────────────────────────────────────────────────────

  const selected = view.selected;

  /**
   * Announce the open message.
   *
   * A keyboard-first client moves the reader with `j` and `k`, and none of that reaches
   * assistive technology: focus stays where the last click left it, the reader is a
   * sibling of the list rather than a focused region, and a screen reader user pressing
   * `j` through a mailbox hears nothing change.
   *
   * An `aria-live` region is the fix. It says who the message is *from* and what it is
   * *about* — the two facts that let a non-sighted user decide whether to keep reading —
   * not the position and not the whole body, which would make `j` unusable as a scan.
   * `polite`, so it queues behind whatever is being read, and the badges are included
   * because Important or Unsafe is a material fact the list renders only as a dot.
   */
  const announcement = selected
    ? [
        `${displayName(selected)}`,
        selected.subject || "(no subject)",
        selected.unread ? "unread" : null,
        view.signals.get(selected.id)
          ? badgeFilters(selected, view.signals.get(selected.id)!)
              .map((id) => FILTER_LABELS[id])
              .join(", ")
          : null,
      ]
        .filter(Boolean)
        .join(" — ")
    : "";

  /**
   * Wrap a store mutation that needs the *current* snapshot.
   *
   * The handler closes over nothing and reads through `snapshotRef` when it runs, which
   * keeps its identity stable — and every one of these is passed to a `memo`'d component,
   * where a new function per render would defeat the memo.
   */
  const act = useCallback(
    (fn: (store: WinnowStore, snapshot: Snapshot) => void) => () =>
      fn(storeRef.current, snapshotRef.current),
    [],
  );

  /**
   * Open a message by click.
   *
   * A click both moves the cursor and opens; `j` only moves — the difference that makes
   * keyboard navigation and clicking feel like different actions even though they select
   * the same message.
   */
  /**
   * Leave the open message.
   *
   * On a phone this is Back: the list returns with no current row (the cursor goes with
   * the reader — see `listSelectedId`) and at the scroll position it was left at, which
   * `MessageList` keeps across the reader covering it. Focus goes back to the row that
   * was opened, so a screen reader resumes where it was rather than at the top of the
   * document; `preventScroll` because the list is already where the user left it, and a
   * focus after a tap draws no `focus-visible` ring, so nothing on screen marks the row.
   */
  const closeReader = useCallback(() => {
    const s = storeRef.current;
    if (!phoneRef.current) {
      s.closeReader();
      return;
    }
    const openedId = snapshotRef.current.view.selected?.id;
    s.closeReader({ dropCursor: true });
    if (openedId === undefined) return;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-row-count] button[data-message-id="${openedId}"]`)
        ?.focus({ preventScroll: true });
    });
  }, []);

  /**
   * Read/unread for a message, with the exit that marking unread implies.
   *
   * Marking the *open* message unread moves on — the next row on the desktop, the list on
   * a phone (see `store.markUnreadAndMoveOn`); on a phone focus goes back to the row, as
   * Back does. Marking read, or toggling a message that is not open, is a plain toggle.
   */
  const toggleReadFor = useCallback((id: number) => {
    const s = storeRef.current;
    const email = s.getSnapshot().all.find((candidate) => candidate.id === id);
    if (!email) return;
    if (email.unread) {
      s.setRead(id, true);
      return;
    }
    const phoneNow = phoneRef.current;
    const wasOpen = snapshotRef.current.view.selected?.id === id;
    s.markUnreadAndMoveOn(id, { phone: phoneNow });
    if (phoneNow && wasOpen) {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-row-count] button[data-message-id="${id}"]`)
          ?.focus({ preventScroll: true });
      });
    }
  }, []);
  const toggleReadRef = useRef(toggleReadFor);
  toggleReadRef.current = toggleReadFor;

  // ── Multi-select and the two menus ─────────────────────────────────────────

  /** Rows in list order, for ranges and for running a batch top to bottom. */
  const rowOrder = useMemo(() => view.threads.map((row) => row.representative.id), [view.threads]);

  // A row that leaves the list (filed, filtered out, synced away) leaves the selection.
  useEffect(() => {
    setSelection((current) => pruneSelection(current, rowOrder));
  }, [rowOrder]);

  // A selection belongs to one mailbox.
  useEffect(() => {
    setSelection(EMPTY_SELECTION);
    setMenu(null);
  }, [snapshot.mailbox]);

  /** Contact photos by lowercased address, from the user's Google contacts, avatar-sized. */
  const photos = useMemo(() => contactPhotoMap(snapshot.googleContacts), [snapshot.googleContacts]);

  // Signed out by any route (the button, an expired session): who mailed that account
  // is the account's data. Turning the setting off forgets the lookups too.
  useEffect(() => {
    if (snapshot.status === "signed_out" || !preferences.brandLogos) logoCache.clear();
  }, [snapshot.status, preferences.brandLogos, logoCache]);
  useEffect(() => {
    if (snapshot.status === "signed_out" || !preferences.gravatars) gravatarCache.clear();
  }, [snapshot.status, preferences.gravatars, gravatarCache]);

  // Back online: logos that could not be looked up while offline are asked for again.
  useEffect(() => {
    const retry = () => {
      logoCache.retryFailed();
      gravatarCache.retryFailed();
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [logoCache, gravatarCache]);

  // The demo answers brand logos from bundled images and never touches the network.
  // Gravatar is the real lookup even there, once switched on: the demo's addresses are
  // fictional, so their hashes say nothing about anyone, and the switch is the thing to
  // try out.
  const isDemo = snapshot.contactsAccess === "demo";
  const brandLogos = preferences.brandLogos;
  const gravatars = preferences.gravatars;
  const senderPictures = useMemo<SenderPictures>(
    () => ({
      photos,
      gravatars: gravatars ? gravatarCache : null,
      logos: brandLogos ? (isDemo ? DEMO_LOGO_SOURCE : logoCache) : null,
    }),
    [photos, gravatars, gravatarCache, brandLogos, isDemo, logoCache],
  );

  const runBatch = useCallback((fn: (s: WinnowStore, ids: number[]) => void, keep = false) => {
    const ids = orderedSelection(
      selectionRef.current,
      snapshotRef.current.view.threads.map((row) => row.representative.id),
    );
    if (ids.length === 0) return;
    fn(storeRef.current, ids);
    if (!keep) setSelection(EMPTY_SELECTION);
  }, []);

  /**
   * One-time codes: copy from a row chip, the reader's bar, or `c`.
   *
   * `copiedCodeId` is the message just copied, so whichever surface shows its code says
   * "Copied" for a moment, keyboard copies included; the sr-only line says it aloud.
   */
  const [copiedCodeId, setCopiedCodeId] = useState<number | null>(null);
  const [codeAnnouncement, setCodeAnnouncement] = useState("");
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  const copyCode = useCallback(
    (id: number) => {
      const code = store.getSnapshot().all.find((email) => email.id === id)?.code;
      if (!code) return;
      void copyText(code).then((ok) => {
        if (!ok) {
          store.setError("Couldn't reach the clipboard. Select the code in the message to copy it.");
          return;
        }
        setCopiedCodeId(id);
        setCodeAnnouncement(`Copied code ${code}`);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => {
          setCopiedCodeId(null);
          setCodeAnnouncement("");
        }, 1_600);
      });
    },
    [store],
  );
  const copyCodeRef = useRef(copyCode);
  copyCodeRef.current = copyCode;

  const openSenderMenu = useCallback((id: number, trigger: HTMLElement) => {
    setMenu({ kind: "sender", id, ids: [id], anchor: anchorFromElement(trigger), trigger });
  }, []);

  const openRowMenu = useCallback((id: number, anchor: MenuAnchor, trigger: HTMLElement) => {
    const batch = selectionRef.current;
    const ids =
      batch.has(id) && batch.size > 1
        ? orderedSelection(batch, snapshotRef.current.view.threads.map((row) => row.representative.id))
        : [id];
    setMenu({ kind: "row", id, ids, anchor, trigger });
  }, []);

  const handleSelectRow = useCallback((messageId: number) => {
    const s = storeRef.current;
    const index = snapshotRef.current.view.threads.findIndex(
      (row) => row.representative.id === messageId,
    );
    if (index < 0) return;
    s.openRow(index);
  }, []);

  /**
   * A row swiped past its commit line (phone only; see `ui/swipe.ts`). Trash and Restore
   * offer Undo on the strip; a draft is discarded with Undo; read and unread are a plain
   * toggle, which the row shows as it snaps back.
   */
  const handleSwipe = useCallback((id: number, action: SwipeAction) => {
    const s = storeRef.current;
    switch (action) {
      case "trash":
        s.moveWithUndo(id, "trash");
        break;
      case "restore":
        s.moveWithUndo(id, "inbox");
        break;
      case "discard":
        s.discardDraftWithUndo(id);
        break;
      case "markRead":
        s.setRead(id, true);
        break;
      case "markUnread":
        s.setRead(id, false);
        break;
    }
  }, []);
  const swipeConfig = useMemo(
    () => ({ mailbox: snapshot.mailbox, onAction: handleSwipe }),
    [snapshot.mailbox, handleSwipe],
  );

  const handleToggleStar = useCallback((messageId: number) => {
    storeRef.current.toggleStar(messageId);
  }, []);

  /** The autosave for the open composer. One at a time, like the composer itself. */
  const saverRef = useRef<DraftAutosaver | null>(null);
  /**
   * Whether the grant allows Gmail drafts, read from the token when an account connects.
   * `null` until known; the sign-in scope allows drafts, so it is `granted` for a normal
   * session and this exists for a grant narrowed outside Winnow.
   */
  const [draftsAccess, setDraftsAccess] = useState<DraftsAccess | null>(null);
  const draftsAccessRef = useRef(draftsAccess);
  draftsAccessRef.current = draftsAccess;

  /** The device copy for whoever is signed in (or the demo). */
  const localDrafts = useCallback((): LocalDrafts | null => {
    const account = draftAccount(storeRef.current.getSnapshot());
    return account ? new LocalDrafts(deviceStorage(), account) : null;
  }, []);

  /**
   * Put the open composer away: `park` keeps what was written (Gmail draft and device
   * copy, with a "Draft saved." notice), `discard` deletes both. An untouched composer is
   * always discarded — there is nothing to keep.
   */
  const retireComposer = useCallback((current: ComposerState, how: "park" | "discard") => {
    const saver = saverRef.current;
    saverRef.current = null;
    if (!saver) return;
    const s = storeRef.current;
    const reopened = current.fromDrafts;
    if (reopened) {
      // A draft from Drafts is the user's already: putting it away keeps it, edited or
      // not, and only Discard deletes it.
      if (how === "discard") {
        s.removeDraftRow(reopened.draftId);
        void saver.discard().then(() => s.refreshDrafts());
        return;
      }
      if (current.draft === reopened.baseline) {
        void saver.park();
        return;
      }
      s.putDraftRow(draftRowFrom(reopened.row, current.draft, Date.now()));
      void saver.park().then(() => {
        // Its row in Drafts is the way back to it, so the device copy is not offered for
        // restoring on the next launch — unless Gmail did not take the save, when the
        // device copy is the only up-to-date one.
        const status = saver.currentStatus;
        const savedElsewhere = status.kind === "saved" && status.where === "gmail";
        if (savedElsewhere || s.draftsApi() === null) localDrafts()?.remove(current.context);
        void s.refreshDrafts();
      });
    } else if (how === "discard" || isUntouchedDraft(current.draft, current.initial)) {
      const hadDraft = saver.draftId !== null;
      void saver.discard().then(() => {
        if (hadDraft && s.getSnapshot().mailbox === "drafts") void s.refreshDrafts();
      });
      return;
    } else {
      void saver.park().then(() => {
        if (s.getSnapshot().mailbox === "drafts") void s.refreshDrafts();
      });
    }
    const message = "Draft saved.";
    s.setNotice(message);
    setTimeout(() => {
      if (s.getSnapshot().notice === message) s.dismissNotice();
    }, DRAFT_NOTICE_MS);
  }, [localDrafts]);

  /**
   * Open the composer, with its autosave.
   *
   * One composer at a time: one already open is parked first (kept as a draft), so
   * replying to another message never silently loses a half-written reply. A context
   * with a draft kept on this device opens with it, unless `restore` is `false` (a
   * `mailto:` link, which is its own message).
   */
  const startComposer = useCallback(
    (start: ComposerStart, restore?: LocalDraft | false) => {
      const previous = composerRef.current;
      if (previous) retireComposer(previous, "park");
      const local = localDrafts();
      const kept = restore === false ? null : (restore ?? local?.get(start.context) ?? null);
      const api = storeRef.current.draftsApi();
      const saver: DraftAutosaver = new DraftAutosaver({
        context: start.context,
        mode: start.mode,
        replyTo: start.replyTo,
        api,
        local,
        draftId: kept?.gmailDraftId ?? null,
        permissionMissing: api !== null && draftsAccessRef.current === "not_granted",
        onStatus: (status) => {
          // A parked saver finishing its last save must not speak for the next composer.
          if (saverRef.current !== saver) return;
          setComposer((current) => (current ? { ...current, status } : current));
        },
      });
      saverRef.current = saver;
      const next: ComposerState = {
        ...start,
        ...(kept
          ? { draft: kept.draft, replyAll: kept.replyAll ?? start.replyAll, initial: kept.initial ?? start.initial }
          : {}),
        sending: false,
        error: null,
        status: saver.currentStatus,
      };
      composerRef.current = next;
      setComposer(next);
      void syncGoogleContacts();
    },
    [localDrafts, retireComposer, syncGoogleContacts],
  );

  /** Put the caret back in the open composer's message, for a second `r` on the same draft. */
  const focusComposer = useCallback(() => {
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
  }, []);

  /**
   * Open the composer on a reply.
   *
   * Reply-all by default: the person who needs to answer is usually not the one who wrote
   * last, and reply-all with a visible, editable To field is undoable in a way
   * reply-to-one is not. `buildReply`'s tests pin the exclusion of the user's own address.
   * The composer's Reply / Reply all toggle switches it.
   */
  const openReply = useCallback(() => {
    const snap = snapshotRef.current;
    const selected = snap.view.selected;
    if (!selected) return;
    const context = draftContextKey("reply", selected.gmailId);
    if (composerRef.current?.context === context) return focusComposer();
    const draft = buildReply(selected, snap.view.conversation, {
      replyAll: true,
      selfAddress: selfAddressOf(snap),
    });
    startComposer({ draft, mode: "reply", replyTo: selected.gmailId, replyAll: true, context });
  }, [startComposer, focusComposer]);

  /**
   * Open the composer on a forward.
   *
   * No recipient: pre-filling one from the thread would send the whole conversation to
   * whoever was picked. The quoted body opens ready to read and edit, and `Composer`
   * keeps Send disabled until an address exists — the only reason it is safe to leave the
   * field empty.
   */
  const openForward = useCallback(() => {
    const snap = snapshotRef.current;
    const selected = snap.view.selected;
    if (!selected) return;
    const context = draftContextKey("forward", selected.gmailId);
    if (composerRef.current?.context === context) return focusComposer();
    const draft = buildForward(selected, snap.view.conversation, []);
    startComposer({ draft, mode: "forward", replyTo: selected.gmailId, context });
  }, [startComposer, focusComposer]);

  /**
   * Reply, reply all or forward a row from its context menu: open it, then compose.
   *
   * Read through the store rather than `snapshotRef`, because the row was opened a line
   * earlier and the snapshot has not re-rendered yet.
   */
  const composeFor = useCallback(
    (id: number, mode: "reply" | "replyAll" | "forward") => {
      const s = storeRef.current;
      s.focusMessage(id);
      const view = s.view;
      if (!view.selected) return;
      const kind = mode === "forward" ? "forward" : "reply";
      const context = draftContextKey(kind, view.selected.gmailId);
      if (composerRef.current?.context === context) return focusComposer();
      const replyAll = mode === "replyAll";
      const draft =
        mode === "forward"
          ? buildForward(view.selected, view.conversation, [])
          : buildReply(view.selected, view.conversation, {
              replyAll,
              selfAddress: selfAddressOf(s.getSnapshot()),
            });
      startComposer({
        draft,
        mode: kind,
        replyTo: view.selected.gmailId,
        replyAll: kind === "reply" ? replyAll : undefined,
        context,
      });
    },
    [startComposer, focusComposer],
  );

  /**
   * Open a blank composer, or one filled from a `mailto:` link.
   *
   * A blank one picks up the new message kept on this device, if there is one. With a
   * sheet already open this does nothing — the open draft keeps its own discard
   * question, and every entry point is behind its backdrop anyway. A docked reply is not
   * a sheet: it is parked (kept as a draft) and the new message opens.
   */
  const openCompose = useCallback(
    (from?: Draft) => {
      const current = composerRef.current;
      if (current && (current.mode === "new" || current.fromDrafts || phoneRef.current)) return;
      const draft = from ?? buildNewDraft();
      startComposer(
        {
          draft,
          mode: "new",
          context: draftContextKey("new"),
          initial: { to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject },
        },
        from ? false : undefined,
      );
    },
    [startComposer],
  );

  /** A `mailto:` link in a message: Winnow's own composer, filled from the link. */
  const openMailto = useCallback(
    (url: string) => {
      const draft = draftFromMailto(url);
      if (draft) openCompose(draft);
      else void platform.openExternal(url);
    },
    [openCompose],
  );

  /**
   * Reopen a Drafts row in the composer: a sheet on the desktop, full screen on a phone,
   * autosaving to the same Gmail draft. A reply reopens on the message it answers, so
   * it sends on its thread (see `reopenDraft`). The copy kept on this device wins only
   * when it is the same draft and newer than Gmail's — an edit made elsewhere since is
   * not overwritten by an old local one.
   */
  const openDraftRow = useCallback(
    (id: number) => {
      const s = storeRef.current;
      const snap = s.getSnapshot();
      const row = snap.drafts.find((email) => email.id === id);
      const reopened = row ? reopenDraft(row, snap.all) : null;
      if (!row || !reopened) return;
      if (composerRef.current?.context === reopened.context) return focusComposer();
      const local = localDrafts()?.get(reopened.context) ?? null;
      const kept: LocalDraft =
        local && local.gmailDraftId === reopened.gmailDraftId && local.savedAt >= row.receivedAt
          ? local
          : {
              context: reopened.context,
              mode: reopened.mode,
              draft: reopened.draft,
              ...(reopened.replyTo ? { replyTo: reopened.replyTo } : {}),
              gmailDraftId: reopened.gmailDraftId,
              savedAt: row.receivedAt,
            };
      const draft = kept.draft;
      startComposer(
        {
          draft,
          mode: reopened.mode,
          replyTo: reopened.replyTo,
          context: reopened.context,
          ...(reopened.mode === "new"
            ? { initial: { to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject } }
            : {}),
          fromDrafts: { draftId: reopened.gmailDraftId, row, baseline: draft },
        },
        kept,
      );
    },
    [startComposer, focusComposer, localDrafts],
  );

  /**
   * "Label as…" is open for these messages. The labels are listed each time it opens,
   * cheaply, in case one was made in Gmail meanwhile.
   */
  const [labelPicker, setLabelPicker] = useState<number[] | null>(null);
  const openLabelPicker = useCallback((ids: readonly number[]) => {
    if (ids.length === 0) return;
    setLabelPicker([...ids]);
    void storeRef.current.loadLabels();
  }, []);
  const labelTargets = useMemo(() => {
    if (!labelPicker) return [];
    const wanted = new Set(labelPicker);
    return snapshot.all.filter((email) => wanted.has(email.id));
    // The picker reads the labels as it opened; a sync landing underneath must not
    // reset the boxes the user is ticking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelPicker]);

  /** "Send without a subject?" is up, holding the recipients Send was pressed with. */
  const [confirmNoSubject, setConfirmNoSubject] = useState<Pick<Draft, "to" | "cc" | "bcc"> | null>(null);

  /**
   * The message in its undo window (see `core/mail/undoSend`), and what the "Sending…"
   * strip shows: when it goes.
   */
  const delayedSendRef = useRef(new DelayedSend<PendingSend>());
  const [sendWait, setSendWait] = useState<{ deadline: number; seconds: number } | null>(null);

  /**
   * Hand a message to Gmail, sending its saved draft when there is one (so no orphan is
   * left in Drafts), then tidy up after it: the device copy goes, the autosave stops, a
   * row in Drafts goes, and a new message says it went. Throws when the send fails; the
   * caller decides where the error is shown.
   */
  const deliver = useCallback(async ({ composer: sending, saver, inReplyTo }: PendingSend) => {
    const draftId = (saver ? await saver.settle().catch(() => null) : null) ?? undefined;
    const s = storeRef.current;
    let simulated = false;
    if (sending.mode === "new") ({ simulated } = await s.sendNew(sending.draft, draftId));
    else if (inReplyTo) await s.sendReply(sending.draft, inReplyTo, draftId);
    else throw new Error("Couldn't find the message this replies to.");
    saver?.finish();
    if (saverRef.current === saver) saverRef.current = null;
    // Gmail removed the draft as it sent it; so does the list, now.
    if (sending.fromDrafts) s.removeDraftRow(sending.fromDrafts.draftId);
    if (s.getSnapshot().mailbox === "drafts") void s.refreshDrafts();
    if (sending.mode !== "new") return;
    // Said, because a closing sheet alone does not say whether it went. The demo says
    // what it did: nothing left the device.
    const message = simulated ? "Message sent (demo: saved to Sent on this device only)." : "Message sent.";
    s.setNotice(message);
    setTimeout(() => {
      if (s.getSnapshot().notice === message) s.dismissNotice();
    }, SENT_NOTICE_MS);
  }, []);

  /**
   * The undo window ended: send. A failure puts the composer back with the error, as an
   * immediate send would — unless another composer has opened since, when the failed
   * one is kept as a draft (Gmail and device) and a notice says so, rather than
   * replacing what the user is writing now.
   */
  const deliverPending = useCallback(
    async (pending: PendingSend) => {
      setSendWait(null);
      try {
        await deliver(pending);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Couldn't send that message.";
        if (composerRef.current) {
          void pending.saver?.park();
          storeRef.current.setNotice(`${message} It was kept as a draft.`);
          return;
        }
        saverRef.current = pending.saver;
        const back: ComposerState = {
          ...pending.composer,
          sending: false,
          error: message,
          status: pending.saver?.currentStatus ?? pending.composer.status,
        };
        composerRef.current = back;
        setComposer(back);
      }
    },
    [deliver],
  );

  /**
   * Undo: the waiting message comes back to the composer exactly as it was, with its
   * autosave (and so its Gmail draft) still attached. A composer opened in the meantime
   * is parked first, the way opening any other draft parks it.
   */
  const undoSend = useCallback(() => {
    const pending = delayedSendRef.current.undo();
    setSendWait(null);
    if (!pending) return;
    const current = composerRef.current;
    if (current) retireComposer(current, "park");
    saverRef.current = pending.saver;
    const back: ComposerState = {
      ...pending.composer,
      sending: false,
      error: null,
      status: pending.saver?.currentStatus ?? pending.composer.status,
    };
    composerRef.current = back;
    setComposer(back);
  }, [retireComposer]);

  /** "Send now" on the strip: skip the rest of the wait. */
  const sendWaitingNow = useCallback(() => {
    delayedSendRef.current.sendNow();
  }, []);

  /**
   * Leaving with a message in its undo window keeps it as a draft and never sends it
   * (the reasons are on `core/mail/undoSend`). The device copy was written when Send was
   * pressed; this asks Gmail for its copy too, best effort, since a closing page cannot
   * wait. `pagehide` rather than `beforeunload`: it also fires for a tab put into the
   * back/forward cache, and it never prompts. A page that comes back from that cache
   * gets the composer back, as if Undo had been pressed. Going to the background
   * (`visibilitychange`, which is all Android may say before killing the webview) only
   * pushes the save to Gmail and leaves the wait running.
   */
  const keptOnHideRef = useRef<PendingSend | null>(null);
  useEffect(() => {
    const onHide = () => {
      const pending = delayedSendRef.current.undo();
      if (!pending) return;
      setSendWait(null);
      keptOnHideRef.current = pending;
      void pending.saver?.flush();
    };
    const onShow = (event: PageTransitionEvent) => {
      const kept = keptOnHideRef.current;
      keptOnHideRef.current = null;
      if (!kept || !event.persisted || composerRef.current) return;
      saverRef.current = kept.saver;
      const back: ComposerState = { ...kept.composer, sending: false, error: null };
      composerRef.current = back;
      setComposer(back);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void delayedSendRef.current.pending?.saver?.flush();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /**
   * Send what the composer holds.
   *
   * `recipients` is what the composer counted, including an address typed and not yet a
   * chip — the state update that adds it may not have landed when ⌘⏎ fires.
   *
   * A reply goes out on its thread. A new message goes out on its own, and is asked
   * about first when it has no subject — Gmail's "send without a subject?", because a
   * blank subject is almost always a slip and the recipient's list shows nothing.
   *
   * With Undo send on, the composer closes at once and the message waits out its window
   * under a "Sending… Undo" strip. Its draft is saved first — on this device at once,
   * and to Gmail — so a close in the wait loses nothing. With it Off, the composer stays
   * up saying "Sending" and shows a failure in place, as before.
   */
  const sendDraft = useCallback(
    async (recipients?: Pick<Draft, "to" | "cc" | "bcc">, confirmedNoSubject = false) => {
      if (!composer || composer.sending) return;
      const draft = { ...composer.draft, ...(recipients ?? {}) };
      if (composer.mode === "new" && !confirmedNoSubject && needsSubjectConfirmation(draft)) {
        setConfirmNoSubject({ to: draft.to, cc: draft.cc, bcc: draft.bcc });
        return;
      }
      const inReplyTo =
        composer.mode === "new" ? undefined : (composer.replyTo ?? snapshotRef.current.view.selected?.gmailId);
      if (composer.mode !== "new" && !inReplyTo) return;
      const saver = saverRef.current;
      const pending: PendingSend = { composer: { ...composer, draft }, saver, inReplyTo };

      const seconds = storeRef.current.getSnapshot().preferences.undoSendSeconds;
      if (seconds > 0) {
        saver?.change(draft, { replyAll: composer.replyAll, initial: composer.initial });
        void saver?.flush();
        // Detached from the screen, not stopped: the saver goes with the message.
        saverRef.current = null;
        composerRef.current = null;
        setComposer(null);
        delayedSendRef.current.schedule(pending, seconds * 1000, (value) => void deliverPending(value));
        setSendWait({ deadline: Date.now() + seconds * 1000, seconds });
        return;
      }

      setComposer({ ...composer, draft, sending: true, error: null });
      try {
        await deliver(pending);
        if (composerRef.current?.context === composer.context) {
          composerRef.current = null;
          setComposer(null);
        }
      } catch (error) {
        setComposer({
          ...composer,
          draft,
          sending: false,
          error:
            error instanceof Error
              ? error.message
              : composer.mode === "new"
                ? "Couldn't send that message."
                : "Couldn't send that reply.",
        });
      }
    },
    [composer, deliver, deliverPending],
  );

  /**
   * Close the composer, or ask before throwing the draft away.
   *
   * An untouched draft closes straight away; a written one opens a real confirmation
   * rather than `window.confirm`. Three reasons for the in-app dialog: a Tauri webview
   * does not reliably implement `confirm`, so on the desktop the question could not be
   * asked at all; the native dialog cannot be styled; and it blocks the render loop, which
   * in a mail client is a frozen window.
   *
   * `Discard` skips the question, because it is the button that already says the word.
   */
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const closeComposer = useCallback((force = false) => {
    const current = composerRef.current;
    if (!current) return;
    // A draft reopened from Drafts closes the way Gmail's does: kept, without a question.
    if (current.fromDrafts && !force) {
      retireComposer(current, "park");
      composerRef.current = null;
      setComposer(null);
      return;
    }
    if (force || isUntouchedDraft(current.draft, current.initial)) {
      // Discarding deletes the saved draft too: Gmail's and this device's.
      retireComposer(current, "discard");
      setComposer(null);
      return;
    }
    // There is something to lose: ask, and leave the composer exactly as it is
    // — including focus — if the answer is no.
    setConfirmDiscard(true);
  }, [retireComposer]);

  /** Both buttons of the confirmation, in one place so neither can miss. */
  const resolveDiscard = useCallback((discard: boolean) => {
    setConfirmDiscard(false);
    const current = composerRef.current;
    if (discard && current) {
      retireComposer(current, "discard");
      setComposer(null);
    }
  }, [retireComposer]);

  /**
   * The autosave follows the draft. An untouched composer is not saved — opening a reply
   * and closing it again must not leave a draft in Gmail — and nothing is saved while a
   * send is in flight, which would race `drafts.send` with an update.
   */
  const composerDraft = composer?.draft;
  const composerReplyAll = composer?.replyAll;
  useEffect(() => {
    const current = composerRef.current;
    const saver = saverRef.current;
    if (!current || !saver || current.sending) return;
    if (current.fromDrafts && current.draft === current.fromDrafts.baseline) return;
    if (isUntouchedDraft(current.draft, current.initial) && !saver.hasSaved) return;
    saver.change(current.draft, { replyAll: current.replyAll, initial: current.initial });
  }, [composerDraft, composerReplyAll]);

  /** Drafts need permission → the opt-in, by incremental consent like contacts. */
  const [allowingDrafts, setAllowingDrafts] = useState(false);
  const allowDrafts = useCallback(async () => {
    const bridge = sessionRef.current;
    if (!bridge) return;
    setAllowingDrafts(true);
    try {
      const access = await bridge.grantDrafts();
      setDraftsAccess(access);
      const api = storeRef.current.draftsApi();
      if (access === "granted" && api) saverRef.current?.grant(api);
      else storeRef.current.setNotice("Drafts were not allowed. Your draft is kept on this device instead.");
    } catch (error) {
      storeRef.current.setNotice(error instanceof Error ? error.message : "Drafts were not allowed.");
    } finally {
      setAllowingDrafts(false);
    }
  }, []);

  /** The grant's drafts access, read off the token whenever the account changes. */
  const accountEmail = snapshot.account?.email ?? null;
  useEffect(() => {
    const bridge = sessionRef.current;
    if (!bridge || !accountEmail) {
      setDraftsAccess(null);
      return;
    }
    let live = true;
    bridge.draftsAccess().then(
      (access) => {
        if (live) setDraftsAccess(access);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [accountEmail]);

  /**
   * The docked reply belongs to the message it answers. Moving to another message (or
   * closing the reader) parks it — kept as a draft, in Gmail and on this device, with a
   * "Draft saved." notice — rather than asking on every j/k, or losing it. Opening the
   * reply again on that message picks it up.
   */
  const selectedGmailId = view.selected?.gmailId ?? null;
  useEffect(() => {
    const current = composerRef.current;
    if (!current || phone || current.mode === "new" || current.fromDrafts || current.sending) return;
    if (current.replyTo === selectedGmailId) return;
    retireComposer(current, "park");
    composerRef.current = null;
    setComposer(null);
  }, [selectedGmailId, phone, retireComposer]);

  /** Reply and forward dock in the reader on a wide layout; everything else is a sheet. */
  const docked =
    composer !== null &&
    !phone &&
    composer.mode !== "new" &&
    !composer.fromDrafts &&
    composer.replyTo !== undefined &&
    composer.replyTo === selectedGmailId;
  const dockedRef = useRef(docked);
  dockedRef.current = docked;

  /**
   * In Drafts, opening a row — a click, Enter, `o` — opens the composer, not the
   * reader: a draft is something to finish. Every way of opening a row selects it, so
   * the selection is where this is caught, once, and then dropped again.
   */
  const openedDraftId = snapshot.mailbox === "drafts" ? snapshot.selectedId : null;
  useEffect(() => {
    if (openedDraftId === null) return;
    storeRef.current.select(null);
    openDraftRow(openedDraftId);
  }, [openedDraftId, openDraftRow]);

  /**
   * On launch (and after signing in), offer the newest draft kept on this device — the
   * one a reload, a crash or the drafts opt-in's trip to Google left behind.
   */
  const [restoreOffer, setRestoreOffer] = useState<LocalDraft | null>(null);
  const restoreOfferedFor = useRef<string | null>(null);
  const draftOwner = draftAccount(snapshot);
  useEffect(() => {
    if (snapshot.status !== "ready" || !draftOwner || restoreOfferedFor.current === draftOwner) return;
    restoreOfferedFor.current = draftOwner;
    if (composerRef.current) return;
    const latest = localDrafts()?.latest() ?? null;
    if (latest) setRestoreOffer(latest);
  }, [snapshot.status, draftOwner, localDrafts]);

  /**
   * Signing out forgets this account's drafts on the device: the open composer stops
   * autosaving (its Gmail draft, if one was saved, stays in Gmail's Drafts), the restore
   * offer goes, and so does every copy kept for restoring. Only an explicit sign-out: a
   * session that merely expired keeps them, so a draft survives signing back in.
   */
  const forgetDeviceDrafts = useCallback(() => {
    // A message in its undo window is not sent on the way out: it stays in Gmail's
    // Drafts if it got there, like the open composer's draft.
    delayedSendRef.current.undo()?.saver?.finish();
    setSendWait(null);
    const saver = saverRef.current;
    saverRef.current = null;
    saver?.finish();
    composerRef.current = null;
    setComposer(null);
    setRestoreOffer(null);
    localDrafts()?.clear();
  }, [localDrafts]);
  forgetDraftsRef.current = forgetDeviceDrafts;

  /** Restore: a reply or forward reopens on its message; one whose message is gone becomes a new message. */
  const restoreDraft = useCallback(
    (entry: LocalDraft) => {
      setRestoreOffer(null);
      const s = storeRef.current;
      const email = entry.replyTo ? s.getSnapshot().all.find((e) => e.gmailId === entry.replyTo) : undefined;
      if (entry.mode !== "new" && email) {
        s.focusMessage(email.id);
        startComposer(
          {
            draft: entry.draft,
            mode: entry.mode,
            replyTo: s.view.selected?.gmailId ?? entry.replyTo,
            replyAll: entry.replyAll,
            context: entry.context,
          },
          entry,
        );
        return;
      }
      if (entry.mode !== "new") localDrafts()?.remove(entry.context);
      const draft = { ...entry.draft, inReplyTo: undefined, quoteBlock: undefined, prefilled: undefined };
      const initial = entry.initial ?? BLANK_INITIAL;
      startComposer(
        { draft, mode: "new", context: draftContextKey("new"), initial },
        { ...entry, context: draftContextKey("new"), mode: "new", draft, initial },
      );
    },
    [startComposer, localDrafts],
  );

  /** The toggle: recompute To from the message being answered, keep the rest. */
  const setReplyAll = useCallback((replyAll: boolean) => {
    const snap = snapshotRef.current;
    const selected = snap.view.selected;
    setComposer((current) => {
      if (!current || !selected || current.replyTo !== selected.gmailId) return current;
      return {
        ...current,
        replyAll,
        draft: withReplyAll(current.draft, selected, snap.view.conversation, replyAll, selfAddressOf(snap)),
      };
    });
  }, []);

  /**
   * The message whose remote content has been loaded for this session only.
   *
   * Scoped to one message id and cleared when the selection moves, so the reader's "Load
   * images" does what it says. Nobody clicking it under one message means "show me remote
   * content from everyone, forever"; the global preference in Settings remains that
   * decision, made once, in a place where the scope is visible.
   */
  const [remoteFor, setRemoteFor] = useState<number | null>(null);

  // Cleared on navigation, so the hatch does not quietly follow you to the next
  // message. `selected?.id` rather than the whole snapshot so the effect only runs
  // when the message actually changes.
  useEffect(() => {
    setRemoteFor(null);
  }, [selected?.id]);

  // Cleared when the standing answer changes too. `resolveImageConsent` already makes
  // "never" absolute, so this is not the stale-grant fix; it stops a grant outliving the
  // answer that replaced it, so going from "never" back to "ask each time" actually asks.
  useEffect(() => {
    setRemoteFor(null);
  }, [preferences.imagePolicy]);

  /**
   * Whether the open message shows its images, and whether to offer the choice.
   *
   * Resolved here rather than in the reader so the reader is handed two booleans instead
   * of a three-way policy plus an override, and so "should the offer appear" is answered
   * in one place. The rule itself lives in `core/mail/imageConsent`, because it decides
   * whether a sender finds out a message was opened.
   */
  const { imagesAllowed, askAboutImages } = resolveImageConsent({
    policy: preferences.imagePolicy,
    grantedFor: remoteFor,
    selectedId: selected?.id ?? null,
  });

  /**
   * Download one attachment.
   *
   * Order is the point: the bytes come from Gmail first, then the OS is asked where to put
   * them — the other way round makes the user choose a location for a download that then
   * fails. The desktop shell opens a real save panel; the web build turns the same call
   * into a download.
   *
   * The guard is on `account`, not on the bridge existing: the bridge is built
   * unconditionally (even in demo mode), so the check that matters is that there is an
   * account to fetch bytes with.
   */
  /**
   * Fetch the HTML body of the open message, if it is not already resident.
   *
   * A `useCallback` because it goes into the reader's effect dependency list: an identity
   * that changed every render would re-fire the fetch every render.
   */
  const loadSelectedBody = useCallback(() => {
    const id = storeRef.current.getSnapshot().view.selected?.id;
    if (id !== undefined) void storeRef.current.loadBody(id);
  }, []);

  const saveAttachment = useCallback(async (attachment: { index: number }) => {
    const s = storeRef.current;
    const email = snapshotRef.current.view.selected;
    const target = email?.attachments[attachment.index];
    const bridge = sessionRef.current;

    if (!email || !target) return;

    if (!bridge || !snapshotRef.current.account) {
      // No account means no bytes. Saying so beats a button that appears to do nothing.
      s.setError("Signing in to Gmail is required to download attachments. The demo inbox has none to give you.");
      return;
    }

    try {
      const fetched = await bridge.fetchAttachment(email.gmailId, target.id);
      await platform.saveFile(fetched.filename, fetched.bytes, fetched.mimeType);
      s.setError(null);
    } catch (error) {
      s.setError(
        error instanceof Error ? error.message : "Couldn't download that attachment.",
      );
    }
  }, []);

  // ── The keyboard ─────────────────────────────────────────────────────────

  /*
    Refs for everything the handler reads.

    The handler is registered once and never re-registered, so it must not close over
    render values: a closure over `composer` would be frozen at mount and Escape would
    never see the composer. Each ref is written on every render and read at keypress time.
    A stable listener, current values, no churn.

    Declared here rather than beside the state they mirror, because `pills` and the
    openers are computed below, and a `useRef` initialised from a not-yet-declared `const`
    is a temporal-dead-zone error.
  */
  const pillsRef = useRef(pills);
  pillsRef.current = pills;
  const openReplyRef = useRef(openReply);
  openReplyRef.current = openReply;
  const openForwardRef = useRef(openForward);
  openForwardRef.current = openForward;
  const openComposeRef = useRef(openCompose);
  openComposeRef.current = openCompose;
  const closeComposerRef = useRef(closeComposer);
  closeComposerRef.current = closeComposer;

  /** The element last pressed, for ⌘A to find the region the user is working in. */
  const lastPressRef = useRef<Element | null>(null);
  useEffect(() => {
    const onPress = (event: PointerEvent) => {
      lastPressRef.current = event.target instanceof Element ? event.target : null;
    };
    window.addEventListener("pointerdown", onPress, true);
    return () => window.removeEventListener("pointerdown", onPress, true);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const s = storeRef.current;
      const snap = snapshotRef.current;
      const open = composerRef.current;
      const rail = pillsRef.current;
      const batch = selectionRef.current;

      // An open menu owns the keyboard; its own handler has already acted.
      if (menuRef.current) return;

      /*
        ⌘A / Ctrl+A outside a text field selects the region the user is in — the
        reader, the Settings sheet — rather than the browser's whole document, which in
        an app whose chrome is unselectable means every scrap of selectable text at
        once: the banner, the status line and the open message run together. With no
        region to answer (the list has focus), it does nothing. A field keeps the
        platform's own select-all.
      */
      if (isSelectAll(event) && !isEditingTarget(event.target)) {
        event.preventDefault();
        selectRegion(
          selectAllScope([
            document.activeElement === document.body ? null : document.activeElement,
            // Focus on a control beside the scope in the same sheet (Settings' category
            // list): the sheet answers with the one scope it holds.
            document.activeElement?.closest('[role="dialog"]') ?? null,
            lastPressRef.current,
            document.getSelection()?.anchorNode?.parentElement ?? null,
          ]) as Element | null,
        );
        return;
      }

      // The open sidebar is modal: the app behind it is inert, so no shortcut reaches
      // it. Escape from outside the sidebar (focus fell to the body) still closes it.
      if (sidebarOpenRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          setSidebarOpen(false);
        }
        return;
      }

      // Enter or Space on a control that is not a row (an avatar, a star, a toolbar
      // button) is that button's click, not "open the message at the cursor".
      if (
        (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLButtonElement &&
        !event.target.hasAttribute("data-message-id")
      ) {
        return;
      }

      // Escape ends a multi-selection before it means anything else.
      if (
        event.key === "Escape" &&
        batch.size > 0 &&
        open === null &&
        snap.overlay === "none" &&
        !event.ctrlKey && !event.metaKey && !event.altKey
      ) {
        event.preventDefault();
        setSelection(EMPTY_SELECTION);
        return;
      }

      /*
        A `select` is not one of `INPUT`/`TEXTAREA`/`contentEditable`, so it falls through
        as "not text editing" and the canvas handler eats its arrow keys. It gets its own
        check.
      */
      const target = event.target as HTMLElement | null;
      const inDock = target instanceof Element && target.closest("[data-composer-dock]") !== null;
      const textEditing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        // `isContentEditable` is checked alongside the tag names because a
        // `contenteditable` div is a text field with no `type` attribute.
        target?.isContentEditable === true;

      const keyContext: KeyContext = {
        // Before sign-in there is nothing to route. `composerOpen` is separate from
        // `ready` because the composer is a text field *and* a modal: its Escape closes
        // the sheet, where a plain field's blurs, and the two need to be
        // distinguishable for that to work.
        // A docked reply is not modal: with focus outside it the reader's shortcuts work
        // as usual; inside it, it owns the keyboard like the sheet does.
        ready: snap.status === "ready" && (open === null || (dockedRef.current && !inDock)),
        composerOpen: open !== null && (!dockedRef.current || inDock),
        // `textEditing` deliberately excludes "the composer is open": it means *this
        // keypress landed in a field*, while the composer's own state is `composerOpen`.
        // With the composer open and focus on its body, both are true — and the router
        // checks `composerOpen` first, so the composer's Escape wins.
        textEditing,
        viewerOpen: snap.view.selected !== null,
        // `c` copies an open message's code and composes everywhere else.
        codeAvailable: Boolean(snap.view.selected?.code),
        overlayVisible: snap.overlay === "shortcuts" || snap.overlay === "settings",
        navigationVisible: snap.overlay === "navigation",
        filtersActive: snap.activeFilters.length > 0,
        hasActionTarget:
          snap.view.selected !== null || snap.cursorIndex !== NO_CURSOR || batch.size > 0,
        // The rail as the *pills* see it, not the store's ranked bucket list: sender
        // pills take digits too. Counting the store's list would make `7` address a pill
        // that is not there.
        railCount: rail.length,
      };

      const command = commandForKey(event.key, keyContext, {
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });

      if (!command) {
        // An unbound key is swallowed outside a text field, so the OS does not
        // beep. This app is keyboard-first and a beep reads as broken. `Tab` is
        // exempt inside `shouldSwallow` and must stay exempt here: it is how focus
        // reaches every control that draws a `focus-visible` ring.
        if (shouldSwallow(keyContext, event)) event.preventDefault();
        return;
      }

      event.preventDefault();
      const selectedId = snap.view.selected?.id;

      // With rows selected, the message verbs act on all of them.
      if (batch.size > 0 && (command.type === "archive" || command.type === "trash" || command.type === "toggleRead")) {
        const ids = orderedSelection(batch, snap.view.threads.map((row) => row.representative.id));
        if (command.type === "archive") s.archiveMany(ids);
        else if (command.type === "trash") s.trashMany(ids);
        else s.setReadMany(ids, snap.all.some((email) => batch.has(email.id) && email.unread));
        if (command.type !== "toggleRead") setSelection(EMPTY_SELECTION);
        return;
      }

      switch (command.type) {
        case "moveSelection":
          s.moveCursor(command.delta);
          break;
        case "scrollReader":
          setScrollStep((step) => step + command.delta);
          break;
        case "openSelected":
          s.openCursor();
          break;
        case "closeViewer":
          // On a phone, leaving the message leaves the list with no current row.
          s.closeReader({ dropCursor: phoneRef.current });
          break;
        case "closeComposer":
          // Escape, in a composer. Goes through `closeComposer` rather than straight
          // to `setComposer(null)` so it asks before discarding a written draft — the
          // same path the close button and the backdrop take.
          closeComposerRef.current();
          break;
        case "dismissOverlay":
          s.setOverlay("none");
          break;
        case "dismissNavigation":
          s.setOverlay("none");
          break;
        case "toggleStar":
          if (selectedId !== undefined) s.toggleStar(selectedId);
          break;
        case "copyCode":
          if (snap.view.selected?.code) copyCodeRef.current(snap.view.selected.id);
          break;
        case "archive":
          // Context-sensitive in the store, not here: the same key archives from the
          // inbox, unarchives from the archive and restores from the bin, and doing
          // that in one place is what keeps the optimistic update, the undo and the
          // server call agreeing about what happened.
          if (selectedId !== undefined) s.archive(selectedId);
          break;
        case "trash":
          if (selectedId !== undefined) s.trash(selectedId);
          break;
        case "toggleRead":
          if (selectedId !== undefined) toggleReadRef.current(selectedId);
          break;
        case "focusReply":
          openReplyRef.current();
          break;
        case "forward":
          openForwardRef.current();
          break;
        case "compose":
          openComposeRef.current();
          break;
        case "focusSearch":
          searchRef.current?.focus();
          // `select()` as well as focus, so a second `/` re-selects an existing
          // query rather than appending to it.
          searchRef.current?.select();
          break;
        case "toggleFilter": {
          // Addressed by *pill position*, not by the store's ranked bucket list: the pills
          // interleave sender pills, so index `3` is a different bucket in each.
          const pill = rail[command.railIndex];
          if (pill) s.toggleFilter(pill.id);
          break;
        }
        case "clearFilters":
          s.clearFilters();
          break;
        case "toggleNavigation":
          s.setOverlay(snap.overlay === "navigation" ? "none" : "navigation");
          break;
        case "moveNavigation":
          s.moveNavigation(command.delta);
          break;
        case "activateNavigation":
          // Through the store's own handler, so the keyboard and the mouse agree rather
          // than duplicating the palette's item list here.
          s.activateNavigation(NAVIGATION_ITEMS[snap.navigationIndex]?.id ?? "inbox");
          break;
        case "toggleShortcutsOverlay":
          s.setOverlay(snap.overlay === "shortcuts" ? "none" : "shortcuts");
          break;
        case "openSettings":
          s.setOverlay(snap.overlay === "settings" ? "none" : "settings");
          break;
        case "blurText":
          (event.target as HTMLElement | null)?.blur();
          break;
      }
    }

    // Registered once and never re-registered.
    //
    // Every value the handler needs is read through a ref — `snapshotRef`, `storeRef`,
    // `pillsRef`, `composerRef` — so the dependency list is empty and the listener is
    // installed for the life of the app.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Android Back ─────────────────────────────────────────────────────────

  /**
   * One press of Android's Back: close the topmost layer (`ui/backLayers.ts` has the
   * order and the reasons). Popovers and sheets are found in the DOM and closed with
   * the Escape they already answer, so a sheet added later is covered without being
   * listed here; the composer, sidebar, Settings and the reader are this component's
   * state and are closed directly. The composer is parked — kept as a draft, like a
   * docked reply the selection leaves — never discarded and never asked about.
   */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    const s = storeRef.current;
    const snap = s.getSnapshot();
    const popover = document.querySelector(POPOVER_SELECTOR);
    const sheets = [...document.querySelectorAll('[aria-modal="true"]')].filter(isSheetElement);
    const sheet = sheets[sheets.length - 1] ?? null;
    const state: BackState = {
      popover: menu !== null || popover !== null,
      sheet: sheet !== null,
      composer: composerRef.current !== null,
      sidebar: sidebarOpen,
      settings: snap.overlay === "settings",
      message: snap.selectedId !== null,
    };
    /** Escape on the element (or what has focus inside it), where its own handler is. */
    const escapeIn = (element: Element) => {
      const active = document.activeElement;
      const target = active && element.contains(active) ? active : element;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    };
    switch (backTarget(state)) {
      case "popover":
        if (menu) setMenu(null);
        else if (popover) escapeIn(popover);
        return;
      case "sheet":
        if (sheet) escapeIn(sheet);
        return;
      case "composer": {
        const current = composerRef.current;
        if (!current || current.sending) return;
        retireComposer(current, "park");
        composerRef.current = null;
        setComposer(null);
        return;
      }
      case "sidebar":
        setSidebarOpen(false);
        return;
      case "settings": {
        // A phone's category page steps back to the category list first, like its arrow.
        const back = document.querySelector<HTMLButtonElement>(
          '[data-settings-page="category"] button[aria-label="Back to Settings"]',
        );
        if (back) back.click();
        else s.setOverlay("none");
        return;
      }
      case "message":
        s.closeReader({ dropCursor: phoneRef.current });
        return;
      case "exit":
        // Only reached when a press lands between the last layer closing and Back being
        // handed back to Android below.
        void desktopPlatformExtras.exitApp();
    }
  };

  /**
   * Whether anything is open that Back should close. At the bare list Back belongs to
   * Android, which leaves the app the way every other app does (to the background,
   * rather than killing it), so the handler is only registered while this is true.
   */
  const backHasWork =
    menu !== null ||
    composer !== null ||
    sidebarOpen ||
    snapshot.overlay !== "none" ||
    snapshot.selectedId !== null ||
    setupOpen ||
    confirmDiscard ||
    confirmNoSubject !== null ||
    restoreOffer !== null;
  const android = info?.os === "android";
  useEffect(() => {
    if (!android || !backHasWork) return;
    return desktopPlatformExtras.onBackButton(() => backRef.current());
  }, [android, backHasWork]);

  // ── Render ───────────────────────────────────────────────────────────────

  /*
    Enter the demo.

    Not a lesser path — Winnow's product *is* the classification — but a *mode*, so it
    goes through `markDemoMode`, which drops the backend rather than just swapping the
    message array.
  */
  const enterDemo = useCallback(() => {
    const demo = demoMailbox();
    store.replaceAll(demo.emails);
    store.markDemoMode(demo.now, demo.drafts);
  }, [store]);

  /*
    The Google account sheet: set up, change or remove the user's own OAuth client.
    Rendered from both the sign-in screen and the app, because "Continue with Google"
    and "Connect Gmail" both lead here when no client is stored.
  */
  const googleSetup = setupOpen ? (
    <GoogleSetup
      kind={info?.kind === "desktop" ? "desktop" : "web"}
      current={oauthClient ?? null}
      redirectUri={redirectUri}
      android={androidSigning}
      signedIn={snapshot.account !== null}
      phone={phone}
      onTest={async (candidate) => {
        const bridge = sessionRef.current;
        if (!bridge) return { ok: false, message: "Sign-in is still starting up. Try again in a moment." };
        return bridge.testCredentials(candidate);
      }}
      onSaveAndConnect={async (candidate) => {
        const bridge = sessionRef.current;
        if (!bridge) throw new Error("Sign-in is still starting up. Try again in a moment.");
        await bridge.saveCredentials(candidate);
        setOauthClient(candidate);
        try {
          await runSignIn();
        } catch (error) {
          const failure = describeFailure(error);
          throw new Error(failure.hint ? `${failure.message} ${failure.hint}` : failure.message, { cause: error });
        }
        setSetupOpen(false);
        applySharedLink(launchLink.current);
      }}
      onRemove={async () => {
        const bridge = sessionRef.current;
        if (!bridge) return;
        await bridge.removeCredentials();
        setOauthClient(null);
      }}
      onOpenGuide={() => {
        void platform.openExternal(SETUP_GUIDE_URL);
      }}
      onOpenLink={(url) => {
        void platform.openExternal(url);
      }}
      onClose={() => setSetupOpen(false)}
    />
  ) : null;

  if (snapshot.status === "signed_out") {
    return (
      <>
      <SignInScreen
        onSignIn={signIn}
        onTryDemo={enterDemo}
        // Still resolving whether a session exists. Bounded by the bridge resolving
        // rather than by a timer, so it cannot hang on a claim.
        restoring={restoringSession}
        hasDemo
        needsSetup={oauthClient === null}
      />
      {googleSetup}
      </>
    );
  }

  {/*
    The "could not reach Gmail" screen.

    Reachable, with two real answers. A *failed connection* shows this, and the demo is
    something you choose rather than something you are left in — the demo seed is cleared
    by `enterDemo` below, so the screen's own condition decides, not a stale mailbox. (The
    version before this had a button that did nothing, on a screen nobody could reach.)
  */}
  if (snapshot.status === "error") {
    return (
      <div className="flex h-dvh items-center justify-center bg-canvas px-6">
        <div data-select-scope="" className="max-w-[36rem] text-center">
          <h1 className="selectable text-title font-semibold tracking-[-0.01em] text-ink">Couldn&rsquo;t reach Gmail</h1>
          <p data-connection-error="" className="mt-2 text-ui text-ink-muted">
            {snapshot.error && <ErrorText text={snapshot.error} className="text-left" />}
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                void store.retryConnection();
              }}
              className="rounded-ctl bg-accent px-4 py-2 text-ui font-semibold text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={enterDemo}
              className="rounded-ctl border border-control-border px-4 py-2 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Use the demo inbox
            </button>
          </div>
        </div>
      </div>
    );
  }

  /*
  Where you are in the list.

  `null` before the first move, rendered as just the total. The cursor is `NO_CURSOR` until
  the user touches the keyboard, and rendering that as `0` produced "Inbox 0 of 38" — which
  reads as an empty mailbox and is wrong on every count.

  From `readoutIndex`, never from `cursorIndex` alone: with a message open the number is
  that message's row, and an open message that is not a visible row gets no number. The
  cursor is a separate index that every list change can shift; numbering from it put
  "4 of 39" over the fifth message after an archive above it or a sync.
*/
const readout = readoutIndex(snapshot, view);
const position = readout === NO_CURSOR ? null : readout + 1;

/*
  The list's notion of a "current" message, which only the desktop has.

  On a phone the list and the reader are never on screen together: a tap opens the
  message over the list, and Back returns to the list. A highlighted row would mark the
  message you just *left*, the cursor would claim a place in a list nobody is moving
  through, and "4 of 39" would number a row that is no longer special. So the phone list
  is given no selection and no cursor at all — the store still tracks both, because the
  reader and the keyboard need them, but none of it reaches the list.
*/
// The row's own message, which is not the open one when an earlier message of the
// conversation is being read, or the thread has had a reply since it was opened.
const listSelectedId = phone
  ? null
  : (view.threads[view.selectedIndex]?.representative.id ?? snapshot.selectedId);
const listCursor = phone ? NO_CURSOR : snapshot.cursorIndex;

  /**
   * The composer, built once and placed by layout: docked in the reader pane for a
   * desktop reply or forward, a sheet (or the phone's full screen) for everything else.
   */
  const composerElement = composer ? (
        <Composer
          mode={composer.mode}
          to={composer.draft.to}
          cc={composer.draft.cc}
          bcc={composer.draft.bcc}
          from={composer.mode === "new" ? (snapshot.account?.email ?? DEMO_ACCOUNT.email) : null}
          subject={composer.draft.subject}
          body={composer.draft.body}
          sending={composer.sending}
          error={composer.error}
          contacts={view.contacts}
          /*
            The opt-in, offered where it is wanted — but only on the desktop. The desktop
            asks Google in the system browser and comes straight back to this draft; the
            web build has to navigate the page away, which would throw the draft out, so
            there the same action lives in Settings instead.
          */
          improveSuggestions={
            snapshot.contactsAccess === "not_granted" && info?.nativeOAuth
              ? {
                  busy: contactsBusy,
                  error: contactsError,
                  onClick: onImproveSuggestions,
                }
              : null
          }
          onChange={(patch) =>
            setComposer((current) =>
              current
                ? {
                    ...current,
                    draft: {
                      ...current.draft,
                      ...patch,
                      // The quote is stripped only while it is still an untouched
                      // suffix, so a reply that never touched the original sends the
                      // user's words alone — and one that *did* edit the quote keeps
                      // it, because at that point it is their message.
                      // `!== undefined`, not truthiness: clearing the body is an edit too,
                      // and treating "" as "no change" put the last character back.
                      body:
                        patch.body !== undefined
                          ? stripQuote(patch.body, current.draft.quoteBlock)
                          : current.draft.body,
                    },
                  }
                : current,
            )
          }
          phone={phone}
          docked={docked}
          replyAll={composer.replyAll ?? true}
          onReplyAllChange={
            composer.mode === "reply" && composer.replyTo !== undefined && composer.replyTo === selectedGmailId
              ? setReplyAll
              : undefined
          }
          saveStatus={composer.status}
          onAllowDrafts={sessionRef.current ? () => void allowDrafts() : null}
          allowingDrafts={allowingDrafts}
          onSend={(recipients) => {
            void sendDraft(recipients);
          }}
          // Discard is the button that already says the word, so it does not ask.
          onDiscard={() => closeComposer(true)}
          // Escape and the close button ask if there is anything to lose.
          onClose={() => closeComposer()}
        />
  ) : null;

  {
    const sentence = attentionSentence(view.attention);
    attentionRef.current = snapshot.mailbox === "inbox" && sentence !== "Nothing needs you right now" ? sentence : null;
  }
  /** What the inbox needs from you, the sync line, and the demo's Connect Gmail. */
  const briefing = (
          <div data-briefing="" className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
            <div className="min-w-0">
              {snapshot.mailbox === "inbox" && (
                <p data-attention="" className="text-ui font-medium text-ink sm:truncate">
                  {attentionSentence(view.attention)}
                </p>
              )}
              <p
                data-sync-status={sync.tone}
                role="status"
                aria-live="polite"
                className={`selectable text-meta sm:truncate ${
                  sync.tone === "error" ? "text-danger" : "text-ink-subtle"
                }`}
              >
                {sync.line}
              </p>
            </div>
            {snapshot.account === null ? (
              <button
                type="button"
                onClick={() => {
                  void connectFromDemo();
                }}
                disabled={signingIn}
                // The demo's one primary action, so it is the one filled control in view.
                className="flex shrink-0 items-center gap-1.5 rounded-ctl bg-accent px-3 py-1.5 text-meta font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50 max-sm:min-h-11 max-sm:px-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <LogIn size={12} strokeWidth={2.2} aria-hidden="true" />
                {signingIn ? "Waiting for Google…" : "Connect Gmail"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void store.refresh();
                }}
                disabled={sync.busy}
                aria-label={sync.button}
                title={sync.button}
                data-sync-button=""
                className="flex shrink-0 items-center gap-1.5 rounded-ctl px-2.5 py-1.5 text-meta font-medium text-ink-body transition-colors hover:bg-sheen hover:text-ink disabled:opacity-50 max-sm:min-h-11 max-sm:px-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <RefreshCw
                  size={12}
                  strokeWidth={2.2}
                  className={snapshot.syncing ? "animate-spin" : ""}
                  aria-hidden="true"
                />
                {sync.button}
              </button>
            )}
          </div>
  );
  /**
   * The phone's demo line: where you are and Connect Gmail, on one compact row. With an
   * account the phone has no strip at all (pull to refresh instead).
   */
  const compactBriefing = (
    <div data-briefing="compact" className="flex min-h-12 items-center justify-between gap-3 px-4 py-1">
      <p
        data-sync-status={sync.tone}
        role="status"
        aria-live="polite"
        className={`selectable min-w-0 truncate text-meta ${sync.tone === "error" ? "text-danger" : "text-ink-subtle"}`}
      >
        {sync.line}
      </p>
      <button
        type="button"
        onClick={() => {
          void connectFromDemo();
        }}
        disabled={signingIn}
        className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-ctl bg-accent px-3.5 text-meta font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <LogIn size={12} strokeWidth={2.2} aria-hidden="true" />
        {signingIn ? "Waiting for Google…" : "Connect Gmail"}
      </button>
    </div>
  );
  const connectNotice = connectError ? (
    <div role="alert" className="px-4 pb-2 text-meta font-medium text-danger">
              <ErrorText text={connectError} />
            </div>
  ) : null;

  return (
    <SenderPicturesContext.Provider value={senderPictures}>
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      {/*
        Everything but the phone's dock is inert while the sidebar is open. The dock stays
        live (and above the scrim) so the Expand chevron that opened the menu can close it;
        the two `contents` wrappers keep the column's layout exactly as it was.
      */}
      <div inert={sidebarOpen} className="contents">
      {/*
        The chrome. On a phone, the top bar (where you are, and search). On the desktop,
        search, where-you-are, the filter rail and the sidebar toggle head the list column
        (see `Masthead` below), and the email actions live in the reader. The sidebar
        itself is an overlay on both, rendered after everything else.
      */}
      {phone ? (
        // On a phone the reader takes the whole screen, its own way back included, so
        // the list's bar steps aside while a message is open.
        !selected && selection.size > 0 ? (
          // Held at the top bar's height, so entering select mode does not pull the list
          // up under the finger: a long-press that goes on to drag would otherwise land
          // on a row a bar's height further down than the one it meant.
          <div data-phone-selection-slot="" className="shrink-0" style={{ minHeight: phoneBarHeight || undefined }}>
          <SelectionBar
            phone
            count={selection.size}
            mailbox={snapshot.mailbox}
            anyUnread={snapshot.all.some((email) => selection.has(email.id) && email.unread)}
            onArchive={() => runBatch((s, ids) => s.archiveMany(ids))}
            onTrash={() => runBatch((s, ids) => s.trashMany(ids))}
            onSetRead={(read) => runBatch((s, ids) => s.setReadMany(ids, read), true)}
            onMove={(target) => runBatch((s, ids) => s.moveMany(ids, target))}
            onClear={() => setSelection(EMPTY_SELECTION)}
          />
          </div>
        ) : !selected && (
          <div ref={measurePhoneBar} className="shrink-0">
          <PhoneTopBar
            searchQuery={snapshot.searchQuery}
            onSearchChange={store.setSearchQuery.bind(store)}
            searchRef={searchRef}
            listTitle={store.listTitle()}
            mailboxName={MAILBOX_LABEL[snapshot.mailbox]}
            position={null}
            total={view.threads.length}
          />
          </div>
        )
      ) : null}

      <p role="status" aria-live="polite" className="sr-only" data-code-announcement="">
        {codeAnnouncement}
      </p>

      {announcement && (
        <p aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </p>
      )}

      {snapshot.error && (
        <div
          role="alert"
          data-error-banner=""
          className="flex items-start justify-between gap-3 border-b border-hairline bg-danger-wash px-4 py-1.5 text-meta font-medium text-ink-body"
        >
          {/*
            The whole error, selectable and with a Copy button: this is the text a user
            pastes into a search or a bug report, and a truncated line cannot be copied
            past its ellipsis.
          */}
          <ErrorText text={snapshot.error} className="min-w-0 flex-1" />
          <button
            type="button"
            onClick={store.dismissError.bind(store)}
            className="shrink-0 font-semibold text-ink-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Dismiss
          </button>
        </div>
      )}

      {/*
        The notice strip.

        For what a sync told the user without it being a failure — a mailbox that hit its
        cap, so the view is a triage set rather than an export — which must not wear the
        alarming, dismissible banner of an error.
      */}
      {snapshot.notice && (
        <div className="flex items-center justify-between gap-3 border-b border-hairline-soft bg-notice px-4 py-1.5 text-meta font-medium text-ink-body">
          <span data-notice-text="" className="selectable min-w-0 truncate">{snapshot.notice}</span>
          <button
            type="button"
            onClick={store.dismissNotice.bind(store)}
            className="shrink-0 font-semibold text-ink-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Dismiss
          </button>
        </div>
      )}

      {/*
        The offline-storage question.

        A prompt, not a notice: the last sync could not write the offline cache, and the
        answer decides what happens — "Save" asks for persistent storage and retries the
        write, "Not now" keeps re-downloading on launch for the rest of this session.
      */}
      {snapshot.storagePrompt !== null && (
        <div
          role={snapshot.storagePrompt === "failed" ? "status" : "alertdialog"}
          aria-label="Save this mailbox offline"
          className="flex items-center justify-between gap-3 border-b border-hairline-soft bg-notice px-4 py-1.5 text-meta font-medium text-ink-body"
        >
          <span className="selectable min-w-0">
            {snapshot.storagePrompt === "failed" ? STORAGE_SAVE_FAILED : STORAGE_PROMPT}
          </span>
          {snapshot.storagePrompt === "failed" ? (
            <button
              type="button"
              onClick={store.dismissStoragePrompt.bind(store)}
              className="shrink-0 font-semibold text-ink-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Dismiss
            </button>
          ) : (
            <span className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                disabled={snapshot.storagePrompt === "saving"}
                onClick={() => void store.saveMailboxOffline()}
                className="font-semibold text-ink hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60"
              >
                {snapshot.storagePrompt === "saving" ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                disabled={snapshot.storagePrompt === "saving"}
                onClick={store.declineMailboxStorage.bind(store)}
                className="font-semibold text-ink-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60"
              >
                Not now
              </button>
            </span>
          )}
        </div>
      )}

      {/*
        The undo strip.

        For a verb with no inverse on screen (`state.undo`). Mark all read, its first
        user, has been removed; the strip stays for the next one.

        Positioned below the notices rather than over the list, since it appears precisely
        when the user is mid-triage. It does not expire on a timer — an action, a two-second
        pause, and a gone toast is worse than no toast, because the user learns the
        affordance is unreliable — but waits for an explicit dismissal, a different action,
        or a navigation.
      */}
      {labelPicker && labelTargets.length > 0 && (
        <LabelPicker
          labels={snapshot.userLabels}
          loading={snapshot.labelsLoading}
          targets={labelTargets}
          onCreate={(name) => store.createLabel(name)}
          onApply={(add, remove) => {
            store.applyLabels(labelPicker, add, remove);
            setLabelPicker(null);
            const message =
              labelPicker.length === 1 ? "Labels updated." : `Labels updated on ${labelPicker.length} messages.`;
            store.setNotice(message);
            setTimeout(() => {
              if (storeRef.current.getSnapshot().notice === message) storeRef.current.dismissNotice();
            }, DRAFT_NOTICE_MS);
          }}
          onClose={() => setLabelPicker(null)}
        />
      )}

      {sendWait && <SendingStrip deadline={sendWait.deadline} onUndo={undoSend} onSendNow={sendWaitingNow} />}

      {snapshot.undo && (
        <div
          role="status"
          // Re-keyed per action, so the strip arrives with the same short rise every time
          // something is archived or trashed rather than only the first time.
          key={snapshot.undo.label}
          className="flex animate-appear items-center justify-center gap-3 px-4 py-1.5 text-meta"
        >
          <span data-undo-label="" className="selectable min-w-0 truncate text-ink-muted">{snapshot.undo.label}</span>
          <button
            type="button"
            onClick={store.undoLast.bind(store)}
            className="shrink-0 rounded-ctl bg-sheen px-2.5 py-0.5 font-medium text-ink-body transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={store.dismissUndo.bind(store)}
            aria-label="Dismiss"
            className="shrink-0 rounded-ctl p-1 text-ink-subtle transition-colors hover:bg-sheen hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <X size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      )}

      {/*
        One surface, two regions.

        The list is the surface and the reader is a *half-step* off it — `surfaceSunken`,
        one tonal value, not a card — so the boundary is a change in value rather than a
        line, a gap, or an object with an edge. No radius and no shadow anywhere.

        Small screens replace one with the other: the reader covers the list outright,
        since there is no width for two regions.
      */}
      <main ref={mainRef} className="flex min-h-0 flex-1">
        {/*
          The list.

          Hidden below `lg` while a message is open, with the reader shown instead: both
          are flex children of `main`, so both fill the space below the header, and the
          reader needs no positioning, no z-index and no opaque variant. At `lg` both show,
          because there the reader is a pane beside the list rather than a replacement.
        */}
        <div
          ref={listPaneRef}
          className={`${
            selected ? "hidden lg:flex" : "flex"
          } relative min-h-0 min-w-0 flex-1 flex-col bg-surface`}
        >
          {/*
            The mailbox's own status line, and the demo note.

            Both are about the mail, not the app: the demo note describes what you are
            looking at, and the sync line when it last arrived. The demo's route to a real
            account is a button here rather than in a settings panel, because the app boots
            into the demo and never shows the sign-in screen on first run.
          */}
          {/*
            The triage line, then the status line under it.

            The first line is Winnow's one signature: what in the inbox needs you, as a
            sentence ("3 waiting on you and 2 deliveries today"), derived from the
            classifier's own signals. Only in the inbox — it is a claim about the inbox,
            and over Sent or the bin it would be answering a question nobody asked.
          */}
          {/*
            The desktop's header floats over the list (see `Masthead`): the glass bar and
            the chips, or the selection bar in the chips' place. The list scrolls under it
            and pads its top by its measured height; a wheel over the bar scrolls the list
            (the rail keeps its own wheel, which moves it sideways).
          */}
          {!phone && (
            <div
              ref={measureListChrome}
              data-list-chrome=""
              onWheel={forwardChromeWheel}
              className="pointer-events-none absolute inset-x-0 top-0 z-20"
            >
            <Masthead
              searchQuery={snapshot.searchQuery}
              onSearchChange={store.setSearchQuery.bind(store)}
              searchRef={searchRef}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={toggleSidebar}
              pills={pills}
              activeFilters={snapshot.activeFilters}
              onToggleFilter={store.toggleFilter.bind(store)}
              onClearFilters={store.clearFilters.bind(store)}
              position={position}
              total={view.threads.length}
              listTitle={store.listTitle()}
              canPrev={store.canStep(-1)}
              canNext={store.canStep(1)}
              onPrev={() => store.moveCursor(-1)}
              onNext={() => store.moveCursor(1)}
              onCompose={() => openCompose()}
              replaceRail={
                selection.size > 0 ? (
                  <SelectionBar
                    phone={false}
                    count={selection.size}
                    mailbox={snapshot.mailbox}
                    anyUnread={snapshot.all.some((email) => selection.has(email.id) && email.unread)}
                    onArchive={() => runBatch((s, ids) => s.archiveMany(ids))}
                    onTrash={() => runBatch((s, ids) => s.trashMany(ids))}
                    onSetRead={(read) => runBatch((s, ids) => s.setReadMany(ids, read), true)}
                    onMove={(target) => runBatch((s, ids) => s.moveMany(ids, target))}
                    onClear={() => setSelection(EMPTY_SELECTION)}
                  />
                ) : undefined
              }
            />
            </div>
          )}
          {/*
            The briefing. On a phone it heads the list as before; on the desktop it is
            the first thing in the list's own scroll (`lead`), under the floating header
            at rest and scrolled away with the mail, so its small grey sync line is never
            read over moving rows and Connect Gmail is a scroll (or Home) away. The
            Connect action is also in the sidebar's account menu.
          */}
          {/*
            On a phone with an account there is no strip: a pull down from the top syncs
            (`PullRefresh`), and what is waiting on you rides along in its result. The demo
            keeps one compact line, so Connect Gmail stays in reach.
          */}
          {phone && snapshot.account === null && compactBriefing}
          {phone && connectNotice}
          {phone && snapshot.account !== null && (
            <PullRefresh
              containerRef={listPaneRef}
              context={{
                connected: true,
                menuOpen: sidebarOpen,
                selecting: selection.size > 0,
                overlay: snapshot.overlay !== "none" || composer !== null || menu !== null || labelPicker !== null,
              }}
              syncing={sync.busy}
              onRefresh={() => storeRef.current.refresh()}
              result={() => {
                const after = storeRef.current.getSnapshot();
                if (after.error) return { ok: false, text: after.error };
                const waiting = attentionRef.current;
                return { ok: true, text: waiting ? `Synced just now · ${waiting}` : "Synced just now" };
              }}
            />
          )}
          <MessageList
            threads={view.threads}
            signals={view.signals}
            selectedId={listSelectedId}
            cursorIndex={listCursor}
            revealSeq={snapshot.revealSeq}
            unreadIds={unreadIds}
            freshIds={snapshot.recentIds}
            emptyReason={view.result.emptyReason}
            sortBy={preferences.sortBy}
            onSelect={handleSelectRow}
            onToggleStar={handleToggleStar}
            onClearFilters={store.clearFilters.bind(store)}
            onClearSearch={() => store.setSearchQuery("")}
            onSync={() => {
              if (snapshot.mailbox === "drafts") void store.refreshDrafts();
              else void store.refresh();
            }}
            emptyMailbox={
              snapshot.mailbox === "drafts"
                ? { body: snapshot.draftsLoading ? "Loading your drafts…" : "No drafts.", action: "Check for drafts" }
                : undefined
            }
            // Only a real account has something to sync with. Offering the button
            // over the demo would be a control that cannot do anything, which is the
            // exact failure the empty state's own copy was written to avoid.
            canSync={snapshot.account !== null}
            now={snapshot.now}
            photos={photos}
            selection={selection}
            onSelectionChange={setSelection}
            touchSelect={phone}
            onAvatar={openSenderMenu}
            onRowMenu={phone ? undefined : openRowMenu}
            onCopyCode={copyCode}
            copiedCodeId={copiedCodeId}
            // Swipes are the phone's, and stand down while anything sits over the list.
            // The desktop's floating header covers the list's top, and the briefing
            // scrolls with the list under it.
            topInset={phone ? 0 : listChromeHeight}
            lead={
              phone ? undefined : (
                <>
                  {briefing}
                  {connectNotice}
                </>
              )
            }
            swipe={
              phone && preferences.swipeActions && !menu && !labelPicker && !sidebarOpen && !composer && snapshot.overlay === "none"
                ? swipeConfig
                : null
            }
            className="min-w-0"
          />
        </div>

        {/*
          The reader.

          Keyed on the message so the pane remounts per selection: the reader restarts at
          the top, and `animate-appear` re-fires on every change instead of only on load.
          A sibling of the list rather than an overlay, and only rendered when there is a
          message — see the note on the list for why.
        */}
        {/*
          Nothing at all on a phone until a message is open: there the reader replaces the
          list rather than sitting beside it, so its empty state ("Nothing selected") would
          describe a selection the phone does not have.
        */}
        {/*
          The divider. Wide layout only: the handle hides itself below `lg` with the
          reader-beside-list arrangement it resizes, and a phone never renders it.
        */}
        {!phone && <ReaderSplitHandle containerRef={mainRef} />}
        {(!phone || selected) && (
          <div
            key={selected?.id ?? "empty"}
            // At `lg` the width is the split's: see `[data-reader-pane]` in `index.css`.
            data-reader-pane=""
            // `w-full min-w-0` below `lg`, and the width is not optional there.
            //
            // Without `min-w-0` this pane is a flex item whose base size is its content —
            // `max-w-[68ch]` of body text, 733px — which overflows a 390px phone and gets
            // clipped by `body { overflow: hidden }`, leaving the message unreadable and the
            // action toolbar past the viewport. The list pane beside it already carries
            // `min-w-0` for the same reason.
            className={`${
              selected ? "flex" : "hidden lg:flex"
            } min-h-0 w-full min-w-0 flex-col bg-surface-sunken lg:shrink-0 lg:border-l lg:border-edge ${
              selected ? "animate-appear" : ""
            }`}
          >
            <Reader
              onMailto={openMailto}
              email={selected}
              conversation={view.conversation}
              signals={selected ? (view.signals.get(selected.id) ?? null) : null}
              mailbox={snapshot.mailbox}
              // Either the global preference, or this one message the reader's own
              // escape hatch has been used on. See `remoteFor`.
              imagesAllowed={imagesAllowed}
              askAboutImages={askAboutImages}
              accountAddress={snapshot.account?.email ?? null}
              now={snapshot.now}
              onClose={closeReader}
              scrollStep={scrollStep}
              // The HTML body is resident for a recent window and fetched for anything
              // older, so "not here yet" is the normal state for a message far enough
              // back. See `BODY_RETENTION` in the store.
              bodyPending={selected !== null && !store.hasLoadedBody(selected.id)}
              onLoadBody={loadSelectedBody}
              phone={phone}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={phone ? undefined : toggleSidebar}
              senderPhoto={selected ? photos.get(selected.sender.toLowerCase()) : undefined}
              codeBar={
                selected?.code ? (
                  <CodeBar
                    code={selected.code}
                    copied={copiedCodeId === selected.id}
                    onCopy={() => copyCode(selected.id)}
                    phone={phone}
                  />
                ) : null
              }
              onSenderMenu={(trigger) => {
                if (selected) openSenderMenu(selected.id, trigger);
              }}
              actions={{
                onStar: act((s, snap) => {
                  if (snap.view.selected) s.toggleStar(snap.view.selected.id);
                }),
                onRead: act((_s, snap) => {
                  if (snap.view.selected) toggleReadFor(snap.view.selected.id);
                }),
                onArchive: act((s, snap) => {
                  if (snap.view.selected) s.archive(snap.view.selected.id);
                }),
                onTrash: act((s, snap) => {
                  if (snap.view.selected) s.trash(snap.view.selected.id);
                }),
                onReply: openReply,
                onForward: openForward,
                onNotSpam: act((s, snap) => {
                  // "Not spam" is a move to the inbox, which is exactly what
                  // `store.move` does — so it inherits the optimistic update, the undo,
                  // and the label pair Gmail needs (drop SPAM, add INBOX) rather than
                  // needing a third code path for the same operation.
                  if (snap.view.selected) s.move(snap.view.selected.id, "inbox");
                }),
                onShowOriginal: () => {
                  // Opened in the system browser, which is a different origin from the
                  // app and the only context in which a message's own scripts can run —
                  // so the sender gets no handle on anything Winnow knows. The comment
                  // above said this was a `winnow:` deep link, which it is not, and which
                  // would have been a link into the app itself.
                  const gmailId = selected?.gmailId;
                  if (!gmailId) return;
                  void platform.openExternal(`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(gmailId)}`);
                },
                onBlockSender: act((s, snap) => {
                  if (snap.view.selected) {
                    s.blockSender(snap.view.selected.sender);
                    s.closeReader({ dropCursor: phoneRef.current });
                  }
                }),
                onLabelAs: () => {
                  if (selected) openLabelPicker([selected.id]);
                },
                onLoadRemoteContent: act((_store, snap) => {
                // Not a preference change: this message only. See `remoteFor`.
                if (snap.view.selected) setRemoteFor(snap.view.selected.id);
              }),
                onAlwaysLoadRemoteContent: () => {
                  store.setPreferences({ imagePolicy: "always" });
                  // The hatch is redundant once the answer is standing, and leaving it
                  // set would keep this one message's grant alive behind a policy that
                  // no longer needs it.
                  setRemoteFor(null);
                },
                onNeverLoadRemoteContent: () => {
                  store.setPreferences({ imagePolicy: "never" });
                  setRemoteFor(null);
                },
                onOpenMessage: (id) => {
                  // `focusMessage` rather than `select`, because the earlier message may
                  // not be in the current list — it may be in another mailbox, or behind
                  // the active filters — and the store handles both.
                  store.focusMessage(id);
                },
                onSaveAttachment: saveAttachment,
              }}
            />
            {/* The docked reply: under the conversation, inside this pane. */}
            {docked && composerElement}
          </div>
        )}
      </main>

      {/*
        The phone's dock: a floating pill (Inbox, Sent, Expand) with the compose button
        beside it and the smart-filter chips floating above, over the list. Not while
        reading — the reader brings its own action bar.
      */}
      </div>

      {phone && !selected && (
        <PhoneDock
          pills={pills}
          activeFilters={snapshot.activeFilters}
          onToggleFilter={store.toggleFilter.bind(store)}
          onClearFilters={store.clearFilters.bind(store)}
          mailbox={snapshot.mailbox}
          unread={paletteUnread}
          onSelectMailbox={(mailbox) => {
            store.setOverlay("none");
            store.setMailbox(mailbox);
          }}
          settingsOpen={snapshot.overlay === "settings"}
          menuOpen={sidebarOpen}
          onOpenMenu={openSidebar}
          onCloseMenu={closeSidebar}
          // Compose is offered over the list and nothing else: not under the composer,
          // Settings, the palette or the shortcut sheet, each of which is the thing being
          // looked at, and not during a multi-selection, whose bar has taken over the
          // screen's actions. It stays beside the menu panel, as in the reference.
          onCompose={
            composer === null &&
            snapshot.overlay === "none" &&
            selection.size === 0 &&
            snapshot.status === "ready"
              ? () => openCompose()
              : null
          }
          // Back to top, likewise, only over the plain list.
          backToTopAllowed={composer === null && snapshot.overlay === "none" && selection.size === 0 && !menu && !labelPicker}
        />
      )}

      <div inert={sidebarOpen} className="contents">
      {snapshot.overlay === "shortcuts" && (
        <ShortcutSheet onClose={() => store.setOverlay("none")} />
      )}

      {snapshot.overlay === "navigation" && (
        <NavigationPalette
          index={snapshot.navigationIndex}
          unread={paletteUnread}
          onActivate={(item) => store.activateNavigation(item)}
          onClose={() => store.setOverlay("none")}
        />
      )}

      {snapshot.overlay === "settings" && (
        <Settings
          sortBy={preferences.sortBy}
          onSortBy={store.setSortBy.bind(store)}
          appearance={preferences.appearance}
          onAppearance={(appearance) => store.setPreferences({ appearance })}
          accentTheme={preferences.accent}
          accentChoices={accentChoices}
          onAccentTheme={(accent) => store.setPreferences({ accent })}
          // Both hosts render a message's HTML in a `sandbox=""` iframe, which loads its
          // images and executes none of its code. A *prop* rather than a constant so a
          // build that genuinely could not would say so rather than offering a switch that
          // does nothing.
          canLoadRemoteContent
          imagePolicy={preferences.imagePolicy}
          onImagePolicy={(imagePolicy) => store.setPreferences({ imagePolicy })}
          markReadOnOpen={preferences.markReadOnOpen}
          onMarkReadOnOpen={(value) => store.setPreferences({ markReadOnOpen: value })}
          swipeActions={phone ? preferences.swipeActions : null}
          onSwipeActions={(value) => store.setPreferences({ swipeActions: value })}
          undoSendSeconds={preferences.undoSendSeconds}
          onUndoSendSeconds={(value) => store.setPreferences({ undoSendSeconds: value })}
          brandLogos={preferences.brandLogos}
          onBrandLogos={(value) => store.setPreferences({ brandLogos: value })}
          gravatars={preferences.gravatars}
          onGravatars={(value) => store.setPreferences({ gravatars: value })}
          notificationsEnabled={preferences.notificationsEnabled}
          onNotifications={(notificationsEnabled) => {
            store.setPreferences({ notificationsEnabled });
            if (!notificationsEnabled) return;
            /*
              Ask, and *believe the answer*.

              A declined OS prompt turns the toggle back off: the preference and the
              permission are the same thing, and the preference is the one the user can see.
            */
            void platform.requestNotificationPermission().then((granted) => {
              if (!granted) {
                store.setPreferences({ notificationsEnabled: false });
                store.setError(
                  "Notifications are off for Winnow. Turn them on in your system settings to use this.",
                );
              }
            });
          }}
          backgroundSync={info?.backgroundSync ?? null}
          onBackgroundSync={(backgroundSync) => store.setPreferences({ backgroundSync })}
          backgroundSyncInterval={preferences.backgroundSyncInterval}
          onBackgroundSyncInterval={(backgroundSyncInterval) =>
            store.setPreferences({ backgroundSyncInterval })
          }
          onResetSorting={store.resetLearning.bind(store)}
          events={snapshot.learning.history}
          blockedSenders={preferences.blockedSenders}
          onUnblock={store.unblockSender.bind(store)}
          mutedSenders={preferences.mutedSenders}
          onUnmute={store.unmuteSender.bind(store)}
          isDesktop={info?.kind === "desktop"}
          googleClient={oauthClient ? maskClientId(oauthClient.clientId) : null}
          signedIn={snapshot.account !== null}
          onGoogleAccount={() => {
            store.setOverlay("none");
            setSetupOpen(true);
          }}
          contactsAccess={snapshot.contactsAccess}
          contactsBusy={contactsBusy}
          contactsError={contactsError}
          contactsProblem={contactsProblem}
          onOpenContactsHelp={(url) => void platform.openExternal(url)}
          onImproveSuggestions={onImproveSuggestions}
          version={info ? `${info.name} ${info.version}` : null}
          platformLabel={info ? platformLabel(info) : null}
          onClose={() => store.setOverlay("none")}
        />
      )}

      {googleSetup}
      {/*
        The sender menu (avatar) and the row context menu. One at a time, fixed to the
        viewport, built from `ui/menus` so what each contains is unit-tested.
      */}
      {menu && snapshot.mailbox === "drafts" && (() => {
        // A Drafts row: open it or discard it, from the avatar or the row alike — the
        // sender of every draft is the user, so a sender menu would say nothing.
        const row = store.draftRow(menu.id);
        if (!row) return null;
        const close = () => setMenu(null);
        const single = menu.ids.length === 1;
        const noop = () => {};
        return (
          <Menu
            testId="row"
            label={single ? `Actions for draft: ${row.subject || "no subject"}` : `Actions for ${menu.ids.length} drafts`}
            anchor={menu.anchor}
            returnFocus={menu.trigger}
            onClose={close}
            items={buildRowMenu({
              count: menu.ids.length,
              mailbox: "drafts",
              anyUnread: false,
              actions: {
                reply: noop,
                replyAll: noop,
                forward: noop,
                archive: noop,
                trash: noop,
                setRead: noop,
                move: noop,
                toggleMuteSender: noop,
                findFrom: noop,
                findSubject: noop,
                openInGmail: noop,
                openDraft: () => openDraftRow(row.id),
                discardDraft: () => {
                  void store.discardDrafts(menu.ids);
                  if (!single) setSelection(EMPTY_SELECTION);
                },
              },
            })}
          />
        );
      })()}
      {menu && snapshot.mailbox !== "drafts" && (() => {
        const email = snapshot.all.find((candidate) => candidate.id === menu.id);
        if (!email) return null;
        const close = () => setMenu(null);
        const notice = (text: string) => store.setNotice(text);
        const name = displayName(email);
        const muted = store.isSenderMuted(email.sender);
        const leaveReaderIfFrom = (sender: string) => {
          const open = snapshotRef.current.view.selected;
          if (open && open.sender.toLowerCase() === sender.toLowerCase()) {
            store.closeReader({ dropCursor: phoneRef.current });
          }
        };
        const toggleMute = () => {
          if (muted) {
            store.unmuteSender(email.sender);
            notice(`Unmuted ${email.sender}.`);
          } else {
            store.muteSender(email.sender);
            notice(`Muted ${email.sender}: their mail stays here but won't notify or count as unread on the badge.`);
          }
        };
        const showAll = () => {
          setSelection(EMPTY_SELECTION);
          store.showSender(email.sender);
        };

        if (menu.kind === "sender") {
          // The rows "Select" and "Select all from this sender" act on: list rows only,
          // so a message the reader shows that is not in the list offers neither.
          const inList = rowOrder.includes(email.id);
          const sender = email.sender.toLowerCase();
          const fromSender = view.threads
            .filter((row) => row.representative.sender.toLowerCase() === sender)
            .map((row) => row.representative.id);
          const savedContact = snapshot.googleContacts.some(
            (contact) => contact.source === "saved" && contact.address.toLowerCase() === email.sender.toLowerCase(),
          );
          return (
            <Menu
              testId="sender"
              label={`Sender options for ${name}`}
              header={
                <>
                  <Avatar name={name} address={email.sender} size={36} />
                  <span className="min-w-0">
                    <span className="block truncate text-ui font-semibold text-ink">{name}</span>
                    <span className="block truncate text-meta text-ink-muted">{email.sender}</span>
                  </span>
                </>
              }
              anchor={menu.anchor}
              returnFocus={menu.trigger}
              onClose={close}
              items={buildSenderMenu({
                name,
                address: email.sender,
                muted,
                savedContact,
                canUnsubscribe: email.unsubscribe !== undefined,
                selected: inList ? selection.has(email.id) : undefined,
                fromSenderCount: fromSender.length,
                offerContactPhotos: snapshot.contactsAccess === "not_granted",
                actions: {
                  connectContacts: onConnectContactPhotos,
                  select: () => {
                    // Into select mode with this row, from where the user adds more:
                    // drag down the avatars, click them, or ⌘/Shift-click rows. On a
                    // phone the reader covers the list, so it steps back to it first.
                    if (phoneRef.current && snapshotRef.current.view.selected) store.closeReader({ dropCursor: true });
                    setSelection((current) => toggleId(current, email.id));
                  },
                  selectAllFromSender: () => {
                    if (phoneRef.current && snapshotRef.current.view.selected) store.closeReader({ dropCursor: true });
                    setSelection((current) => new Set([...current, ...fromSender]));
                  },
                  showAll,
                  toggleMute,
                  block: () => {
                    store.blockSender(email.sender);
                    leaveReaderIfFrom(email.sender);
                    notice(`Blocked ${email.sender}: their mail is hidden in Winnow. Unhide it in Settings.`);
                  },
                  addToContacts: () => {
                    // Winnow's contact grant is read-only, so the contact is created in
                    // Google Contacts itself, with the address on the clipboard to paste.
                    void copyText(email.sender).then((copied) => {
                      notice(
                        copied
                          ? `Copied ${email.sender}. Paste it into the new contact in Google Contacts.`
                          : `Add ${email.sender} in Google Contacts.`,
                      );
                    });
                    void platform.openExternal("https://contacts.google.com/new");
                  },
                  unsubscribe: () => {
                    const unsubscribe = email.unsubscribe;
                    if (!unsubscribe) return;
                    if (unsubscribe.url) {
                      void platform.openExternal(unsubscribe.url);
                      notice(`Opened ${name}'s unsubscribe page in your browser.`);
                    } else if (unsubscribe.mailto) {
                      const address = mailtoAddress(unsubscribe.mailto);
                      void copyText(address).then((copied) => {
                        notice(
                          `${name} unsubscribes by email: send a message to ${address}${copied ? " (copied)" : ""}.`,
                        );
                      });
                    }
                  },
                  copyAddress: () => {
                    void copyText(email.sender).then((copied) => {
                      notice(copied ? `Copied ${email.sender}.` : `Couldn't copy ${email.sender}.`);
                    });
                  },
                },
              })}
            />
          );
        }

        const targets = snapshot.all.filter((candidate) => menu.ids.includes(candidate.id));
        const single = menu.ids.length === 1;
        const runOn = (fn: (s: WinnowStore, ids: number[]) => void) => {
          fn(store, menu.ids);
          if (!single) setSelection(EMPTY_SELECTION);
        };
        return (
          <Menu
            testId="row"
            label={single ? `Actions for ${name}: ${email.subject || "no subject"}` : `Actions for ${menu.ids.length} messages`}
            anchor={menu.anchor}
            returnFocus={menu.trigger}
            onClose={close}
            items={buildRowMenu({
              count: menu.ids.length,
              mailbox: snapshot.mailbox,
              anyUnread: targets.some((candidate) => candidate.unread),
              sender: single ? { name, address: email.sender, muted } : undefined,
              subject: single ? email.subject : undefined,
              actions: {
                reply: () => composeFor(email.id, "reply"),
                replyAll: () => composeFor(email.id, "replyAll"),
                forward: () => composeFor(email.id, "forward"),
                archive: () => runOn((s, ids) => s.archiveMany(ids)),
                trash: () => runOn((s, ids) => s.trashMany(ids)),
                setRead: (read) => {
                  if (single && !read) toggleReadFor(email.id);
                  else store.setReadMany(menu.ids, read);
                },
                move: (target) => runOn((s, ids) => s.moveMany(ids, target)),
                labelAs: () => openLabelPicker(menu.ids),
                toggleMuteSender: toggleMute,
                findFrom: showAll,
                findSubject: () => {
                  setSelection(EMPTY_SELECTION);
                  store.searchSubject(email.subject);
                },
                openInGmail: () => {
                  void platform.openExternal(
                    `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(email.gmailId)}`,
                  );
                },
              },
            })}
          />
        );
      })()}

      {composer && !docked && composerElement}

      {restoreOffer && !composer && (
        <ConfirmDialog
          title="Restore your unsent draft?"
          body={`${restoreOffer.draft.subject.trim() || "(no subject)"}${
            restoreOffer.draft.to.length > 0 ? ` — to ${restoreOffer.draft.to.join(", ")}` : ""
          }. Saved on this device ${formatRelative(restoreOffer.savedAt, Date.now())}.`}
          confirmLabel="Restore"
          destructive={false}
          onConfirm={() => restoreDraft(restoreOffer)}
          onCancel={() => setRestoreOffer(null)}
        />
      )}

      {confirmNoSubject && (
        <ConfirmDialog
          title="Send without a subject?"
          body="This message has no subject. Recipients see a blank line in their list."
          confirmLabel="Send anyway"
          destructive={false}
          onConfirm={() => {
            const recipients = confirmNoSubject;
            setConfirmNoSubject(null);
            void sendDraft(recipients, true);
          }}
          onCancel={() => setConfirmNoSubject(null)}
        />
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this draft?"
          body="What you have written will be lost, and the saved draft is deleted."
          confirmLabel="Discard"
          onConfirm={() => resolveDiscard(true)}
          onCancel={() => resolveDiscard(false)}
        />
      )}
      </div>
    </div>

    {/*
      The sidebar: an overlay on every screen, outside the app's root so that root can be
      made `inert` while it is open.
    */}
    <Sidebar
      {...navProps}
      open={sidebarOpen}
      onClose={closeSidebar}
      touch={phone}
    />
    </SenderPicturesContext.Provider>
  );
}

/** A keypress that landed in a text field, which owns its own select-all. */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

/** Select a region's text. With no region, the selection is left as it was. */
function selectRegion(scope: Element | null): void {
  const selection = document.getSelection();
  if (!selection || !scope) return;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(scope);
  selection.addRange(range);
}
