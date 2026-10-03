/**
 * Learning from what the user does.
 *
 * The premise: Winnow has no training data, so the cheapest honest signal is
 * the user's own thumb. Starring a message means "this is what I wanted to
 * see", and every signal present on it is evidence that the weight for that
 * signal is too low. Unstarring means the reverse. Muting a bucket means the
 * signals driving that bucket are misfiring.
 *
 * Three constraints keep this from becoming a machine that confidently learns
 * the wrong thing:
 *
 *   1. **Small steps.** One star moves a weight by 1 point, not by enough to
 *      reorder the inbox. Twenty stars are what should change the ranking; one
 *      mis-click should not.
 *   2. **Clamping.** Every move respects the signal's range, so a loop cannot
 *      invert a weight or run it away.
 *   3. **A capped log.** Up to 400 events, oldest dropped. The events are the
 *      audit trail that makes a surprising ranking explainable ("why is this
 *      here?") rather than a second copy of the inbox.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Learning/LearningModel.swift`.
 */

import type { Email } from "../model/email";
import type { BuiltinSmartFilter, EmailSignals } from "../model/signals";
import {
  defaultWeights,
  isPenalty,
  nudgeWeight,
  signalMeta,
  STANDARD_WEIGHTS,
  type SignalKey,
  type SignalWeights,
} from "../classify/weights";

/** Points moved per event. Small on purpose — see the header. */
export const LEARNING_STEP = 1;

/** The event log is capped so storage stays bounded. */
export const MAX_EVENTS = 400;

export type FeedbackAction = "starred" | "unstarred" | "filter_rejected";

export type FeedbackEvent = {
  id: string;
  /** Absent for a global "remove this pill" act. */
  emailId?: number;
  sender?: string;
  action: FeedbackAction;
  /**
   * The importance score *before* the feedback. Captured so the settings panel
   * can show "you rated this 42, we predicted 71" — which is the only way a
   * user can tell whether the weights are working for them.
   */
  predictedImportance?: number;
  /** The signals the event was allowed to move. */
  activeSignals: SignalKey[];
  rejectedFilter?: BuiltinSmartFilter;
  at: number;
};

export type LearningSnapshot = {
  weights: SignalWeights;
  /** Whether star feedback moves weights automatically. */
  adaptive: boolean;
  events: FeedbackEvent[];
};

/** Which signals a piece of feedback is allowed to move, and in which sense. */
function touchedKeys(signals: EmailSignals): SignalKey[] {
  const keys: SignalKey[] = [];
  if (signals.security) keys.push("security");
  if (signals.urgentText) keys.push("urgency");
  if (signals.needsAction) keys.push("actionNeeded");
  if (signals.finance) keys.push("finance");
  if (signals.newsletter) keys.push("newsletterPenalty");
  if (signals.promotional) keys.push("promoPenalty");
  return keys;
}

/** Which signals plausibly drove a bucket's matches. */
function drivingKeys(filter: BuiltinSmartFilter): SignalKey[] {
  switch (filter) {
    case "important":
    case "needs_action":
      return ["actionNeeded"];
    case "urgent":
      return ["urgency"];
    case "security":
      return ["security"];
    case "receipts":
      return ["finance"];
    case "newsletters":
      return ["newsletterPenalty"];
    case "promotional":
      return ["promoPenalty"];
    default:
      // Buckets with no single obvious signal (codes, shipping, social…) learn
      // nothing from a mute, but the event is still logged so the history is
      // complete.
      return [];
  }
}

/** Mutate a weight set, reporting whether anything actually moved. */
function applyDeltas(
  weights: SignalWeights,
  deltas: readonly { key: SignalKey; delta: number }[],
): { weights: SignalWeights; changed: boolean } {
  let next = weights;
  let changed = false;
  for (const { key, delta } of deltas) {
    const result = nudgeWeight(next, key, delta);
    next = result.weights;
    changed = changed || result.changed;
  }
  return { weights: next, changed };
}

