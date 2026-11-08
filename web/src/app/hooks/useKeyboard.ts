import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { commandForKey, shouldSwallow, type KeyContext } from "../../core/mail/keybinds";
import { NAVIGATION_ITEMS } from "../../core/model/signals";
import { NO_CURSOR, type Snapshot, type WinnowStore } from "../../core/store/store";
import { exitRows } from "../../ui/rowExit";
import { isEditingElement } from "../../ui/sidebarOverlay";
import { scrollListToTop } from "../../ui/listScroll";
import { isSelectAll, selectAllScope } from "../../ui/textSelection";
import { canSnooze } from "../../ui/menus";
import { onReplyRequest } from "../../ui/notificationActions";
import type { PillItem } from "../../ui/rail";
import { EMPTY_SELECTION, orderedSelection, type Selection } from "../../ui/selection";
import { logoViewAfter, type LogoView } from "../../ui/logoVersion";

type Mutable<T> = { current: T };

type KeyboardContext = {
  storeRef: Mutable<WinnowStore>;
  snapshotRef: Mutable<Snapshot>;
  composerRef: Mutable<unknown | null>;
  pills: readonly PillItem[];
  selectionRef: Mutable<Selection>;
  menuRef: Mutable<unknown | null>;
  scheduleModalRef: Mutable<boolean>;
  sidebarOpenRef: Mutable<boolean>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setSelection: Dispatch<SetStateAction<Selection>>;
  openReply: () => void;
  openForward: () => void;
  openCompose: () => void;
  closeComposer: () => void;
  searchRef: Mutable<HTMLInputElement | null>;
  setScrollStep: Dispatch<SetStateAction<number>>;
  phoneRef: Mutable<boolean>;
  dockedRef: Mutable<boolean>;
  openSnoozeMenuRef: Mutable<(ids: readonly number[], trigger: HTMLElement | null) => void>;
  toggleReadRef: Mutable<(id: number) => void>;
  copyCodeRef: Mutable<(id: number) => void>;
  setLogoView: Dispatch<SetStateAction<LogoView>>;
};

export function useKeyboard(context: KeyboardContext): void {
  const {
    storeRef, snapshotRef, composerRef, pills, selectionRef, menuRef, scheduleModalRef,
    sidebarOpenRef, setSidebarOpen, setSelection, openReply, openForward, openCompose,
    closeComposer, searchRef, setScrollStep, phoneRef, dockedRef, openSnoozeMenuRef,
    toggleReadRef, copyCodeRef, setLogoView,
  } = context;

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
  // A notification's Reply on the desktop: the message is already open, so the composer
  // opens on it exactly as R would (`ui/notificationActions.ts`).
  useEffect(() => onReplyRequest(() => openReplyRef.current()), []);
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

      // An open menu owns the keyboard; its own handler has already acted. So do the
      // snooze menu, the date and time picker and an opened scheduled send.
      if (menuRef.current || scheduleModalRef.current) return;

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
        // `[` closes it as it opened it, unless someone is typing in the sidebar.
        const sidebarToggleKey =
          (event.key === "[" || event.code === "BracketLeft") && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey &&
          !isEditingElement(event.target instanceof Element ? event.target : null);
        if (event.key === "Escape" || sidebarToggleKey) {
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
        overlayVisible: snap.overlay === "shortcuts" || snap.overlay === "settings" || snap.overlay === "accounts",
        navigationVisible: snap.overlay === "navigation",
        filtersActive: snap.activeFilters.length > 0,
        searchActive: snap.searchQuery.trim().length > 0,
        searchEditing: target !== null && target === searchRef.current,
        hasActionTarget:
          snap.view.selected !== null || snap.cursorIndex !== NO_CURSOR || batch.size > 0,
        // The rail as the *pills* see it, not the store's ranked bucket list: sender
        // pills take digits too. Counting the store's list would make `7` address a pill
        // that is not there.
        railCount: rail.length,
        undoAvailable: snap.undo !== null,
      };

      const command = commandForKey(event.key, keyContext, {
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        code: event.code,
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
      if (batch.size > 0 && command.type === "snooze") {
        if (canSnooze(snap.mailbox)) {
          const bar = document.querySelector<HTMLElement>("[data-selection-snooze]");
          openSnoozeMenuRef.current(orderedSelection(batch, snap.view.threads.map((row) => row.representative.id)), bar);
        }
        return;
      }
      if (batch.size > 0 && (command.type === "archive" || command.type === "trash" || command.type === "toggleRead")) {
        const ids = orderedSelection(batch, snap.view.threads.map((row) => row.representative.id));
        if (command.type === "archive") s.archiveWithUndo(ids);
        else if (command.type === "trash") s.trashWithUndo(ids);
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
        case "listTop":
          scrollListToTop();
          break;
        case "selectFirst":
          if (snap.view.threads.length > 0) {
            s.moveCursor(snap.cursorIndex === NO_CURSOR ? snap.view.threads.length : -snap.view.threads.length);
          }
          break;
        case "selectLast":
          if (snap.view.threads.length > 0) {
            s.moveCursor(snap.cursorIndex === NO_CURSOR ? -snap.view.threads.length : snap.view.threads.length);
          }
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
          if (selectedId !== undefined) exitRows([selectedId], () => s.archiveWithUndo([selectedId]));
          break;
        case "trash":
          if (selectedId !== undefined) exitRows([selectedId], () => s.trashWithUndo([selectedId]));
          break;
        case "snooze":
          // Gmail's `b`: the open message's snooze choices, beside the reader's button.
          if (selectedId !== undefined && canSnooze(snap.mailbox)) {
            const button = document.querySelector<HTMLElement>(
              '[data-reader-action="snooze"], [data-reader-pill-snooze]',
            );
            openSnoozeMenuRef.current([selectedId], button);
          }
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
          // Search first, synchronously, if the logo had swapped it for the version: a
          // hidden field cannot take focus.
          flushSync(() => setLogoView((view) => logoViewAfter(view, "focusSearch")));
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
        case "clearSearch":
          s.setSearchQuery("");
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
        case "toggleSidebar":
          setSidebarOpen((open) => !open);
          break;
        case "undo":
          // The pill's newest offer, exactly as its Undo button takes it.
          s.undoLast();
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
    // All render values above are refs updated on every render; this listener is intentionally stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

function selectRegion(scope: Element | null): void {
  const selection = document.getSelection();
  if (!selection || !scope) return;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(scope);
  selection.addRange(range);
}
