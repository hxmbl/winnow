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
import { NO_CURSOR, WinnowStore, type Snapshot } from "./core/store/store";
import { commandForKey, shouldSwallow, type KeyContext } from "./core/mail/keybinds";
import { matchesBuiltin } from "./core/classify/filters";
import { type BuiltinSmartFilter } from "./core/model/signals";
import { MAILBOX_LABEL, type Mailbox } from "./core/model/email";
import { buildReply, stripQuote } from "./core/mail/reply";
import type { Draft } from "./core/model/email";
import { DEMO_EMAILS } from "./core/data/demo";
import { createSessionBridge, type SessionBridge } from "./core/session/bridge";
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
import { SignInScreen } from "./ui/SignInScreen";

type Props = {
  /** The one piece of global state. Everything else is derived from it. */
  store: WinnowStore;
};

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
  const [composer, setComposer] = useState<{
    draft: Draft;
    sending: boolean;
    error: string | null;
  } | null>(null);

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
   * Apply a link the user arrived on, after signing in.
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
  const applySharedLink = useCallback((link: Record<string, string> | undefined) => {
    if (!link) return;

    const mailbox = link.view as Mailbox | undefined;
    if (mailbox && Object.hasOwn(MAILBOX_LABEL, mailbox)) store.setMailbox(mailbox);

    const messageId = Number(link.message);
    if (Number.isSafeInteger(messageId) && messageId >= 0) {
      // `focusMessage` switches mailbox itself, so it goes last and wins.
      store.focusMessage(messageId);
    }
  }, [store]);


  /**
   * Start a sign-in.
   *
   * `main.tsx` owns the platform and the Gmail session, so the whole of
   * sign-in — PKCE, the loopback listener, the token exchange — happens there
   * and this component only asks. The store's `connect` is what turns a
   * signed-in account into a populated inbox, so the two steps are sequenced
   * here rather than in a layer that does not know about the UI.
   */
  const sessionRef = useRef<SessionBridge | null>(null);
  const [restoringSession, setRestoringSession] = useState(false);

  async function signIn(): Promise<void> {
    const bridge = sessionRef.current;
    if (!bridge) {
      throw new Error(
        "This build has no Google client id, so it cannot sign in. Set VITE_GMAIL_CLIENT_ID and rebuild.",
      );
    }
    const account = await bridge.signIn();
    await store.connect(bridge.backend(), { email: account.email });
  }

  /**
   * Build the session bridge and look for an existing session.
   *
   * Mounted unconditionally, in demo mode too, because the demo *is* what the
   * user sees until this resolves — and a returning user should land on their
   * mail rather than on the sample. If there is no session, nothing happens and
   * the sign-in screen stays up.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bridge = createSessionBridge(platform, store);
        if (cancelled) return;
        sessionRef.current = bridge;
        setRestoringSession(true);

        // First, in case this page load *is* the redirect back from Google. The
        // code is in the URL and the verifier is in `sessionStorage`, and both
        // are consumed on the spot — so this has to happen before `hasSession`,
        // which would otherwise report "signed out" and send the user back to
        // the sign-in screen moments after they finished signing in.
        const completed = await bridge.completeWebRedirect();
        if (cancelled) return;

        if (completed) {
          await store.connect(bridge.backend(), { email: completed.email });
          if (!cancelled) applySharedLink(completed.view);
          return;
        }

        if (await bridge.hasSession()) {
          if (cancelled) return;
          await store.connect(bridge.backend(), { email: await bridge.accountEmail() });
        }
      } catch (error) {
        if (cancelled) return;
        // A bridge that cannot be built is not a reason to hide the demo inbox —
        // the classification is the product, and it works with no account.
        store.setError(error instanceof Error ? error.message : null);
      } finally {
        if (!cancelled) setRestoringSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, applySharedLink]);

  // ── Derived view ─────────────────────────────────────────────────────────

  /** Bucket counts for the rail. Recomputed from the signals we already have. */
  const counts = useMemo(() => {
    const map = new Map<BuiltinSmartFilter, number>();
    for (const email of view.emails) {
      const signals = view.signals.get(email.id);
      if (!signals) continue;
      for (const id of view.rail) {
        if (matchesBuiltin(id, email, signals, view.profile)) {
          map.set(id, (map.get(id) ?? 0) + 1);
        }
      }
    }
    return map;
  }, [view.emails, view.signals, view.rail, view.profile]);

  const senderCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const email of view.emails) {
      map.set(email.sender, (map.get(email.sender) ?? 0) + 1);
    }
    return map;
  }, [view.emails]);

  const pills = useMemo(
    () => buildPills(view.rail, counts, view.profile.topSenders, senderCounts, snapshot.activeFilters),
    [view.rail, counts, view.profile.topSenders, senderCounts, snapshot.activeFilters],
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

  const openReply = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap.view.selected) return;
    const draft = buildReply(snap.view.selected, snap.view.conversation, {
      replyAll: true,
      selfAddress: snap.account?.email,
    });
    setComposer({ draft, sending: false, error: null });
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
   * Download one attachment.
   *
   * Three steps, in this order, and the order is the point: the bytes come from
   * Gmail, then the OS is asked where to put them. The other way round — showing
   * a save dialog for a file that then fails to download — makes the user choose
   * a location for nothing.
   *
   * The desktop shell opens a real save panel; the web build turns the same call
   * into a download. Both go through the platform, so this is one code path.
   */
  const saveAttachment = useCallback(async (attachment: { index: number }) => {
    const s = storeRef.current;
    const email = snapshotRef.current.view.selected;
    const target = email?.attachments[attachment.index];
    const bridge = sessionRef.current;
    if (!email || !target) return;

    if (!bridge) {
      // No session means no bytes. Saying so beats a button that does nothing.
      s.setError("Signing in to Gmail is required to download attachments.");
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const s = storeRef.current;
      const snap = snapshotRef.current;

      // `isContentEditable` is checked alongside the target's tag because a
      // `contenteditable` div is a text field with no `type` attribute, and
      // without this the keyboard layer would eat every key typed into a rich
      // composer.
      const target = event.target as HTMLElement | null;
      const textEditing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true ||
        composer !== null;

      const keyContext: KeyContext = {
        // Before sign-in there is nothing to route, and the composer is its own
        // modal world.
        ready: snap.status === "ready" && composer === null,
        textEditing,
        viewerOpen: snap.view.selected !== null,
        overlayVisible: snap.overlay === "shortcuts" || snap.overlay === "settings",
        navigationVisible: snap.overlay === "navigation",
        filtersActive: snap.activeFilters.length > 0,
        hasActionTarget: snap.view.selected !== null || snap.cursorIndex !== NO_CURSOR,
        railCount: snap.view.rail.length,
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
          if (selectedId !== undefined) s.archive(selectedId);
          break;
        case "trash":
          if (selectedId !== undefined) s.trash(selectedId);
          break;
        case "restore":
          if (selectedId !== undefined) s.move(selectedId, "inbox");
          break;
        case "toggleRead":
          if (selectedId !== undefined) s.toggleRead(selectedId);
          break;
        case "focusReply":
          openReply();
          break;
        case "focusSearch":
          searchRef.current?.focus();
          // `select()` as well as focus, so a second `/` re-selects an existing
          // query rather than appending to it.
          searchRef.current?.select();
          break;
        case "toggleFilter": {
          const id = snap.view.rail[command.railIndex];
          if (id) s.toggleFilter({ kind: "builtin", id });
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
        case "activateNavigation": {
          const items = ["inbox", "spam", "trash", "settings"] as const;
          const item = items[snap.navigationIndex];
          if (item === "settings") s.setOverlay("settings");
          else s.setMailbox(item);
          s.setOverlay("none");
          break;
        }
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

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [composer, openReply, saveAttachment]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (snapshot.status === "signed_out") {
    return (
      <SignInScreen
        onSignIn={signIn}
        onTryDemo={() => {
          // The demo is not a lesser path: Winnow's product *is* the
          // classification, and requiring a Google account before you can see
          // whether the sorting is any good is a product failure.
          store.replaceAll(DEMO_EMAILS);
          store.markDemoMode();
        }}
        // Still resolving whether a session exists. Bounded by the bridge
        // resolving rather than by a timer, so it cannot hang on a claim.
        restoring={restoringSession}
        hasDemo
      />
    );
  }

  if (snapshot.status === "error" && view.emails.length === 0) {
    return (
      <div className="flex h-dvh items-center justify-center bg-canvas px-6">
        <div className="max-w-[36rem] text-center">
          <h1 className="text-subject font-semibold text-ink">Could not reach Gmail</h1>
          <p className="mt-2 text-[13.5px] text-ink-muted">{snapshot.error}</p>
          <button
            type="button"
            onClick={() => store.setOverlay("none")}
            className="mt-6 rounded-full border border-control-border px-4 py-2 text-[13px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Try the demo inbox instead
          </button>
        </div>
      </div>
    );
  }

  const position = snapshot.cursorIndex === NO_CURSOR ? 0 : snapshot.cursorIndex + 1;

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
          void store.signOut();
        }}
      />

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
        The gutter is the point of this layout. Panes sit apart on a tinted
        canvas rather than sharing one seamless sheet, so each reads as its own
        object — and so that anything later lifted off a neighbour has a visible
        edge and something behind it to blur.

        Small screens keep the original full-bleed behaviour: the reader covers
        the list outright there, so there is nothing underneath to be above.
      */}
      <main className="flex min-h-0 flex-1 lg:gap-3 lg:p-3">
        <MessageList
          threads={view.threads}
          signals={view.signals}
          selectedId={snapshot.selectedId}
          cursorIndex={snapshot.cursorIndex}
          unreadIds={unreadIds}
          freshIds={snapshot.recentIds}
          emptyReason={view.result.emptyReason}
          onSelect={handleSelectRow}
          onToggleStar={handleToggleStar}
          onClearFilters={store.clearFilters.bind(store)}
          onClearSearch={() => store.setSearchQuery("")}
          now={snapshot.now}
          className="lg:rounded-pane lg:shadow-pane lg:min-w-0"
        />

        {/*
          Keyed on the message so the pane remounts per selection. That buys two
          things from one key: the reader restarts at the top of the new message,
          and `animate-appear` re-fires on every change instead of only on load —
          motion that means "this content is new" rather than "here is a page".
        */}
        <div
          key={selected?.id ?? "empty"}
          className={`${
            selected ? "flex" : "hidden"
          } fixed inset-0 z-40 lg:static lg:z-auto lg:flex lg:w-[37.9%] lg:shrink-0 lg:rounded-pane lg:shadow-pane ${
            selected ? "animate-appear" : ""
          }`}
        >
          <Reader
            email={selected}
            conversation={view.conversation}
            signals={selected ? (view.signals.get(selected.id) ?? null) : null}
            mailbox={snapshot.mailbox}
            loadRemoteContent={preferences.loadRemoteContent}
            accountAddress={snapshot.account?.email ?? null}
            onClose={store.closeReader.bind(store)}
            scrollStep={scrollStep}
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
              onShowOriginal: () => {
                // A `winnow:` deep link, so the original opens in a context the
                // message's own scripts cannot reach.
                void platform.openExternal(`https://mail.google.com/mail/u/0/#all/${selected?.gmailId ?? ""}`);
              },
              onBlockSender: act((s, snap) => {
                if (snap.view.selected) {
                  s.blockSender(snap.view.selected.sender);
                  s.closeReader();
                }
              }),
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
          loadRemoteContent={preferences.loadRemoteContent}
          onLoadRemoteContent={(loadRemoteContent) => store.setPreferences({ loadRemoteContent })}
          notificationsEnabled={preferences.notificationsEnabled}
          onNotifications={(notificationsEnabled) => {
            store.setPreferences({ notificationsEnabled });
            if (notificationsEnabled) void platform.requestNotificationPermission();
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
          events={snapshot.learning.events}
          blockedSenders={preferences.blockedSenders}
          onUnblock={store.unblockSender.bind(store)}
          isDesktop={info?.kind === "desktop"}
          onClose={() => store.setOverlay("none")}
        />
      )}

      {composer && (
        <Composer
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
                      // suffix, so a reply that never touched the original sends
                      // the user's words alone.
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
          onDiscard={() => setComposer(null)}
          onClose={() => setComposer(null)}
        />
      )}
    </div>
  );
}
