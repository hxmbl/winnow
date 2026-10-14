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
import { NO_CURSOR, WinnowStore, MAILBOX_ORDER, type Snapshot } from "./core/store/store";
import { commandForKey, shouldSwallow, type KeyContext } from "./core/mail/keybinds";
import {
  badgeFilters,
  FILTER_LABELS,
  NAVIGATION_ITEMS,
} from "./core/model/signals";
import { displayName, MAILBOX_LABEL, type Mailbox } from "./core/model/email";
import { buildForward, buildReply, stripQuote } from "./core/mail/reply";
import { formatRelative } from "./core/mail/datetime";
import { resolveImageConsent } from "./core/mail/imageConsent";
import type { Draft } from "./core/model/email";
import { demoMailbox } from "./core/data/demo";
import { createSessionBridge, type SessionBridge } from "./core/session/bridge";
import { readOwnParams } from "./core/session/redirect";
import { platform, type PlatformInfo } from "./platform";
import { useStore } from "./ui/useStore";
import { applyTheme, resolveScheme } from "./ui/theme";
import { Masthead } from "./ui/components/Masthead";
import { PhoneDock, PhoneTopBar } from "./ui/components/PhoneChrome";
import { useKeyboardInset, usePhoneLayout } from "./ui/usePhoneLayout";
import { NavDrawer } from "./ui/components/NavDrawer";
import { buildPills } from "./ui/rail";
import MessageList from "./ui/components/MessageList";
import { Reader } from "./ui/components/Reader";
import { ShortcutSheet } from "./ui/components/ShortcutSheet";
import { NavigationPalette } from "./ui/components/NavigationPalette";
import { Composer, Settings } from "./ui/components/SettingsPanel";
import { ConfirmDialog } from "./ui/components/Overlay";
import { ErrorText } from "./ui/components/ErrorText";
import { SignInScreen } from "./ui/SignInScreen";

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
  mode: "reply" | "forward";
};

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
function isUntouchedDraft(draft: Draft): boolean {
  const written = stripQuote(draft.body, draft.quoteBlock).trim();
  return written === (draft.prefilled ?? "").trim();
}

