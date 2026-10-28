/**
 * Every lucide glyph in the app goes through here, so icons come in four sizes and one
 * stroke rather than the 17 sizes and 11 strokes they had when each was picked on its own
 * (neighbouring glyphs 1–2px apart in size and weight).
 *
 *   12  inline with meta text: counts, captions, the code chip, external-link marks.
 *   16  controls: buttons, menu items, fields, the reader's action bar.
 *   20  bars and touch targets: the phone's top bar and reader pill, the sidebar,
 *       swipe backdrops, lightbox controls.
 *   24  the phone dock (and the reader's empty state), the largest thing a thumb aims at.
 *
 * One stroke, 2, at every size. Active states are carried by colour and the highlight
 * behind a control, not by a heavier stroke. `theme.test.ts` fails on a lucide glyph
 * drawn directly, or any element given both a raw `size` and a `strokeWidth`.
 *
 * Decorative by default (`aria-hidden`), since the control around it carries the name;
 * pass `aria-label` (and `aria-hidden={false}`) for the rare glyph that is the label.
 */

import type { ComponentType } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

/**
 * A lucide glyph, or one of the smart-filter glyphs (`ui/filterIcons`), which take the
 * same size and stroke and do their own box/ink normalisation (`boxIcon`).
 */
export type IconGlyph =
  | LucideIcon
  | ComponentType<{ size?: number; strokeWidth?: number; className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export const ICON_SIZES = [12, 16, 20, 24] as const;
export type IconSize = (typeof ICON_SIZES)[number];
export const ICON_STROKE = 2;

export type IconProps = Omit<LucideProps, "size" | "strokeWidth" | "absoluteStrokeWidth" | "ref"> & {
  icon: IconGlyph;
  size?: IconSize;
};

export function Icon({ icon: Glyph, size = 16, ...rest }: IconProps) {
  return <Glyph aria-hidden="true" {...rest} size={size} strokeWidth={ICON_STROKE} />;
}
