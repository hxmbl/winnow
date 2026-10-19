/**
 * Fitting a fixed-width HTML email to the reader's width, the way mail clients do.
 *
 * HTML mail is laid out in fixed-width tables (600–640px), and a `width:640px` table
 * nested in an auto-layout one ignores `max-width: 100%` (the percentage resolves
 * against a width the table itself decides). On a 390px phone the message then runs
 * past the card, and the card's containment (`contain: paint`, which keeps a sender's
 * markup inside its box) cuts the right-hand column off.
 *
 * The answer Gmail and Apple Mail give is to shrink the message to fit: here, CSS `zoom`
 * on the message's container, so the layout (and the card's height) shrinks with it,
 * not just the paint, as a `transform` would. A message that already fits — every
 * responsive email — is measured as fitting and left at 1, untouched.
 *
 * Below `MIN_FIT_SCALE` text would be too small to read, so the message stops shrinking
 * and scrolls sideways for the rest (`overflowAfterFit`).
 *
 * Pure: no DOM. `MessageBody` measures and writes; this decides.
 */

/** The smallest a message is shrunk to: 640px into ~290px on a phone is 0.45. */
export const MIN_FIT_SCALE = 0.4;

/** Overflow of a pixel or two is rounding, not a fixed-width layout. */
export const FIT_TOLERANCE_PX = 2;

/**
 * The zoom for a message whose content is `natural` px wide (its `scrollWidth` at zoom 1)
 * in a container `available` px wide. 1 when it fits; otherwise the ratio, floored to
 * hundredths so the result never overshoots by a fraction of a pixel, and never below
 * `MIN_FIT_SCALE`.
 */
export function fitScale(natural: number, available: number): number {
  if (!Number.isFinite(natural) || !Number.isFinite(available) || available <= 0 || natural <= 0) return 1;
  if (natural <= available + FIT_TOLERANCE_PX) return 1;
  const ratio = Math.floor((available / natural) * 100) / 100;
  return Math.max(MIN_FIT_SCALE, Math.min(1, ratio));
}

/**
 * Whether the message still overflows once shrunk by `scale`: true only when it hit
 * `MIN_FIT_SCALE`, so the container should scroll sideways rather than clip.
 */
export function overflowAfterFit(natural: number, available: number, scale: number): boolean {
  return natural * scale > available + FIT_TOLERANCE_PX;
}
