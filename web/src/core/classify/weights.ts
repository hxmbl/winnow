/**
 * Tunable signal weights — the numbers the learning loop nudges.
 *
 * Two properties are load-bearing:
 *
 *   - **Clamped ranges.** `SIGNAL_KEYS` owns the range so the learning loop cannot
 *     skip the clamp; a runaway loop must not invert or explode a signal's influence.
 *   - **Integer values.** Matching the Swift pipeline's per-step truncation keeps
 *     scores comparable and stops rounding accumulating across a dozen additions.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Learning/SignalWeights.swift`.
 */

/** Every weight the app exposes, with its range, default and description. */
export type SignalKey =
  | "starBoost"
  | "security"
  | "urgency"
  | "actionNeeded"
  | "finance"
  | "newsletterPenalty"
  | "promoPenalty"
  | "spamSensitivity"
  | "quietContactPenalty"
  | "topSenderBoost";

export type SignalMeta = {
  key: SignalKey;
  label: string;
  /** One line for the settings panel: what moving this actually does. */
  explanation: string;
  defaultValue: number;
  /** Inclusive. A signal outside its range would dominate the ranking. */
  min: number;
  max: number;
};

/**
 * The tunables, in the order the settings panel shows them.
 *
 * Order is by how much the weight matters to a typical inbox, not
 * alphabetically — a user scanning this list should meet the big levers first.
 */
export const SIGNAL_KEYS: readonly SignalMeta[] = [
  {
    key: "starBoost",
    label: "Stars",
    explanation: "Points added when you starred the thread.",
    defaultValue: 22,
    min: 0,
    max: 40,
  },
  {
    key: "security",
    label: "Security alerts",
    explanation: "Points for security and account notices.",
    defaultValue: 16,
    min: 0,
    max: 40,
  },
  {
    key: "urgency",
    label: "Urgency",
    explanation: "Points for time-sensitive language.",
    defaultValue: 18,
    min: 0,
    max: 40,
  },
  {
    key: "actionNeeded",
    label: "Action needed",
    explanation: "Points when a reply or task is asked of you.",
    defaultValue: 12,
    min: 0,
    max: 40,
  },
  {
    key: "finance",
    label: "Receipts & billing",
    explanation: "Points for invoices, receipts and billing.",
    defaultValue: 7,
    min: 0,
    max: 20,
  },
  {
    key: "newsletterPenalty",
    label: "Newsletter penalty",
    explanation: "Points removed for newsletters.",
    defaultValue: 5,
    min: 0,
    max: 20,
  },
  {
    key: "promoPenalty",
    label: "Promo penalty",
    explanation: "Points removed for promotional mail.",
    defaultValue: 11,
    min: 0,
    max: 40,
  },
  {
    key: "spamSensitivity",
    label: "Spam sensitivity",
    explanation: "How hard spam likelihood drags importance down.",
    defaultValue: 44,
    min: 0,
    max: 80,
  },
  {
    key: "quietContactPenalty",
    label: "Quiet contact penalty",
    explanation: "Points removed for rarely-heard senders.",
    defaultValue: 6,
    min: 0,
    max: 20,
  },
  {
    key: "topSenderBoost",
    label: "Favourite senders",
    explanation: "Top-sender bonus; lower ranks scale from it.",
    defaultValue: 18,
    min: 0,
    max: 40,
  },
] as const;

const META = new Map(SIGNAL_KEYS.map((meta) => [meta.key, meta]));

export function signalMeta(key: SignalKey): SignalMeta {
  const meta = META.get(key);
  if (!meta) throw new Error(`unknown signal weight: ${key}`);
  return meta;
}

/** A full weight set. Every key present, so arithmetic never needs a default. */
export type SignalWeights = Record<SignalKey, number>;

/** The factory defaults. A fresh install, and the target of "reset". */
export function defaultWeights(): SignalWeights {
  return Object.fromEntries(SIGNAL_KEYS.map((meta) => [meta.key, meta.defaultValue])) as SignalWeights;
}

export const STANDARD_WEIGHTS: SignalWeights = defaultWeights();

/** Rounded and clamped into the signal's allowed range. */
export function clampWeight(key: SignalKey, value: number): number {
  const meta = signalMeta(key);
  return Math.min(Math.max(Math.round(value), meta.min), meta.max);
}

/**
 * Weights that move *against* the message being important.
 *
 * The learning loop needs this to know which way to nudge: starring mail that
 * carries a penalty signal means the penalty was too harsh, so it should shrink.
 */
export function isPenalty(key: SignalKey): boolean {
  return (
    key === "newsletterPenalty" ||
    key === "promoPenalty" ||
    key === "spamSensitivity" ||
    key === "quietContactPenalty"
  );
}

/**
 * Nudge a weight by `delta`, respecting its range.
 *
 * Returns the same object when the move would be clipped, so callers can use
 * identity to decide whether anything changed and whether to re-render.
 */
export function nudgeWeight(
  weights: SignalWeights,
  key: SignalKey,
  delta: number,
): { weights: SignalWeights; changed: boolean } {
  const next = clampWeight(key, weights[key] + delta);
  if (next === weights[key]) return { weights, changed: false };
  return { weights: { ...weights, [key]: next }, changed: true };
}
