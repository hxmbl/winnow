/**
 * How the wide layout divides its width between the list and the reader.
 *
 * Kept as the *reader's fraction* of the width the two panes share, never as pixels, so a
 * split chosen in a 1440px window still means the same thing in a 1920px one. The pixel
 * minimums are resolved against the width of the moment: in CSS for the pane itself
 * (`clamp()` in `index.css`), and here for the handle's value and its keyboard steps, so
 * both agree on where the divider actually is.
 *
 * Pure: no DOM, no React. `ReaderSplitHandle` owns the pointer, the storage and the CSS
 * variable; this owns the arithmetic.
 */

/** Where the split lives across reloads. Same naming as `winnow.preferences.v1`. */
export const READER_SPLIT_KEY = "winnow.readerSplit.v1";

/** The reader's share before anyone drags: the `38%` the pane had as a fixed width. */
export const DEFAULT_READER_FRACTION = 0.38;

/** The narrowest list that still shows a sender, a subject and a time on one row. */
export const MIN_LIST_PX = 280;

/** The narrowest reader whose toolbar and header still fit without wrapping badly. */
export const MIN_READER_PX = 360;

/** Arrow keys move the divider by 2% of the width, Shift+arrow by 10%. */
export const STEP = 0.02;
export const BIG_STEP = 0.1;

export interface SplitBounds {
  /** The smallest reader fraction this width allows. */
  min: number;
  /** The largest reader fraction this width allows. */
  max: number;
  /** False when the width cannot hold both minimums: nothing to resize. */
  resizable: boolean;
}

/**
 * The reader fractions a width allows.
 *
 * Below `MIN_LIST_PX + MIN_READER_PX` there is no split that honours both, so the range
 * collapses to the default and the handle stops offering one. The wide layout starts at
 * Tailwind's `lg` (1024px), well clear of 640px, so this is the guard for a pane that is
 * measured mid-transition rather than a state the layout is designed to reach.
 */
export function splitBounds(width: number): SplitBounds {
  if (!Number.isFinite(width) || width <= 0 || width < MIN_LIST_PX + MIN_READER_PX) {
    return { min: DEFAULT_READER_FRACTION, max: DEFAULT_READER_FRACTION, resizable: false };
  }
  return { min: MIN_READER_PX / width, max: 1 - MIN_LIST_PX / width, resizable: true };
}

/** A fraction held inside what `width` allows. Not-a-number becomes the default. */
export function clampReaderFraction(fraction: number, width: number): number {
  const { min, max } = splitBounds(width);
  const value = Number.isFinite(fraction) ? fraction : DEFAULT_READER_FRACTION;
  return Math.min(max, Math.max(min, value));
}

/**
 * The reader fraction for a pointer at `x`, in a container from `left` to `left + width`.
 * The reader is the right-hand pane, so it is the distance from the pointer to the right
 * edge.
 */
export function fractionAtPointer(x: number, left: number, width: number): number {
  if (!(width > 0)) return DEFAULT_READER_FRACTION;
  return clampReaderFraction((left + width - x) / width, width);
}

/**
 * The handle's ARIA value: the divider's position as a whole percentage from the left,
 * which is the list's share. Moving the divider right raises it, as ArrowRight does.
 */
export function listPercent(readerFraction: number): number {
  return Math.round((1 - readerFraction) * 100);
}

/** `aria-valuemin` / `aria-valuemax` for a width, in the same list-percent terms. */
export function percentBounds(width: number): { min: number; max: number } {
  const { min, max } = splitBounds(width);
  return { min: Math.ceil((1 - max) * 100), max: Math.floor((1 - min) * 100) };
}

/**
 * The reader fraction after a key on the handle, or null for a key it does not handle.
 *
 * Expressed in the divider's terms: ArrowRight moves it right (a wider list, a narrower
 * reader), Home takes it to the far left (the list at its minimum), End to the far right.
 */
export function stepReaderFraction(
  current: number,
  key: string,
  shift: boolean,
  width: number,
): number | null {
  const { min, max } = splitBounds(width);
  const from = clampReaderFraction(current, width);
  const step = shift ? BIG_STEP : STEP;
  switch (key) {
    case "ArrowLeft":
      return clampReaderFraction(from + step, width);
    case "ArrowRight":
      return clampReaderFraction(from - step, width);
    case "Home":
      return max;
    case "End":
      return min;
    default:
      return null;
  }
}

/** The subset of `Storage` this needs, so a test can hand in a map. */
export interface SplitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The saved split, or the default.
 *
 * Tolerant, because the input is `localStorage`: anything can be in there. Only a number
 * strictly between 0 and 1 is a split; it is *not* clamped here, because the clamp depends
 * on the width at render time, and a split saved in a wide window should come back when
 * the window does.
 */
export function loadReaderFraction(storage: SplitStorage | undefined | null): number {
  try {
    const raw = storage?.getItem(READER_SPLIT_KEY);
    if (raw == null) return DEFAULT_READER_FRACTION;
    const parsed: unknown = JSON.parse(raw);
    const value =
      typeof parsed === "object" && parsed !== null ? (parsed as { reader?: unknown }).reader : undefined;
    return typeof value === "number" && value > 0 && value < 1 ? value : DEFAULT_READER_FRACTION;
  } catch {
    return DEFAULT_READER_FRACTION;
  }
}

/**
 * Save a split. The default is saved as *no* entry, so a reset leaves nothing behind and a
 * later change to the default reaches people who never moved the divider.
 */
export function saveReaderFraction(storage: SplitStorage | undefined | null, fraction: number): void {
  try {
    if (!storage) return;
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1 || fraction === DEFAULT_READER_FRACTION) {
      storage.removeItem(READER_SPLIT_KEY);
      return;
    }
    storage.setItem(READER_SPLIT_KEY, JSON.stringify({ reader: Math.round(fraction * 10_000) / 10_000 }));
  } catch {
    // Storage full or disabled: the split still holds for this session.
  }
}

/** The CSS variable the reader pane's width reads. */
export const READER_SPLIT_VAR = "--wn-reader-split";

/** The variable's value for a fraction: a percentage, which `clamp()` in CSS bounds. */
export function splitCssValue(fraction: number): string {
  return `${Math.round(fraction * 10_000) / 100}%`;
}