/** Whether a persisted event is complete enough for the panel to render it. */
function isWellFormedEvent(event: unknown): event is FeedbackEvent {
  if (!event || typeof event !== "object") return false;
  const row = event as Partial<FeedbackEvent>;
  if (typeof row.id !== "string" || typeof row.at !== "number") return false;
  if (!Number.isFinite(row.at)) return false;
  if (row.action !== "starred" && row.action !== "unstarred" && row.action !== "filter_rejected") {
    return false;
  }
  if (row.sender !== undefined && typeof row.sender !== "string") return false;
  if (row.emailId !== undefined && typeof row.emailId !== "number") return false;
  return Array.isArray(row.activeSignals);
}

/**
 * The learning model.
 *
 * Immutable: every method returns a new snapshot. That is what lets the same
 * model be shared between the store, the settings panel and the tests without
 * any of them having to know who else holds a reference.
 */
export class LearningModel {
  readonly weights: SignalWeights;
  readonly adaptive: boolean;
  readonly events: readonly FeedbackEvent[];

  private constructor(snapshot: LearningSnapshot) {
    this.weights = snapshot.weights;
    this.adaptive = snapshot.adaptive;
    this.events = snapshot.events;
  }

  static initial(): LearningModel {
    return new LearningModel({ weights: STANDARD_WEIGHTS, adaptive: true, events: [] });
  }

  /**
   * Rebuild from what was persisted.
   *
   * A *tolerant* constructor, because the input is `localStorage`: anything can be
   * in there, including a snapshot from a build that knew fewer weights, a value
   * a user edited by hand, or half a write from a tab that was closed mid-save.
   *
   *   - **Weights** merge over the defaults, so a weight added since the snapshot
   *     was written is present at its default rather than `undefined`. A weight
   *     that is not a finite number is dropped for the same reason; one that is
   *     finite is clamped into its own range, because the panel's sliders will
   *     happily render an out-of-range value as a thumb at the far end.
   *   - **`adaptive`** falls back to on, because the alternative — reading
   *     `undefined` as off — would silently stop the learning loop the user never
   *     turned off.
   *   - **Events** are filtered to well-formed entries. A malformed one is
   *     dropped rather than allowed to reach the panel, which renders
   *     `event.sender` and `event.at` directly.
   *
   * Nothing here throws. A corrupt snapshot costs the user their tuning; a thrown
   * error costs them the app.
   */
  static fromSnapshot(raw: unknown): LearningModel {
    const snapshot = (raw ?? {}) as Partial<LearningSnapshot>;
    const defaults = defaultWeights();
    const weights = { ...defaults };

    const stored = snapshot.weights;
    if (stored && typeof stored === "object") {
      for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
        if (!Object.hasOwn(weights, key)) continue;
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const meta = signalMeta(key as SignalKey);
        weights[key as SignalKey] = Math.min(Math.max(Math.round(value), meta.min), meta.max);
      }
    }

    const events = Array.isArray(snapshot.events)
      ? snapshot.events.filter(isWellFormedEvent).slice(-MAX_EVENTS)
      : [];