export function App({ store }: Props) {
  const snapshot = useStore(store);
  const { view, preferences } = snapshot;

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

  /**
   * The phone arrangement: a top bar and a bottom dock instead of the masthead, and the
   * reader's actions at the bottom edge. Same store, same handlers, same components —
   * only where they sit changes. See `usePhoneLayout`.
   */
  const phone = usePhoneLayout();
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

  useEffect(() => {
    applyTheme(document.documentElement, resolveScheme(preferences.appearance, systemDark));
  }, [preferences.appearance, systemDark]);

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
  const syncGoogleContacts = useCallback(async (force = false): Promise<void> => {
    const bridge = sessionRef.current;
    if (!bridge || !store.getSnapshot().account) return;
    try {
      const access = await bridge.contactsAccess();
      if (access !== "granted") {
        store.setGoogleContacts([], access);
        return;
      }
      store.setGoogleContacts(await bridge.cachedContacts(), "granted");
      const last = await bridge.contactsSyncedAt();
      if (!force && last !== null && Date.now() - last < CONTACTS_REFRESH_MS) return;
      const fresh = await bridge.refreshContacts();
      if (fresh) store.setGoogleContacts(fresh, "granted");
      else store.setGoogleContacts([], await bridge.contactsAccess());
    } catch (error) {
      console.warn("winnow: could not refresh Google contacts:", error);
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
  const improveSuggestions = useCallback(async (): Promise<void> => {
    const bridge = sessionRef.current;
    if (!bridge) return;
    setContactsError(null);
    setContactsBusy(true);
    try {
      const access = await bridge.grantContacts();
      if (access === "granted") await syncGoogleContacts(true);
      else {
        store.setGoogleContacts([], access);
        setContactsError(HALF_GRANT_MESSAGE);
      }
    } catch (error) {
      setContactsError(error instanceof Error ? error.message : "Google contacts were not connected.");
    } finally {
      setContactsBusy(false);
    }
  }, [store, syncGoogleContacts]);
  const onImproveSuggestions = useCallback(() => void improveSuggestions(), [improveSuggestions]);

  const [restoringSession, setRestoringSession] = useState(false);
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
  const signIn = useCallback(async (): Promise<void> => {
    const bridge = sessionRef.current;
    if (!bridge) {
      throw new Error(
        "This build has no Google client id, so it cannot sign in. Set VITE_GMAIL_CLIENT_ID and rebuild.",
      );
    }
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
   * Sign out for real.
   *
   * Through the bridge, not straight to `store.signOut`: the store half clears the
   * screen, but the bridge half is what revokes the tokens in the OS keychain and wipes
   * the cached mail. Calling only the store left a working refresh token behind — on a
   * shared machine, "signed out, but the next person can read your mail".
   *
   * The store is still cleared if the bridge half fails: leaving a populated inbox on
   * screen after someone pressed "sign out" is worse than leaving a token behind.
   */
  const signOut = useCallback(async () => {
    const bridge = sessionRef.current;
    try {
      if (bridge) {
        await bridge.signOut();
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
  }, [store]);

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
          void syncGoogleContacts(completed.contacts === "granted");
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
        snapshot.mutedFilters,
      ),
    [view.rail, view.inboxCounts, view.profile.topSenders, view.inboxSenderCounts, snapshot.activeFilters, snapshot.mutedFilters],
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
   * Whether the navigation drawer is open.
   *
   * Local state rather than a store `overlay`, because the drawer is not one of the three
   * things the keyboard router dismisses and must not inherit their `Escape` handling:
   * the `Sheet` inside it handles its own, and two Escape handlers on one keypress is how
   * a sheet closes the reader *and* itself.
   */
  const [drawerOpen, setDrawerOpen] = useState(false);

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
  const handleSelectRow = useCallback((messageId: number) => {
    const s = storeRef.current;
    const index = snapshotRef.current.view.threads.findIndex(
      (row) => row.representative.id === messageId,
    );
    if (index < 0) return;
    s.openRow(index);
  }, []);

  const handleToggleStar = useCallback((messageId: number) => {
    storeRef.current.toggleStar(messageId);
  }, []);

  /**
   * Open the composer on a reply.
   *
   * Reply-all by default: the person who needs to answer is usually not the one who wrote
   * last, and reply-all with a visible, editable To field is undoable in a way
   * reply-to-one is not. `buildReply`'s tests pin the exclusion of the user's own address.
   */
  const openReply = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap.view.selected) return;
    const draft = buildReply(snap.view.selected, snap.view.conversation, {
      replyAll: true,
      selfAddress: snap.account?.email,
    });
    setComposer({ draft, sending: false, error: null, mode: "reply" });
    void syncGoogleContacts();
  }, [syncGoogleContacts]);

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
    if (!snap.view.selected) return;
    const draft = buildForward(snap.view.selected, snap.view.conversation, []);
    setComposer({ draft, sending: false, error: null, mode: "forward" });
    void syncGoogleContacts();
  }, [syncGoogleContacts]);

  const sendReply = useCallback(async () => {
    if (!composer) return;
    const snap = snapshotRef.current;
    if (!snap.view.selected) return;
    setComposer({ ...composer, sending: true, error: null });
    try {
      await storeRef.current.sendReply(composer.draft, snap.view.selected.gmailId);
      setComposer(null);
    } catch (error) {
      setComposer({
        ...composer,
        sending: false,
        error: error instanceof Error ? error.message : "The reply could not be sent.",
      });
    }
  }, [composer]);

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
    setComposer((current) => {
      if (!current) return null;
      if (force || isUntouchedDraft(current.draft)) return null;
      // There is something to lose: ask, and leave the composer exactly as it is
      // — including focus — if the answer is no.
      setConfirmDiscard(true);
      return current;
    });
  }, []);

  /** Both buttons of the confirmation, in one place so neither can miss. */
  const resolveDiscard = useCallback((discard: boolean) => {
    setConfirmDiscard(false);
    if (discard) setComposer(null);
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
        error instanceof Error ? error.message : "That attachment could not be downloaded.",
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
  const composerRef = useRef<ComposerState | null>(null);
  composerRef.current = composer;
  const pillsRef = useRef(pills);
  pillsRef.current = pills;
  const openReplyRef = useRef(openReply);
  openReplyRef.current = openReply;
  const openForwardRef = useRef(openForward);
  openForwardRef.current = openForward;
  const closeComposerRef = useRef(closeComposer);
  closeComposerRef.current = closeComposer;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const s = storeRef.current;
      const snap = snapshotRef.current;
      const open = composerRef.current;
      const rail = pillsRef.current;

      /*
        A `select` is not one of `INPUT`/`TEXTAREA`/`contentEditable`, so it falls through
        as "not text editing" and the canvas handler eats its arrow keys. It gets its own
        check.
      */
      const target = event.target as HTMLElement | null;
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
        ready: snap.status === "ready" && open === null,
        composerOpen: open !== null,
        // `textEditing` deliberately excludes "the composer is open": it means *this
        // keypress landed in a field*, while the composer's own state is `composerOpen`.
        // With the composer open and focus on its body, both are true — and the router
        // checks `composerOpen` first, so the composer's Escape wins.
        textEditing,
        viewerOpen: snap.view.selected !== null,
        overlayVisible: snap.overlay === "shortcuts" || snap.overlay === "settings",
        navigationVisible: snap.overlay === "navigation",
        filtersActive: snap.activeFilters.length > 0,
        hasActionTarget: snap.view.selected !== null || snap.cursorIndex !== NO_CURSOR,
        // The rail as the *pills* see it, not the store's ranked bucket list: sender
        // pills take digits too, and the muted pills at the end do not. Counting the
        // store's list would make `7` address a pill that is not there.
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
          s.closeReader();
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
          if (selectedId !== undefined) s.toggleRead(selectedId);
          break;
        case "markAllRead":
          // The mailbox on screen and nothing else — including not the spam folder.
          s.markAllRead();
          break;
        case "focusReply":
          openReplyRef.current();
          break;
        case "forward":
          openForwardRef.current();
          break;
        case "focusSearch":
          searchRef.current?.focus();
          // `select()` as well as focus, so a second `/` re-selects an existing
          // query rather than appending to it.
          searchRef.current?.select();
          break;
        case "toggleFilter": {
          // Addressed by *pill position*, not by the store's ranked bucket list: the pills
          // interleave sender pills and drop the muted ones, so index `3` is a different
          // bucket in each.
          const pill = rail[command.railIndex];
          // A muted pill has no toggle — it is drawn disabled, and the store refuses a
          // muted bucket anyway. The check keeps the two from disagreeing.
          if (pill && !pill.muted) s.toggleFilter(pill.id);
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
    store.markDemoMode(demo.now);
  }, [store]);

  if (snapshot.status === "signed_out") {
    return (
      <SignInScreen
        onSignIn={signIn}
        onTryDemo={enterDemo}
        // Still resolving whether a session exists. Bounded by the bridge resolving
        // rather than by a timer, so it cannot hang on a claim.
        restoring={restoringSession}
        hasDemo
      />
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
        <div className="max-w-[36rem] text-center">
          <h1 className="text-subject font-semibold text-ink">Could not reach Gmail</h1>
          <p className="mt-2 text-[13.5px] text-ink-muted">{snapshot.error}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                void store.retryConnection();
              }}
              className="rounded-full bg-[var(--wn-inkBody)] px-4 py-2 text-[13px] font-semibold text-[var(--wn-surface)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={enterDemo}
              className="rounded-full border border-control-border px-4 py-2 text-[13px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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

  `null` before the first move, rendered as an em dash. The cursor is `NO_CURSOR` until the
  user touches the keyboard, and rendering that as `0` produced "Inbox 0 of 38" — which
  reads as an empty mailbox and is wrong on every count. The em dash says the honest thing:
  there is a list, and you are not on anything in it yet.
*/
const position = snapshot.cursorIndex === NO_CURSOR ? null : snapshot.cursorIndex + 1;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      {/*
        The masthead: logo, smart filters, search and where-you-are, on one surface. The
        mailbox menu is what the logo opens; the email actions live in the reader, where
        the open message is.
      */}
      {phone ? (
        // On a phone the reader takes the whole screen, its own way back included, so
        // the list's bar steps aside while a message is open.
        !selected && (
          <PhoneTopBar
            searchQuery={snapshot.searchQuery}
            onSearchChange={store.setSearchQuery.bind(store)}
            searchRef={searchRef}
            accountEmail={snapshot.account?.email ?? null}
            onOpenNavigation={() => setDrawerOpen(true)}
            navigationOpen={drawerOpen}
            listTitle={store.listTitle()}
            position={position}
            total={view.threads.length}
            cursorIndex={snapshot.cursorIndex}
            onPrev={() => store.moveCursor(-1)}
            onNext={() => store.moveCursor(1)}
            onMarkAllRead={store.markAllRead.bind(store)}
          />
        )
      ) : (
      <Masthead
        searchQuery={snapshot.searchQuery}
        onSearchChange={store.setSearchQuery.bind(store)}
        searchRef={searchRef}
        pills={pills}
        activeFilters={snapshot.activeFilters}
        onToggleFilter={store.toggleFilter.bind(store)}
        onMute={store.dismissFilter.bind(store)}
        onRestoreFilter={store.restoreFilter.bind(store)}
        onClearFilters={store.clearFilters.bind(store)}
        onOpenNavigation={() => setDrawerOpen(true)}
        navigationOpen={drawerOpen}
        position={position}
        total={view.threads.length}
        listTitle={store.listTitle()}
        cursorIndex={snapshot.cursorIndex}
        onPrev={() => store.moveCursor(-1)}
        onNext={() => store.moveCursor(1)}
        onMarkAllRead={store.markAllRead.bind(store)}
      />
      )}

      {announcement && (
        <p aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </p>
      )}

      {snapshot.error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-hairline bg-danger-wash px-4 py-1.5 text-[12.5px] font-medium text-ink-body"
        >
          <span className="min-w-0 truncate">{snapshot.error}</span>
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
        <div className="flex items-center justify-between gap-3 border-b border-hairline-soft bg-notice px-4 py-1.5 text-[12.5px] font-medium text-ink-body">
          <span className="min-w-0 truncate">{snapshot.notice}</span>
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
        The undo strip.

        `⇧U` clears the read state of a whole mailbox, and unlike every other verb there is
        no inverse on screen — the messages are simply gone from the unread count.

        Positioned below the notices rather than over the list, since it appears precisely
        when the user is mid-triage. It does not expire on a timer — a `⇧U`, a two-second
        pause, and a gone toast is worse than no toast, because the user learns the
        affordance is unreliable — but waits for an explicit dismissal, a different action,
        or a navigation.
      */}
      {snapshot.undo && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 px-4 py-1.5 text-[12.5px]"
        >
          <span className="min-w-0 truncate text-ink-muted">{snapshot.undo.label}</span>
          <button
            type="button"
            onClick={store.undoLast.bind(store)}
            className="shrink-0 rounded-full bg-sheen px-2.5 py-0.5 font-medium text-ink-body transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={store.dismissUndo.bind(store)}
            aria-label="Dismiss"
            className="shrink-0 rounded-full p-1 text-ink-subtle transition-colors hover:bg-sheen hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
      <main className="flex min-h-0 flex-1">
        {/*
          The list.

          Hidden below `lg` while a message is open, with the reader shown instead: both
          are flex children of `main`, so both fill the space below the header, and the
          reader needs no positioning, no z-index and no opaque variant. At `lg` both show,
          because there the reader is a pane beside the list rather than a replacement.
        */}
        <div
          className={`${
            selected ? "hidden lg:flex" : "flex"
          } min-h-0 min-w-0 flex-1 flex-col bg-surface`}
        >
          {/*
            The mailbox's own status line, and the demo note.

            Both are about the mail, not the app: the demo note describes what you are
            looking at, and the sync line when it last arrived. The demo's route to a real
            account is a button here rather than in a settings panel, because the app boots
            into the demo and never shows the sign-in screen on first run.
          */}
          {snapshot.account === null ? (
            <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-1">
              <p className="min-w-0 truncate text-[11.5px] text-ink-subtle">
                Demo mailbox — nothing leaves this device
              </p>
              <button
                type="button"
                onClick={() => {
                  void connectFromDemo();
                }}
                disabled={signingIn}
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-sheen px-2.5 py-1 text-[11.5px] font-medium text-ink-body transition-colors hover:text-ink disabled:opacity-50 max-sm:min-h-9 max-sm:px-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <LogIn size={11} strokeWidth={2.2} aria-hidden="true" />
                {signingIn ? "Waiting for Google…" : "Connect Gmail"}
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-1">
              <p className="min-w-0 truncate text-[11.5px] text-ink-subtle">
                {snapshot.lastSyncedAt
                  ? `Synced ${formatRelative(snapshot.lastSyncedAt, Date.now())}`
                  : "Not synced yet"}
              </p>
              <button
                type="button"
                onClick={() => {
                  void store.refresh();
                }}
                disabled={snapshot.syncing}
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-sheen px-2.5 py-1 text-[11.5px] font-medium text-ink-body transition-colors hover:text-ink disabled:opacity-50 max-sm:min-h-9 max-sm:px-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <RefreshCw
                  size={11}
                  strokeWidth={2.2}
                  className={snapshot.syncing ? "animate-spin" : ""}
                  aria-hidden="true"
                />
                {snapshot.syncing ? "Syncing…" : "Sync now"}
              </button>
            </div>
          )}
          {connectError && (
            <div role="alert" className="px-4 pb-2 text-[11.5px] font-medium text-danger">
              <ErrorText text={connectError} />
            </div>
          )}
          <MessageList
            threads={view.threads}
            signals={view.signals}
            selectedId={snapshot.selectedId}
            cursorIndex={snapshot.cursorIndex}
            unreadIds={unreadIds}
            freshIds={snapshot.recentIds}
            emptyReason={view.result.emptyReason}
            sortBy={preferences.sortBy}
            onSelect={handleSelectRow}
            onToggleStar={handleToggleStar}
            onClearFilters={store.clearFilters.bind(store)}
            onClearSearch={() => store.setSearchQuery("")}
            onSync={() => {
              void store.refresh();
            }}
            // Only a real account has something to sync with. Offering the button
            // over the demo would be a control that cannot do anything, which is the
            // exact failure the empty state's own copy was written to avoid.
            canSync={snapshot.account !== null}
            now={snapshot.now}
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
        <div
          key={selected?.id ?? "empty"}
          // `w-full min-w-0` below `lg`, and the width is not optional there.
          //
          // Without `min-w-0` this pane is a flex item whose base size is its content —
          // `max-w-[68ch]` of body text, 733px — which overflows a 390px phone and gets
          // clipped by `body { overflow: hidden }`, leaving the message unreadable and the
          // action toolbar past the viewport. The list pane beside it already carries
          // `min-w-0` for the same reason.
          className={`${
            selected ? "flex" : "hidden lg:flex"
          } min-h-0 w-full min-w-0 flex-col bg-surface-sunken lg:w-[38%] lg:shrink-0 ${
            selected ? "animate-appear" : ""
          }`}
        >
          <Reader
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
            onClose={store.closeReader.bind(store)}
            scrollStep={scrollStep}
            // The HTML body is resident for a recent window and fetched for anything
            // older, so "not here yet" is the normal state for a message far enough
            // back. See `BODY_RETENTION` in the store.
            bodyPending={selected !== null && !store.hasLoadedBody(selected.id)}
            onLoadBody={loadSelectedBody}
            phone={phone}
            actions={{
              onStar: act((s, snap) => {
                if (snap.view.selected) s.toggleStar(snap.view.selected.id);
              }),
              onRead: act((s, snap) => {
                if (snap.view.selected) s.toggleRead(snap.view.selected.id);
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
                  s.closeReader();
                }
              }),
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
        </div>
      </main>

      {/*
        The phone's dock: streams and smart filters above the four tabs, on one surface at
        the bottom edge. Not while reading — the reader brings its own action bar.
      */}
      {phone && !selected && (
        <PhoneDock
          pills={pills}
          activeFilters={snapshot.activeFilters}
          onToggleFilter={store.toggleFilter.bind(store)}
          onMute={store.dismissFilter.bind(store)}
          onRestoreFilter={store.restoreFilter.bind(store)}
          onClearFilters={store.clearFilters.bind(store)}
          mailbox={snapshot.mailbox}
          unread={paletteUnread}
          onSelectMailbox={(mailbox) => {
            store.setOverlay("none");
            store.setMailbox(mailbox);
          }}
          settingsOpen={snapshot.overlay === "settings"}
          onOpenSettings={() => store.setOverlay("settings")}
        />
      )}

      {snapshot.overlay === "shortcuts" && (
        <ShortcutSheet onClose={() => store.setOverlay("none")} />
      )}

      {drawerOpen && (
        <NavDrawer
          mailboxes={mailboxes}
          activeMailbox={snapshot.mailbox}
          onSelectMailbox={store.setMailbox.bind(store)}
          accountEmail={snapshot.account?.email ?? null}
          onSignOut={() => {
            void signOut();
          }}
          onSignIn={() => {
            void connectFromDemo();
          }}
          signingIn={signingIn}
          syncing={snapshot.syncing}
          onRefresh={() => {
            void store.refresh();
          }}
          onSettings={() => {
            setDrawerOpen(false);
            store.setOverlay("settings");
          }}
          onClose={() => setDrawerOpen(false)}
        />
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
          // Both hosts render a message's HTML in a `sandbox=""` iframe, which loads its
          // images and executes none of its code. A *prop* rather than a constant so a
          // build that genuinely could not would say so rather than offering a switch that
          // does nothing.
          canLoadRemoteContent
          imagePolicy={preferences.imagePolicy}
          onImagePolicy={(imagePolicy) => store.setPreferences({ imagePolicy })}
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
          weights={snapshot.learning.weights}
          onWeight={store.setSignalWeight.bind(store)}
          adaptive={snapshot.learning.adaptive}
          onAdaptive={store.setAdaptiveLearning.bind(store)}
          onResetWeights={store.resetLearning.bind(store)}
          events={snapshot.learning.history}
          blockedSenders={preferences.blockedSenders}
          onUnblock={store.unblockSender.bind(store)}
          mutedFilters={snapshot.mutedFilters}
          onRestoreFilter={store.restoreFilter.bind(store)}
          isDesktop={info?.kind === "desktop"}
          contactsAccess={snapshot.contactsAccess}
          contactsBusy={contactsBusy}
          contactsError={contactsError}
          onImproveSuggestions={onImproveSuggestions}
          onClose={() => store.setOverlay("none")}
        />
      )}

      {composer && (
        <Composer
          mode={composer.mode}
          to={composer.draft.to}
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
                      body: patch.body
                        ? stripQuote(patch.body, current.draft.quoteBlock)
                        : current.draft.body,
                    },
                  }
                : current,
            )
          }
          phone={phone}
          onSend={() => {
            void sendReply();
          }}
          // Discard is the button that already says the word, so it does not ask.
          onDiscard={() => closeComposer(true)}
          // Escape and the close button ask if there is anything to lose.
          onClose={() => closeComposer()}
        />
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this draft?"
          body="What you have written will be lost, and nothing is kept."
          confirmLabel="Discard"
          onConfirm={() => resolveDiscard(true)}
          onCancel={() => resolveDiscard(false)}
        />
      )}
    </div>
  );
}
