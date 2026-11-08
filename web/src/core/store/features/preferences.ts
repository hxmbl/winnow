/**
 * Preferences and the learning model.
 *
 * Both are small, but both reclassify: a preference can change what the list shows,
 * and new weights make the whole derived tree stale. The debounce lives here so a
 * slider drag costs one pass, not one per tick.
 */

import type { SortBy } from "../../classify/scoring";
import type { LearningModel } from "../../learn/learning";
import type { Preferences } from "../state";
import type { WinnowStore } from "../store";

/**
 * Adopt a new learning model and reclassify.
 *
 * The reclassify is debounced: a weight slider fires many times a second, and
 * reclassifying the inbox on each tick would make dragging one visibly slow. 80ms
 * coalesces a drag and still feels immediate.
 */
export function setLearning(store: WinnowStore, learning: LearningModel): void {
  // The model goes on state immediately: the settings panel reads it synchronously as
  // a slider is dragged, and a debounce would make the numbers lag the thumb.
  // Persistence and reclassification are the expensive parts, and those wait.
  store.state = { ...store.state, learning };
  store.onPersist?.({ learning: learning.toSnapshot() });
  scheduleReclassify(store);
}

/** "Reset sorting": back to the shipped weights. The feedback log is kept. */
export function resetLearning(store: WinnowStore): void {
  setLearning(store, store.state.learning.resetAdjustments());
}

export function setPreferences(store: WinnowStore, patch: Partial<Preferences>): void {
  const preferences = { ...store.state.preferences, ...patch };
  store.set({ preferences }, { preferences: patch });
  void store.applyPlatform();
}

export function setSortBy(store: WinnowStore, sortBy: SortBy): void {
  setPreferences(store, { sortBy });
}

/**
 * Coalesce a burst of weight changes into one reclassification.
 *
 * A weight slider fires many times a second, and reclassifying the inbox on each
 * tick would make dragging one visibly slow. 80ms coalesces a drag into a single
 * pass and still feels immediate.
 */
export function scheduleReclassify(store: WinnowStore): void {
  if (store.classifyTimer) clearTimeout(store.classifyTimer);
  store.classifyTimer = setTimeout(() => {
    store.classifyTimer = null;
    // Notified once: the whole derived tree is recomputed from the new weights, and
    // every consumer sees the same new world.
    store.notify();
    store.onWeightsChanged?.(store.state.learning);
  }, 80);
}