    return new LearningModel({
      weights,
      adaptive: typeof snapshot.adaptive === "boolean" ? snapshot.adaptive : true,
      events,
    });
  }

  toSnapshot(): LearningSnapshot {
    return { weights: this.weights, adaptive: this.adaptive, events: [...this.events] };
  }

  /** A copy of the event log, for the settings panel's history list. */
  get history(): FeedbackEvent[] {
    // Newest first: the panel reads top-down and the newest event is the one
    // that explains a ranking the user is looking at right now.
    return [...this.events].reverse();
  }

  /** Append an event, dropping the oldest once the cap is reached. */
  private push(events: readonly FeedbackEvent[], event: FeedbackEvent): FeedbackEvent[] {
    const next = [...events, event];
    return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
  }

  /**
   * Record a star or unstar, and move the weights that were on the message.
   *
   * Call this *before* flipping `email.starred`, so `signals` is the
   * pre-feedback classification: after the flip, the star's own contribution to
   * the importance score would be included, and the model would learn from its
   * own output.
   */
  recordStar(
    email: Email,
    signals: EmailSignals,
    starred: boolean,
    now: number,
  ): LearningModel {
    const touched = touchedKeys(signals);
    const event: FeedbackEvent = {
      id: `${now}-${email.id}-${starred ? "s" : "u"}`,
      emailId: email.id,
      sender: email.sender,
      action: starred ? "starred" : "unstarred",
      predictedImportance: signals.importanceScore,
      activeSignals: touched,
      at: now,
    };

    let weights = this.weights;
    if (this.adaptive && touched.length > 0) {
      const deltas = touched.map((key) => ({
        key,
        // A boosting signal rises when the user starred a message carrying it;
        // a penalty signal *falls*, because the mail was worth reading despite
        // the label it was given.
        delta: LEARNING_STEP * ((isPenalty(key) === starred) ? -1 : 1),
      }));
      // Starring something the classifier called unsafe is the clearest
      // possible statement that the spam call was wrong.
      if (starred && signals.spamLikelihood >= 0.4) {
        deltas.push({ key: "spamSensitivity", delta: -LEARNING_STEP });
      }
      weights = applyDeltas(weights, deltas).weights;
    }

    return new LearningModel({
      weights,
      adaptive: this.adaptive,
      events: this.push(this.events, event),
    });
  }

  /**
   * Record a muted bucket and pull its driving signals the other way.
   *
   * Boosting signals step down (this mail was not important) and penalty
   * signals step up (the label under-fired). `.unsafe` is never muted, so spam
   * sensitivity is untouched by this path.
   */
  rejectFilter(
    filter: BuiltinSmartFilter,
    email: Email | null,
    signals: EmailSignals | null,
    now: number,
  ): LearningModel {
    const keys = drivingKeys(filter);
    const event: FeedbackEvent = {
      id: `${now}-${filter}-r`,
      emailId: email?.id,
      sender: email?.sender,
      action: "filter_rejected",
      predictedImportance: email && signals ? signals.importanceScore : undefined,
      activeSignals: email && signals ? touchedKeys(signals) : [],
      rejectedFilter: filter,
      at: now,
    };

    let weights = this.weights;
    if (this.adaptive && keys.length > 0) {
      weights = applyDeltas(
        weights,
        keys.map((key) => ({ key, delta: isPenalty(key) ? LEARNING_STEP : -LEARNING_STEP })),
      ).weights;
    }

    return new LearningModel({
      weights,
      adaptive: this.adaptive,
      events: this.push(this.events, event),
    });
  }

  /** Turn automatic learning on or off. Manual weight edits work either way. */
  setAdaptive(adaptive: boolean): LearningModel {
    if (adaptive === this.adaptive) return this;
    return new LearningModel({ weights: this.weights, adaptive, events: [...this.events] });
  }

  /**
   * One weight, set by hand from the settings panel.
   *
   * Rounds and clamps into the signal's range, and returns the same instance
   * when nothing changed, so a slider tick that lands on the same value does
   * not trigger a reclassify.
   */
  setWeight(key: SignalKey, value: number): LearningModel {
    const meta = signalMeta(key);
    const clamped = Math.min(Math.max(Math.round(value), meta.min), meta.max);
    if (clamped === this.weights[key]) return this;
    return new LearningModel({
      weights: { ...this.weights, [key]: clamped },
      adaptive: this.adaptive,
      events: [...this.events],
    });
  }

  /** Back to factory weights. The event log is kept: it is the audit trail. */
  resetAdjustments(): LearningModel {
    return new LearningModel({
      weights: defaultWeights(),
      adaptive: this.adaptive,
      events: [...this.events],
    });
  }
}
