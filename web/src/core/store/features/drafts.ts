/** Draft listing, row updates and multi-discard behaviour. */

import type { Email } from "../../model/email";
import type { WinnowStore } from "../store";

/** List Gmail drafts once at a time; a result for an old account is discarded. */
export function refreshDrafts(store: WinnowStore): Promise<void> {
  const backend = store.backend;
  if (!backend?.listDrafts) return Promise.resolve();
  if (store.draftsInFlight) return store.draftsInFlight;
  const generation = store.draftsGeneration;
  store.set({ draftsLoading: true });
  const run = (async () => {
    try {
      const listed = await backend.listDrafts!(store.state.drafts);
      if (generation !== store.draftsGeneration || store.backend !== backend) return;
      const drafts = listed.filter((email) => !store.pendingDiscards.has(email.gmailDraft?.id ?? ""));
      store.set({ drafts, draftsLoading: false });
    } catch (error) {
      if (generation !== store.draftsGeneration || store.backend !== backend) return;
      store.set({
        draftsLoading: false,
        notice: error instanceof Error ? `Couldn't list drafts: ${error.message}` : "Couldn't list drafts.",
      });
    } finally {
      store.draftsInFlight = null;
    }
  })();
  store.draftsInFlight = run;
  return run;
}

export function draftRow(store: WinnowStore, id: number): Email | null {
  return store.state.drafts.find((email) => email.id === id) ?? null;
}

/** Keep the composer’s current copy visible before the next Gmail listing. */
export function putDraftRow(store: WinnowStore, row: Email): void {
  const draftId = row.gmailDraft?.id;
  if (!draftId) return;
  const rest = store.state.drafts.filter((email) => email.gmailDraft?.id !== draftId);
  store.set({ drafts: [row, ...rest].sort((a, b) => b.receivedAt - a.receivedAt) });
}

/** Remove a draft after it was sent or discarded. */
export function removeDraftRow(store: WinnowStore, draftId: string): void {
  if (!store.state.drafts.some((email) => email.gmailDraft?.id === draftId)) return;
  store.set({ drafts: store.state.drafts.filter((email) => email.gmailDraft?.id !== draftId) });
}

/** Remove draft rows immediately and delete their Gmail copies in order. */
export async function discardDrafts(store: WinnowStore, ids: Iterable<number>): Promise<void> {
  const targets = [...ids]
    .map((id) => draftRow(store, id))
    .filter((row): row is Email => row?.gmailDraft !== undefined);
  if (targets.length === 0) return;
  const gone = new Set(targets.map((row) => row.id));
  store.set({
    drafts: store.state.drafts.filter((email) => !gone.has(email.id)),
    ...(store.state.selectedId !== null && gone.has(store.state.selectedId) ? { selectedId: null } : {}),
  });
  const api = store.backend?.drafts;
  if (!api) return;
  const failed: Email[] = [];
  for (const row of targets) {
    try {
      await api.delete(row.gmailDraft!.id);
    } catch {
      failed.push(row);
    }
  }
  if (failed.length > 0) {
    store.set({
      drafts: [...failed, ...store.state.drafts].sort((a, b) => b.receivedAt - a.receivedAt),
      notice: failed.length === 1 ? "Couldn't discard that draft." : `Couldn't discard ${failed.length} drafts.`,
    });
  }
}
