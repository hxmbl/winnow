/** Undo offers, optimistic rollback and message actions that present Undo. */
import { MAILBOX_LABEL, type Mailbox } from "../../model/email";
import { DRAFT_DISCARD_UNDO_MS, UNDO_OFFER_MS } from "../state";
import type { UndoEntry, WinnowStore } from "../store";

/**
 * What the pill says after a move that can be undone, in the swipe's words: "Moved to
 * Trash." / "Archived." for one message, "Moved 5 to Trash." / "Archived 5." for a
 * batch, and "Moved 5." when a batch went to more than one place.
 */
export function undoLabel(destinations: readonly Mailbox[]): string {
  const count = destinations.length;
  const first = destinations[0];
  const same = destinations.every((to) => to === first);
  if (!same) return `Moved ${count}.`;
  if (first === "archive") return count === 1 ? "Archived." : `Archived ${count}.`;
  return count === 1 ? `Moved to ${MAILBOX_LABEL[first]}.` : `Moved ${count} to ${MAILBOX_LABEL[first]}.`;
}

  /**
   * Take back the offered action, keeping both directions so it can be put back.
   * `z`, Ctrl+Z, ⌘Z and the pill's Undo all come through here.
   */
  export function undoLast(store: WinnowStore): void {
    const action = store.undoAction;
    if (!action) return;
    const label = store.state.undo?.label ?? "Action.";
    const entry: UndoEntry = {
      label,
      undo: action,
      redo: store.undoRedo ?? undefined,
      commit: store.undoCommit ?? undefined,
      commitAfterMs: store.undoCommitAfterMs,
    };
    dropUndo(store);
    store.set({ undo: null, redo: entry.redo ? { label, at: Date.now() } : null });
    action();
    store.redoEntry = entry.redo ? entry : null;
  }

  /** Put back the action just undone, and offer its Undo again for the other direction. */
  export function redoLast(store: WinnowStore): void {
    const entry = store.redoEntry;
    if (!entry?.redo) return;
    const redo = entry.redo;
    dropUndo(store);
    store.set({ undo: null, redo: null });
    redo();
    // The offer is the same action again: its Undo now takes back this redo, and its
    // redo puts it back once more, so `u` and `⇧U` can be pressed in either order.
    offerUndo(store, entry.label, entry.undo, {
      redo,
      commit: entry.commit,
      commitAfterMs: entry.commitAfterMs,
    });
  }

  /**
   * Offer one undo, letting the previous offer go (and running its commit). `commit`
   * runs when this offer is let go, and at the latest after `commitAfterMs`. `redo`
   * puts the action back after `undoLast`, and a new offer clears it: only the last
   * action is ever reversible.
   */
  /** @internal Shared with undo and snooze feature modules. */
  export function offerUndo(store: WinnowStore,
    label: string,
    action: () => void,
    {
      redo,
      commit,
      commitAfterMs,
    }: { redo?: () => void; commit?: () => void; commitAfterMs?: number } = {},
  ): void {
    settleUndo(store);
    store.undoAction = action;
    store.undoRedo = redo ?? null;
    store.undoCommit = commit ?? null;
    store.undoCommitAfterMs = commitAfterMs;
    // Every offer goes by itself after `UNDO_OFFER_MS` (sooner when its commit window
    // is shorter); before, an offer with no commit stayed on the pill until dismissed.
    const expiresAfterMs = commit && commitAfterMs !== undefined ? Math.min(commitAfterMs, UNDO_OFFER_MS) : UNDO_OFFER_MS;
    store.undoCommitTimer = setTimeout(() => {
      if (store.undoAction !== action) return;
      settleUndo(store);
      store.set({ undo: null, redo: null });
    }, expiresAfterMs);
    store.set({ undo: { label, at: Date.now() }, redo: null });
  }

  /** Let the offered undo go: its commit (if any) runs. The strip is the caller's. */
  export function settleUndo(store: WinnowStore): void {
    const commit = store.undoCommit;
    dropUndo(store);
    commit?.();
  }

  /** Forget the offered undo, its redo and its commit without running either. */
  export function dropUndo(store: WinnowStore): void {
    store.undoAction = null;
    store.undoRedo = null;
    store.undoCommit = null;
    store.undoCommitAfterMs = undefined;
    if (store.undoCommitTimer) clearTimeout(store.undoCommitTimer);
    store.undoCommitTimer = null;
    store.redoEntry = null;
  }

  /**
   * Move a message, with Undo on the strip: the swipe's Trash, and its Restore from the
   * Trash. A plain `move` underneath, so the optimistic update, the rollback on failure
   * and the trash bias are the ordinary ones; Undo puts the mailbox and the unread flag
   * back as they were and takes the sender's trash mark back if this move added it.
   *
   * Sent mail is restored by taking the Trash label off (Gmail keeps SENT itself and
   * refuses it in a modify), so its undo files to "archive" at the API and to Sent here.
   */
  export function moveWithUndo(store: WinnowStore, id: number, mailbox: Mailbox): void {
    const email = store.state.all.find((candidate) => candidate.id === id);
    if (!email || email.mailbox === mailbox) return;
    if (email.mailbox === "sent" && mailbox !== "trash") return;
    movesWithUndo(store, [{ id, to: mailbox }]);
  }

  /**
   * Archive with Undo: `e`, the reader's and the selection bar's Archive, the row menu.
   * Each message goes where `archive` sends it (out of the inbox, back from the archive,
   * nothing from Sent), and one offer takes back every one of them.
   */
  export function archiveWithUndo(store: WinnowStore, ids: Iterable<number>): void {
    // In Snoozed, `e` and the bars' first button are Unsnooze: back to the Inbox now.
    if (store.state.mailbox === "snoozed") {
      store.unsnooze(ids);
      return;
    }
    const moves: { id: number; to: Mailbox }[] = [];
    for (const id of new Set(ids)) {
      const email = store.state.all.find((candidate) => candidate.id === id);
      if (!email || email.mailbox === "sent") continue;
      moves.push({ id, to: email.mailbox === "inbox" ? "archive" : "inbox" });
    }
    movesWithUndo(store, moves);
  }

  /**
   * Trash with Undo: `#`/Delete, the reader's and the selection bar's Trash, the row
   * menu. What `trash` means is kept: in Drafts it discards (one draft with Undo, as the
   * swipe does; several at once as before, without), and in the Trash it deletes for
   * good, which nothing can take back, so it offers nothing.
   */
  export function trashWithUndo(store: WinnowStore, ids: Iterable<number>): void {
    const list = [...new Set(ids)];
    if (store.state.mailbox === "drafts") {
      if (list.length === 1 && store.draftRow(list[0])) store.discardDraftWithUndo(list[0]);
      else void store.discardDrafts(list);
      return;
    }
    const moves: { id: number; to: Mailbox }[] = [];
    for (const id of list) {
      const email = store.state.all.find((candidate) => candidate.id === id);
      if (!email) continue;
      if (email.mailbox === "trash") store.deletePermanently(id);
      else moves.push({ id, to: "trash" });
    }
    movesWithUndo(store, moves);
  }

  /** Move to a chosen mailbox with Undo: the selection bar's and row menu's Move, Not spam. */
  export function moveManyWithUndo(store: WinnowStore, ids: Iterable<number>, mailbox: Mailbox): void {
    movesWithUndo(store, [...new Set(ids)].map((id) => ({ id, to: mailbox })));
  }

  /**
   * Make a set of moves and offer one Undo for all of them. Each goes through `move`;
   * Undo puts back, per message, the mailbox and unread flag it had, and only for a
   * message still where this action put it (one moved on since is left alone), and
   * takes back the trash marks this action added. A newer offer lets this one go, as
   * ever, so each Undo takes back its own action and nothing else.
   */
  function movesWithUndo(store: WinnowStore, moves: readonly { id: number; to: Mailbox }[]): void {
    const done: { id: number; to: Mailbox; from: Mailbox; unread: boolean }[] = [];
    const markedSenders = new Set<string>();
    for (const { id, to } of moves) {
      const email = store.state.all.find((candidate) => candidate.id === id);
      if (!email || email.mailbox === to) continue;
      if (to === "trash" && !store.trashSenders.includes(email.sender)) markedSenders.add(email.sender);
      done.push({ id, to, from: email.mailbox, unread: email.unread });
      store.move(id, to);
    }
    if (done.length === 0) return;
    const backend = store.backend;
    const undo = () => {
      if (store.backend !== backend) return;
      if (markedSenders.size > 0) store.trashSenders = store.trashSenders.filter((sender) => !markedSenders.has(sender));
      for (const move of done) {
        const now = store.state.all.find((candidate) => candidate.id === move.id);
        if (!now || now.mailbox !== move.to) continue;
        store.mutate(
          move.id,
          () => ({ ...now, mailbox: move.from, unread: move.unread }),
          async () => {
            await store.backend?.moveToMailbox(move.id, move.from === "sent" ? "archive" : move.from);
          },
          { previousMailbox: move.to, previousUnread: now.unread },
        );
      }
    };
    // Redo runs the move again through the ordinary `move`, which re-marks the sender
    // for the Trash and marks the message read exactly as the first action did. A
    // message that has moved on since the undo is left alone, as its undo would be.
    const redo = () => {
      if (store.backend !== backend) return;
      for (const move of done) {
        const now = store.state.all.find((candidate) => candidate.id === move.id);
        if (!now || now.mailbox !== move.from) continue;
        store.move(move.id, move.to);
      }
    };
    store.offerUndo(undoLabel(done.map((move) => move.to)), undo, { redo });
  }

  /**
   * Discard one draft with Undo: the row goes now, and Gmail's copy is deleted only when
   * the offer is let go (dismissed, replaced, a mailbox change) or after
   * `DRAFT_DISCARD_UNDO_MS`. Undo just puts the row back. Closing the app first keeps
   * the draft, which is the safe way round.
   */
  export function discardDraftWithUndo(store: WinnowStore, id: number): void {
    const row = store.draftRow(id);
    const draftId = row?.gmailDraft?.id;
    if (!row || !draftId) return;
    const generation = store.draftsGeneration;
    const discard = () => {
      if (generation !== store.draftsGeneration) return;
      store.pendingDiscards.add(draftId);
      store.set({
        drafts: store.state.drafts.filter((email) => email.id !== id),
        ...(store.state.selectedId === id ? { selectedId: null } : {}),
      });
    };
    const restore = () => {
      if (generation !== store.draftsGeneration) return;
      if (store.state.drafts.some((email) => email.gmailDraft?.id === draftId)) return;
      store.set({ drafts: [row, ...store.state.drafts].sort((a, b) => b.receivedAt - a.receivedAt) });
    };
    discard();
    store.offerUndo(
      "Draft discarded.",
      () => {
        store.pendingDiscards.delete(draftId);
        restore();
      },
      {
        // Redo discards the restored row again, with the same deferred Gmail delete.
        redo: discard,
        commit: () => {
          if (generation !== store.draftsGeneration) {
            store.pendingDiscards.delete(draftId);
            return;
          }
          const api = store.backend?.drafts;
          if (!api) {
            store.pendingDiscards.delete(draftId);
            return;
          }
          api
            .delete(draftId)
            .catch(() => {
              restore();
              store.set({ notice: "Couldn't discard that draft." });
            })
            .finally(() => store.pendingDiscards.delete(draftId));
        },
        commitAfterMs: DRAFT_DISCARD_UNDO_MS,
      },
    );
  }

  /** Drop the offered undo without taking it. */
  export function dismissUndo(store: WinnowStore): void {
    if (!store.undoAction) return;
    settleUndo(store);
    store.set({ undo: null, redo: null });
  }
