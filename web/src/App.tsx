/**
 * The application.
 *
 * This is the only file that knows about all three of: the store, the platform,
 * and React. Everything it does is wiring — the store owns the logic, the
 * platform owns the OS, and the components own the pixels.
 *
 * Three responsibilities are worth naming:
 *
 * 1. **The keyboard.** One `keydown` listener on `window`, resolved through
 *    `core/mail/keybinds.ts`. The listener is on `window` rather than on a
 *    container because a mail client is a keyboard application and focus is
 *    wherever the last click left it; a scoped listener would silently stop
 *    working the moment a sheet took focus.
 *
 * 2. **The theme.** Resolved from the preference against the OS, and applied as
 *    CSS custom properties rather than as a class on `<html>`, so switching
 *    schemes is one property sweep and not a re-render of every styled element.
 *
 * 3. **The layout.** The gutter is the point: panes sit apart on a tinted
 *    canvas rather than sharing one seamless sheet, so each reads as its own
 *    object — and so that anything later lifted off a neighbour has a visible
 *    edge and something behind it to blur. On small screens the reader covers the
 *    list outright, since there is nothing underneath to be above.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { NO_CURSOR, WinnowStore, type Snapshot } from "./core/store/store";
import { commandForKey, shouldSwallow, type KeyContext } from "./core/mail/keybinds";
import {
  badgeFilters,
  FILTER_LABELS,
  NAVIGATION_ITEMS,
} from "./core/model/signals";
import { displayName, MAILBOX_LABEL, type Mailbox } from "./core/model/email";
import { buildForward, buildReply, stripQuote } from "./core/mail/reply";
import type { Draft } from "./core/model/email";
import { DEMO_EMAILS } from "./core/data/demo";
import { createSessionBridge, type SessionBridge } from "./core/session/bridge";
import { readOwnParams } from "./core/session/redirect";
import { platform, type PlatformInfo } from "./platform";
import { useStore } from "./ui/useStore";
import { applyTheme, resolveScheme } from "./ui/theme";
import { TopBar, type MailboxTab } from "./ui/components/TopBar";
import { buildPills } from "./ui/rail";
import MessageList from "./ui/components/MessageList";
import { Reader } from "./ui/components/Reader";
import { ShortcutSheet } from "./ui/components/ShortcutSheet";
import { NavigationPalette } from "./ui/components/NavigationPalette";
import { Composer, Settings } from "./ui/components/SettingsPanel";
import { ConfirmDialog } from "./ui/components/Overlay";
import { SignInScreen } from "./ui/SignInScreen";

type Props = {
  /** The one piece of global state. Everything else is derived from it. */
  store: WinnowStore;
};

/**
 * Whether the one-time session restore has already been started.
 *
 * Module scope on purpose: it is the only lifetime that matches the constraint. A
 * `useRef` would be reset by StrictMode's teardown-and-rebuild — the very thing it
 * is meant to survive — and a `useState` would render differently on the second pass,
 * which is a StrictMode warning of its own.
 */
let sessionRestoreStarted = false;

