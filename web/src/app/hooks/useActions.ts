import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Snapshot, WinnowStore } from "../../core/store/store";
import { copyText } from "../../ui/clipboard";
import { anchorFromElement, type MenuAnchor } from "../../ui/menuPlacement";
import { EMPTY_SELECTION, orderedSelection, type Selection } from "../../ui/selection";
import type { SwipeAction } from "../../ui/swipe";
import type { OpenMenu, PhoneConfirmState, StepEnterState } from "../types";

type Options = {
  store: WinnowStore;
  storeRef: { current: WinnowStore };
  snapshotRef: { current: Snapshot };
  mailbox: Snapshot["mailbox"];
  phoneRef: { current: boolean };
  selectionRef: { current: Selection };
  setSelection: Dispatch<SetStateAction<Selection>>;
  setMenu: Dispatch<SetStateAction<OpenMenu | null>>;
  setPhoneConfirm: Dispatch<SetStateAction<PhoneConfirmState>>;
};

export function useActions({
  store,
  storeRef,
  snapshotRef,
  mailbox,
  phoneRef,
  selectionRef,
  setSelection,
  setMenu,
  setPhoneConfirm,
}: Options) {
  const [stepEnter, setStepEnter] = useState<StepEnterState>(null);
  const [copiedCodeId, setCopiedCodeId] = useState<number | null>(null);
  const [codeAnnouncement, setCodeAnnouncement] = useState("");
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  // Read through refs at event time so these handlers stay stable across store updates.
  const act = useCallback(
    (fn: (store: WinnowStore, snapshot: Snapshot) => void) => () =>
      fn(storeRef.current, snapshotRef.current),
    [snapshotRef, storeRef],
  );

  const stepFromPill = useCallback((step: 1 | -1) => {
    const s = storeRef.current;
    s.moveCursor(step);
    const id = s.getSnapshot().view.selected?.id;
    setStepEnter(id === undefined ? null : { id, dir: step === 1 ? "next" : "prev" });
  }, [storeRef]);

  // On phones, Back returns focus to the row covered by the reader.
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
  }, [phoneRef, snapshotRef, storeRef]);

  // Marking the open message unread moves on; on phones, focus returns to its row.
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
  }, [phoneRef, snapshotRef, storeRef]);
  const toggleReadRef = useRef(toggleReadFor);
  toggleReadRef.current = toggleReadFor;

  const guardForever = useCallback((count: number, run: () => void) => {
    if (!phoneRef.current || snapshotRef.current.mailbox !== "trash") {
      run();
      return;
    }
    const many = count > 1;
    setPhoneConfirm({
      label: many ? `Delete ${count} messages forever?` : "Delete this message forever?",
      message: many
        ? `These ${count} messages will be deleted permanently. This can't be undone.`
        : "This message will be deleted permanently. This can't be undone.",
      action: many ? `Delete ${count} Messages` : "Delete Message",
      run,
    });
  }, [phoneRef, setPhoneConfirm, snapshotRef]);

  const runBatch = useCallback((fn: (s: WinnowStore, ids: number[]) => void, keep = false) => {
    const ids = orderedSelection(
      selectionRef.current,
      snapshotRef.current.view.threads.map((row) => row.representative.id),
    );
    if (ids.length === 0) return;
    fn(storeRef.current, ids);
    if (!keep) setSelection(EMPTY_SELECTION);
  }, [selectionRef, setSelection, snapshotRef, storeRef]);

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
  }, [setMenu]);

  const openRowMenu = useCallback((id: number, anchor: MenuAnchor, trigger: HTMLElement) => {
    const batch = selectionRef.current;
    const ids =
      batch.has(id) && batch.size > 1
        ? orderedSelection(batch, snapshotRef.current.view.threads.map((row) => row.representative.id))
        : [id];
    setMenu({ kind: "row", id, ids, anchor, trigger });
  }, [selectionRef, setMenu, snapshotRef]);

  const handleSelectRow = useCallback((messageId: number) => {
    const s = storeRef.current;
    const index = snapshotRef.current.view.threads.findIndex(
      (row) => row.representative.id === messageId,
    );
    if (index < 0) return;
    s.openRow(index);
  }, [snapshotRef, storeRef]);

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
  }, [storeRef]);
  const swipeConfig = useMemo(
    () => ({ mailbox, onAction: handleSwipe }),
    [mailbox, handleSwipe],
  );

  const handleToggleStar = useCallback((messageId: number) => {
    storeRef.current.toggleStar(messageId);
  }, [storeRef]);

  return {
    act,
    stepEnter,
    stepFromPill,
    closeReader,
    toggleReadFor,
    toggleReadRef,
    guardForever,
    runBatch,
    copiedCodeId,
    codeAnnouncement,
    copyCode,
    copyCodeRef,
    openSenderMenu,
    openRowMenu,
    handleSelectRow,
    handleSwipe,
    swipeConfig,
    handleToggleStar,
  };
}
