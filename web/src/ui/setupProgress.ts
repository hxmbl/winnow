/**
 * A half-finished Google setup, remembered so it can be resumed.
 *
 * Setting up a client takes a trip through five Cloud Console pages, and people leave
 * part-way: to wait for an API to enable, to find their test-user address, or because
 * the demo was more interesting. When they come back, the walkthrough opens where they
 * left it, with the steps they finished ticked and the client ID they had typed.
 *
 * What is kept: the step on screen, the steps marked done, the build kind it was for, and
 * the client ID draft. **Never the secret** — a draft secret is not worth a copy outside
 * the keychain. The record is dropped when the client is saved, when it is removed, and
 * by "Start over". Its key sits beside the client's own (`winnow.google.oauthClient`);
 * the client itself is still stored only where it always was.
 */

import type { ClientKind } from "../core/session/credentials";
import { ALL_SETUP_STEPS, SETUP_STEPS, clampStep, type SetupStep, type SetupStepId } from "./googleSetupSteps";

export const SETUP_PROGRESS_KEY = "winnow.google.setupProgress";

export type SetupProgress = {
  step: number;
  done: SetupStepId[];
  kind: ClientKind;
  clientId: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The record is kept within every step any build has (Android's walkthrough has an extra
 * one before Paste); the sheet clamps it again to the steps it shows.
 */
const STEP_IDS = new Set<string>(ALL_SETUP_STEPS.map((step) => step.id));

/** Read a stored record; anything malformed, or for another build kind, is no record. */
export function parseSetupProgress(raw: string | null | undefined, kind: ClientKind): SetupProgress | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SetupProgress> | null;
    if (!value || typeof value !== "object" || value.kind !== kind) return null;
    const done = Array.isArray(value.done)
      ? [...new Set(value.done.filter((id): id is SetupStepId => typeof id === "string" && STEP_IDS.has(id)))]
      : [];
    const step = clampStep(typeof value.step === "number" ? value.step : 0, ALL_SETUP_STEPS);
    const clientId = typeof value.clientId === "string" ? value.clientId.slice(0, 256) : "";
    return { step, done, kind, clientId };
  } catch {
    return null;
  }
}

/** Whether a record says anything worth resuming. */
export function isWorthResuming(progress: SetupProgress | null): progress is SetupProgress {
  return Boolean(progress && (progress.step > 0 || progress.done.length > 0 || progress.clientId.trim()));
}

function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadSetupProgress(kind: ClientKind, store: StorageLike | null = storage()): SetupProgress | null {
  try {
    const progress = parseSetupProgress(store?.getItem(SETUP_PROGRESS_KEY), kind);
    return isWorthResuming(progress) ? progress : null;
  } catch {
    return null;
  }
}

/** Write the record, or drop it when there is nothing to resume. Never throws. */
export function saveSetupProgress(progress: SetupProgress, store: StorageLike | null = storage()): void {
  try {
    if (!isWorthResuming(progress)) {
      store?.removeItem(SETUP_PROGRESS_KEY);
      return;
    }
    const record: SetupProgress = {
      step: clampStep(progress.step, ALL_SETUP_STEPS),
      done: [...new Set(progress.done)],
      kind: progress.kind,
      clientId: progress.clientId.trim().slice(0, 256),
    };
    store?.setItem(SETUP_PROGRESS_KEY, JSON.stringify(record));
  } catch {
    // Storage full or disabled: resuming is a convenience, not worth an error.
  }
}

export function clearSetupProgress(store: StorageLike | null = storage()): void {
  try {
    store?.removeItem(SETUP_PROGRESS_KEY);
  } catch {
    // Already unreachable.
  }
}

/** Mark a step done, keeping walkthrough order. */
export function markDone(done: readonly SetupStepId[], id: SetupStepId): SetupStepId[] {
  const set = new Set([...done, id]);
  return ALL_SETUP_STEPS.map((step) => step.id).filter((step) => set.has(step));
}

/** "2 of 5 done", for the progress line, counted over the steps on screen. */
export function doneSummary(done: readonly SetupStepId[], steps: readonly SetupStep[] = SETUP_STEPS): string {
  const count = steps.filter((step) => done.includes(step.id)).length;
  return `${count} of ${steps.length} done`;
}