/**
 * The composer's state, including what it is for.
 *
 * `mode` is in the title and in the body-field behaviour: a forward has no recipient
 * until the user picks one, and a reply's does. Sharing one "compose" state without
 * the mode made the two indistinguishable in the UI *and* in the Escape/discard
 * logic, which needs to know whether there is anything worth keeping.
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
 * Not "is the body empty", and not "is the body what Winnow put there" — it is
 * "is the user's *contribution* empty", and the two are different questions depending
 * on what Winnow pre-filled.
 *
 * A reply's body *starts* as the quoted original, so `stripQuote` removes the quote
 * when it is still an untouched suffix and whatever is left is what the user wrote.
 * A forward's body is the conversation, and that text is meant to stay in the message
 * they send — so its baseline is recorded in `Draft.prefilled` and the test is whether
 * the user has added to it.
 *
 * Getting this wrong is not cosmetic. It used to test the body for emptiness, so *every*
 * forward was "written": opening one with `f` and pressing Escape asked whether you
 * wanted to throw away a draft containing text Winnow had put there a second earlier,
 * and the only way to dismiss it was a second Escape — which trains people to click
 * through confirmations, and makes the ones that matter meaningless.
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
   * Held here rather than inside the top bar because `/` is routed by the
   * keyboard handler below, which lives in this component. One ref, shared by
   * both — see the note on `TopBar`'s `searchRef` prop.
   */
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollStep, setScrollStep] = useState(0);
  const [composer, setComposer] = useState<ComposerState | null>(null);

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
   * Runs whether or not there is a session: a signed-out reader gets the demo
   * mailbox, and a link into the demo is just as followable as one into a real
   * inbox. Restricting it to the signed-in path meant the link was silently dropped
   * for the one reader most likely to have been sent one.
   *
   * The order matters and is not arbitrary: the mailbox has to be set *after*
   * `connect`, because `connect` resets the view — a link that was honoured and
   * then wiped would be worse than one that was ignored. The message is opened
   * last, because focusing it can only work once the mailbox it lives in is the
   * one on screen.
   *
   * Anything unrecognised is ignored rather than passed through: a link is
   * untrusted input, and the safest reading of an unknown parameter is that it
   * is not ours.
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
  const [restoringSession, setRestoringSession] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  /** Set from the URL on mount, and applied once a session exists. */
  const launchLink = useRef<Record<string, string> | null>(null);

  /**
   * Start a sign-in.
   *
   * The bridge owns the whole flow — PKCE, the loopback listener or the page
   * redirect, the token exchange — and this only asks. The store's `connect` is
   * what turns a signed-in account into a populated inbox, so the two steps are
   * sequenced here rather than in a layer that does not know about the UI.
   *
   * On the web build this promise does not resolve: `beginSignIn` navigates away
   * and the page is torn down. The sign-in completes in `completeWebRedirect` on
   * the way back. The only way this resolves is if the navigation was blocked,
   * which surfaces as a cancellation — the honest reading.
   *
   * `signingIn` is cleared in a `finally` rather than left set, because the desktop
   * flow *does* resolve — on success, on a decline, and on a timeout — and a button
   * left spinning after any of those is a button that needs a second click to
   * recover.
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
    } finally {
      setSigningIn(false);
    }
  }, [store]);

  /**
   * Sign out for real.
   *
   * Through the bridge, not straight to `store.signOut`. The store half clears
   * the screen; the bridge half is what revokes the tokens in the OS keychain
   * and wipes the cached mail. Calling only the store left a working refresh
   * token in the keychain and the user's inbox in `localStorage` — on a shared
   * machine, that is the difference between "signed out" and "signed out, but
   * the next person can read your mail".
   *
   * The store is still cleared if the bridge half fails, because leaving a
   * populated inbox on screen after someone pressed "sign out" is worse than
   * leaving a token behind.
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
   * The same `signIn` the sign-in screen calls, plus the two things that are specific
   * to this route: the failure is rendered *beside the button* rather than in the
   * app-wide error strip (it is this button's error, not the app's), and the old
   * message is cleared on the way in so a retry does not sit under a stale failure.
   *
   * The demo is left in place until the account actually connects. If the user declines
   * at Google's consent screen, they are still looking at the mailbox they were looking
   * at, with an explanation — rather than at an empty sign-in screen.
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
   * Mounted unconditionally, in demo mode too, because the demo *is* what the user
   * sees until this resolves — and a returning user should land on their mail rather
   * than on the sample. If there is no session, nothing happens and the demo stays:
   * the top bar's "Connect Gmail" is the route into sign-in from there.
   *
   * **StrictMode runs this effect twice.** That is not a detail to shrug at: the
   * second run would call `completeWebRedirect` again, and that function *consumes*
   * the PKCE verifier from `sessionStorage` on read — so run two finds nothing, throws
   * "sign-in could not be verified", and paints an error on a sign-in that had just
   * succeeded. Worse, both runs could race `exchangeCode` on the same single-use
   * code.
   *
   * So the effect is guarded by a module-level flag rather than by `cancelled`. A
   * per-instance flag is not enough, because StrictMode tears down and rebuilds the
   * component but not the module — which is exactly the lifetime this needs.
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

        // First, in case this page load *is* the redirect back from Google. The code
        // is in the URL and the verifier is in `sessionStorage`, and both are consumed
        // on the spot — so this has to happen before `hasSession`, which would
        // otherwise report "signed out" and send the user back to the sign-in screen
        // moments after they finished signing in.
        const completed = await bridge.completeWebRedirect();
        if (completed) {
          await store.connect(bridge.backend(), { email: completed.email });
          applySharedLink(completed.view);
          return;
        }

        if (await bridge.hasSession()) {
          await store.connect(bridge.backend(), { email: await bridge.accountEmail() });
        }

        /**
         * Honoured on *both* paths, and the demo path is the one that matters.
         *
         * This used to sit inside `if (hasSession())`, which meant a shared link was
         * followed only for somebody who was already signed in — while `launchLink` was
         * read on every boot specifically to cover the person who was *not*
         * (`readOwnParams` even whitelists `view`/`message` as the app's own
         * parameters so the OAuth parser leaves them alone). So `?view=spam&message=…`
         * sent to anyone on a fresh install booted the demo inbox and silently ignored
         * the link, which is exactly the recipient a link like that is meant for. It
         * also meant the "Waiting for Google…" retry path was the only way to reach the
         * message — after a round trip to Google.
         *
         * Outside the `if` on purpose: after `connect` the mailbox must be set
         * *afterwards*, because `connect` resets the view, and the demo needs no such
         * ordering.
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
  }, [store, applySharedLink]);

  // ── Derived view ─────────────────────────────────────────────────────────

  /**
   * The rail's data, from the store's own inbox-wide counts.
   *
   * These used to be recomputed here from `view.emails`, which is the *visible*
   * list — so every pill read `0` the moment you opened Archive or the bin, and read
   * "whatever the active filter admits" the moment you turned one on. A count on a
   * pill is a claim about your mail, not about the current result set, and the rail
   * is ranked against the inbox precisely so it stays put when you change mailbox.
   *
   * The store computes both denominators now, because it is the only place that knows
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

  const mailboxes: MailboxTab[] = useMemo(
    () =>
      (["inbox", "archive", "trash", "spam"] as Mailbox[]).map((id) => ({
        id,
        label: MAILBOX_LABEL[id],
        unread: snapshot.all.filter((email) => email.mailbox === id && email.unread).length,
      })),
    [snapshot.all],
  );

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
   * A keyboard-first client moves the reader with `j` and `k`, and nothing about that
   * reaches assistive technology: focus stays wherever the last click left it, the
   * reader is a sibling of the list rather than a focused region, and a screen reader
   * user pressing `j` through a mailbox hears nothing change at all. The visible pane
   * changed; the a11y tree did not.
   *
   * An `aria-live` region is the fix, and the wording is the part that matters. It is
   * not "message 3 of 38" — the position cluster already shows that to anyone who can
   * see it — but who the message is *from* and what it is *about*, because those are
   * the two facts that let a non-sighted user decide whether to keep reading. That is
   * also why it is a summary rather than the body: announcing a whole email would
   * make `j` unusable as a scan.
   *
   * `polite`, so it queues behind whatever is being read rather than interrupting it,
   * and the badges are included because a message being Important or Unsafe is a
   * material fact about it that the list renders as colourless dots.
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
   * The handler closes over nothing, so it reads through `snapshotRef` at the
   * moment it runs. That is what lets these be stable identities — stable
   * identities matter because every one of them is passed to a `memo`'d
   * component, and a new function per render would defeat the memo entirely.
   */
  const act = useCallback(
    (fn: (store: WinnowStore, snapshot: Snapshot) => void) => () =>
      fn(storeRef.current, snapshotRef.current),
    [],
  );

  /**
   * Open a message by click.
   *
   * A click both moves the cursor and opens; `j` only moves. That difference is
   * the whole reason keyboard navigation and clicking feel like different
   * actions even though they end up selecting the same message.
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
   * Reply-all, and that is a deliberate default rather than an oversight: the reader's
   * conversation list is the thread, the person who needs to answer is usually not the
   * one who wrote last, and reply-all with a visible To field is undoable in a way that
   * reply-to-one and an accidental `f` is not. The field is editable, and
   * `buildReply`'s tests pin the exclusion of the user's own address.
   */
  const openReply = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap.view.selected) return;
    const draft = buildReply(snap.view.selected, snap.view.conversation, {
      replyAll: true,
      selfAddress: snap.account?.email,
    });
    setComposer({ draft, sending: false, error: null, mode: "reply" });
  }, []);

  /**
   * Open the composer on a forward.
   *
   * No recipient: a forward needs a decision from the user about who gets it, and
   * pre-filling one from the thread would send the whole conversation to whoever they
   * picked. The composer opens with the quoted body so there is something to read and
   * edit, and the Send button stays disabled until an address exists — which
   * `Composer` already does, and which is the only reason it is safe to leave the
   * field empty.
   */
  const openForward = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap.view.selected) return;
    const draft = buildForward(snap.view.selected, snap.view.conversation, []);
    setComposer({ draft, sending: false, error: null, mode: "forward" });
  }, []);

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
   * This is reached from three places that used to be the same thing: the Discard
   * button, the close button, and a click on the backdrop. The backdrop is the problem —
   * a click slightly outside a 640px dialog is not "I have decided to abandon this", and
   * it silently destroyed a typed reply with no confirmation and no draft kept.
   *
   * So: an untouched draft closes straight away (nothing to lose), and a written one
   * opens a real confirmation rather than calling `window.confirm`. Three reasons for
   * the in-app dialog rather than the browser's: a Tauri's webview does not reliably
   * implement `confirm`, so on the desktop the question could not be asked at all; the
   * native dialog cannot be styled and reads as a web page inside a native window; and
   * it blocks the render loop, which in a mail client is a frozen window.
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
   * The reader's "Load images" is a per-message escape hatch, and it used to be a
   * global setting change wearing a per-message label. The button read "Load images",
   * sitting under a message you were reading, and it turned on `loadRemoteContent` —
   * so every *other* message from then on rendered a 32rem iframe of sender-supplied
   * markup, and the choice persisted across a reload. Nobody clicking "Load images"
   * under one message means "show me remote content from everyone, forever".
   *
   * Scoped to one message id, and cleared when the selection moves, so the button does
   * what it says. The global preference in Settings is untouched by it and remains the
   * way to say yes to everything — which is a decision a user makes once, on purpose,
   * in a place where the scope is visible.
   */
  const [remoteFor, setRemoteFor] = useState<number | null>(null);

  // Cleared on navigation, so the hatch does not quietly follow you to the next
  // message. `selected?.id` rather than the whole snapshot so the effect only runs
  // when the message actually changes.
  useEffect(() => {
    setRemoteFor(null);
  }, [selected?.id]);

  /**
   * Download one attachment.
   *
   * Three steps, in this order, and the order is the point: the bytes come from Gmail,
   * then the OS is asked where to put them. The other way round — showing a save dialog
   * for a file that then fails to download — makes the user choose a location for
   * nothing.
   *
   * The desktop shell opens a real save panel; the web build turns the same call into a
   * download. Both go through the platform, so this is one code path.
   *
   * The guard is on `account`, not on the bridge existing. The bridge is built
   * unconditionally — including in demo mode, deliberately, so a returning user's
   * session is found without the demo having to be dismissed first — so
   * `sessionRef.current === null` was never true here and the friendly message below it
   * never fired. What *is* true in demo mode is that there is no account, and so no
   * bytes to fetch: without this check the reader called into the Gmail client with no
   * token and surfaced whatever the HTTP layer said, which is not a sentence anyone can
   * act on.
   */
  /**
   * Fetch the HTML body of the open message, if it is not already resident.
   *
   * A `useCallback` because it goes into the reader's effect dependency list: an
   * identity that changed every render would re-fire the fetch on every render, which
   * is the bug the store's in-flight map exists to prevent but only on the store's side
   * of the call.
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

    The handler is registered once and never re-registered, so it cannot close over
    render values: a closure over `composer` would be frozen at mount, and Escape would
    never see the composer at all — which is precisely the bug that made Escape unable
    to close it. Each ref is written on every render and read at keypress time, which
    is the whole trick. A stable listener, current values, no churn.

    Declared here rather than beside the state they mirror, because `pills` and the
    openers are computed below and a `useRef` initialised from a `const` that has not
    been declared yet is a temporal-dead-zone error rather than a subtle bug.
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
        A `select` is not one of `INPUT`/`TEXTAREA`/`contentEditable`, so it fell
        through as "not text editing" and the canvas handler ate its arrow keys — the
        "Check every" dropdown in settings could not be changed from the keyboard at
        all. It gets its own check.
      */
      const target = event.target as HTMLElement | null;
      const textEditing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        // `isContentEditable` is checked alongside the tag names because a
        // `contenteditable` div is a text field with no `type` attribute, and without
        // this the keyboard layer would eat every key typed into a rich composer.
        target?.isContentEditable === true;

      const keyContext: KeyContext = {
        // Before sign-in there is nothing to route. `composerOpen` is separate from
        // `ready` because the composer is a text field *and* a modal: its Escape closes
        // the sheet, where a plain field's blurs, and the two need to be
        // distinguishable for that to work.
        ready: snap.status === "ready" && open === null,
        composerOpen: open !== null,
        // `textEditing` deliberately excludes "the composer is open". It means *this
        // keypress landed in a field*; the composer's own state is `composerOpen`. With
        // the composer open and focus on its body, both are true — and the router
        // checks `composerOpen` first, so the composer's Escape wins. Before, `ready`
        // was false for the whole composer, which made *every* command return null
        // before the `textEditing` check was ever consulted.
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
        // beep. This app is keyboard-first and a beep reads as broken.
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
          // The mailbox on screen and nothing else — including not the spam folder,
          // which is the surprise this used to cause by clearing every mailbox at once.
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
          // Addressed by *pill position*, not by the store's ranked bucket list.
          // They are different sequences: the pills interleave sender pills and drop
          // the muted ones, so index `3` is a different bucket in each. Reading the
          // store's list made `4` toggle a different bucket than the pill labelled `4`.
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
          // Through the store's own handler, so the keyboard and the mouse agree. The
          // inline version duplicated it and hardcoded the palette's four items, which
          // is the way a palette row and its keyboard shortcut drift apart.
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
    // genuinely installed for the life of the app. It used to depend on `composer`,
    // which meant removing and re-adding a `window` listener on every keystroke in a
    // reply draft; that is the exact per-render listener churn the refs above exist to
    // avoid, and the file said so.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────

  /*
    Enter the demo.

    One function, three call sites: the sign-in screen's "look around" button, the
    error screen's "use the demo inbox", and nothing else. The demo is not a lesser
    path — Winnow's product *is* the classification, and requiring a Google account
    before you can see whether the sorting is any good is a product failure — but it
    is a *mode*, so it goes through `markDemoMode`, which drops the backend rather
    than just swapping the message array.
  */
  const enterDemo = useCallback(() => {
    store.replaceAll(DEMO_EMAILS);
    store.markDemoMode();
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

    Reachable, and with two real answers.

    It was unreachable: `connect`'s failure path set `status: "error"` but left `all`
    holding the demo seed, so `view.emails.length === 0` was never true and a Gmail
    failure on first run quietly showed the demo with a strip of red text. And the one
    button it had called `store.setOverlay("none")`, which changes no status and so
    re-rendered the identical screen — a button that did nothing, on a screen nobody
    could reach.

    Both fixed by the same decision: a *failed connection* shows this, and the demo is
    something you choose rather than something you are left in. The demo seed is cleared
    by `retryConnection`'s counterpart — `enterDemo` below — so the screen's own
    condition is what decides, rather than a stale mailbox.
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

  `null` before the first move, and `TopBar` renders that as an em dash. The cursor is
  `NO_CURSOR` until the user touches the keyboard, and rendering that as `0` produced
  "Inbox 0 of 38" — which reads as an empty mailbox, and "0 of 0" on a narrowed list,
  and is wrong on every count. An em dash says the honest thing: there is a list, and
  you are not on anything in it yet.
*/
const position = snapshot.cursorIndex === NO_CURSOR ? null : snapshot.cursorIndex + 1;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      <TopBar
        searchQuery={snapshot.searchQuery}
        onSearchChange={store.setSearchQuery.bind(store)}
        searchRef={searchRef}
        pills={pills}
        activeFilters={snapshot.activeFilters}
        onToggleFilter={store.toggleFilter.bind(store)}
        onMute={store.dismissFilter.bind(store)}
        onRestoreFilter={store.restoreFilter.bind(store)}
        onClearFilters={store.clearFilters.bind(store)}
        mailboxes={mailboxes}
        activeMailbox={snapshot.mailbox}
        onSelectMailbox={store.setMailbox.bind(store)}
        position={position}
        total={view.threads.length}
        listTitle={store.listTitle()}
        cursorIndex={snapshot.cursorIndex}
        onPrev={() => store.moveCursor(-1)}
        onNext={() => store.moveCursor(1)}
        onStar={act((s, snap) => {
          if (snap.view.selected) s.toggleStar(snap.view.selected.id);
        })}
        onArchive={act((s, snap) => {
          if (snap.view.selected) s.archive(snap.view.selected.id);
        })}
        onTrash={act((s, snap) => {
          if (snap.view.selected) s.trash(snap.view.selected.id);
        })}
        onRead={act((s, snap) => {
          if (snap.view.selected) s.toggleRead(snap.view.selected.id);
        })}
        onMarkAllRead={store.markAllRead.bind(store)}
        onRefresh={() => {
          void store.refresh();
        }}
        onSettings={() => store.setOverlay("settings")}
        syncing={snapshot.syncing}
        lastSyncedAt={snapshot.lastSyncedAt}
        hasSelection={selected !== null}
        accountEmail={snapshot.account?.email ?? null}
        onSignOut={() => {
          void signOut();
        }}
        onSignIn={() => {
          void connectFromDemo();
        }}
        signingIn={signingIn}
        connectError={connectError}
      />

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

        For what a sync told the user without it being a failure — a mailbox that hit
        its cap, so the view is a triage set rather than an export. It was declared on
        the store as `notice`, initialised, never set, and never rendered, and the
        message it would have carried went into `error` instead, where a permanent
        property of the account wore an alarming dismissible banner.
      */}
      {snapshot.notice && (
        <div className="flex items-center justify-between gap-3 border-b border-hairline-soft bg-[var(--wn-notice)] px-4 py-1.5 text-[12.5px] font-medium text-ink-body">
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

        `⇧U` clears the read state of a whole mailbox, and unlike every other verb in
        the app there is no inverse anywhere on screen — the messages are simply gone
        from the unread count. It used to be the single most destructive keystroke in
        the product with nothing to offer in return.

        Positioned below the notices rather than over the list: an overlay would cover
        rows the user may be reading, and this thing appears precisely when they are
        mid-triage. And it does not expire on a timer — a `⇧U` followed by a two-second
        pause and a gone toast is worse than no toast, because the user learns the
        affordance is unreliable. It waits for an explicit dismissal, a different
        action, or a navigation.
      */}
      {snapshot.undo && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 border-b border-hairline bg-chrome px-4 py-2 text-[12.5px]"
        >
          <span className="min-w-0 truncate text-ink-muted">{snapshot.undo.label}</span>
          <button
            type="button"
            onClick={store.undoLast.bind(store)}
            className="shrink-0 rounded-full border border-control-border px-2.5 py-0.5 font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={store.dismissUndo.bind(store)}
            aria-label="Dismiss"
            className="shrink-0 rounded-full p-1 text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <X size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      )}

      {/*
        The gutter is the point of this layout. Panes sit apart on a tinted
        canvas rather than sharing one seamless sheet, so each reads as its own
        object — and so that anything later lifted off a neighbour has a visible
        edge and something behind it to blur.

        Small screens keep the original full-bleed behaviour: the reader covers
        the list outright there, so there is nothing underneath to be above.
      */}
      <main className="flex min-h-0 flex-1 lg:gap-3 lg:p-3">
        {/*
          The list.

          Hidden below `lg` while a message is open. Not because there is nothing
          behind it — the reader covers this pane either way — but because a `fixed`
          overlay was the mechanism being used, and an overlay brings its own
          problems: it has to guess the header's height (it guessed 56px against a
          127px header, so the reader covered the bottom of the chrome), it has to
          out-rank the header, and its panel is `bg-panel` — an 81%-opaque glass fill
          chosen to sit on the tinted canvas, which shows the list straight through when
          it is used as an overlay.

          Hiding one and showing the other is the same behaviour with none of that: both
          are flex children of `main`, so both fill the space below the header, and the
          reader needs no positioning, no z-index and no opaque variant. At `lg` both are
          shown, because there the reader is a pane beside the list rather than a
          replacement for it.
        */}
        <div className={`${selected ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>
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
            className="lg:rounded-pane lg:shadow-pane lg:min-w-0"
          />
        </div>

        {/*
          The reader.

          Keyed on the message so the pane remounts per selection. That buys two things
          from one key: the reader restarts at the top of the new message, and
          `animate-appear` re-fires on every change instead of only on load — motion that
          means "this content is new" rather than "here is a page".

          A sibling of the list rather than an overlay on top of it, and only rendered
          when there is a message. See the note on the list for why: an overlay had to
          guess the header's height, had to out-rank the header, and used a glass panel
          fill meant for a pane resting on the canvas — which showed the list through it
          on every phone.
        */}
        <div
          key={selected?.id ?? "empty"}
          // `w-full min-w-0` below `lg`, and the width is not optional there.
          //
          // Without `min-w-0` this pane is a flex item whose base size is its
          // content — and its content is `max-w-[68ch]` of body text, 733px. On a
          // 390px phone the line overflowed, `body { overflow: hidden }` clipped it,
          // and the message was unreadable: every line ran off the right edge with no
          // way to reach the rest, and the whole action toolbar — star, archive,
          // reply, forward, trash — sat past the viewport with it. So on a phone you
          // could read half a message and could not do anything to it.
          //
          // The list pane beside it already carries `min-w-0` for the same reason,
          // which is what made the asymmetry hard to see.
          className={`${
            selected ? "flex" : "hidden lg:flex"
          } min-h-0 w-full min-w-0 flex-col lg:w-[37.9%] lg:shrink-0 lg:rounded-pane lg:shadow-pane ${
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
            loadRemoteContent={preferences.loadRemoteContent || remoteFor === selected?.id}
            accountAddress={snapshot.account?.email ?? null}
            now={snapshot.now}
            onClose={store.closeReader.bind(store)}
            scrollStep={scrollStep}
            // The HTML body is resident for a recent window and fetched for anything
            // older, so "not here yet" is the normal state for a message far enough
            // back. See `BODY_RETENTION` in the store.
            bodyPending={selected !== null && !store.hasLoadedBody(selected.id)}
            onLoadBody={loadSelectedBody}
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
          // Both hosts render a message's HTML in a `sandbox=""` iframe, which loads
          // its images and executes none of its code. There is no host here that cannot
          // do it, so this is `true` — and it is a *prop* rather than a constant in the
          // panel so that a build which genuinely could not would say so rather than
          // offering a switch that does nothing.
          canLoadRemoteContent
          loadRemoteContent={preferences.loadRemoteContent}
          onLoadRemoteContent={(loadRemoteContent) => store.setPreferences({ loadRemoteContent })}
          notificationsEnabled={preferences.notificationsEnabled}
          onNotifications={(notificationsEnabled) => {
            store.setPreferences({ notificationsEnabled });
            if (!notificationsEnabled) return;
            /*
              Ask, and *believe the answer*.

              The permission request's result used to be discarded — `void` — so a user
              who turned notifications on and then declined the OS prompt kept a toggle
              reading "on" and no notifications, with nothing to say why. Turning it back
              off is the honest response to a refusal: the preference and the permission
              are the same thing, and the preference is the one the user can see.
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
