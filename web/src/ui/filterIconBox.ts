/**
 * Puts every smart-filter icon in the same square box at the same visual size. See
 * `boxIcon`; `filterIcons.tsx` applies it to each bucket's glyph.
 */

import { createElement, type ComponentType } from "react";
import type { BuiltinSmartFilter } from "../core/model/signals";

/**
 * Where each glyph's ink sits on lucide's 24-unit grid (x, y, width, height, the 2-unit
 * stroke included), measured with `getBBox` in Chromium. lucide draws to the grid, not to
 * a common size, so a 13-unit Reply arrow and a 22-unit Siren rendered at the same `size`
 * look like two different sizes on one rail.
 */
const INK: Record<BuiltinSmartFilter, [number, number, number, number]> = {
  important: [2, 5, 19.5, 14],
  urgent: [0.98, 1.99, 22.02, 20.01],
  needs_action: [3, 6, 18, 13],
  security: [3, 1, 18, 22],
  unsafe: [1, 1, 22, 22],
  starred: [1, 1, 22, 21.07],
  unread: [1, 1, 22, 22],
  new_senders: [1, 2, 22, 20],
  top_contacts: [1, 2, 22, 20],
  quiet_contacts: [3, 2, 18, 20],
  attachments: [2, 1, 20, 22],
  codes: [1, 0.96, 22.04, 22.04],
  shipping: [2, 1, 20, 22],
  travel: [2, 1.81, 20.19, 20.19],
  events: [2, 1, 20, 22],
  receipts: [3, 1, 18, 22],
  social: [1, 1.99, 21.01, 21.01],
  newsletters: [1, 1, 22, 22],
  promotional: [2, 5, 20, 15.01],
  low_priority: [1, 1, 22, 22],
  long_reads: [1, 2, 22, 20],
};

/**
 * A solid shape reads larger than an outline of the same extent, so the filled Important
 * marker is drawn a little smaller to sit level with the stroked icons beside it.
 */
const OPTICAL: Partial<Record<BuiltinSmartFilter, number>> = { important: 0.84 };

/** How much of the box the ink fills, as lucide's own 22-of-24 grid does. */
const FILL = 22 / 24;

/**
 * Every icon in the same square box at the same visual size: the glyph's ink is centred
 * and scaled until its longer side fills the box (by moving the `viewBox`, so it stays a
 * crisp vector), and the stroke is rescaled so every line is still the same 2px weight.
 */
export function boxIcon(
  id: BuiltinSmartFilter,
  Raw: ComponentType<{ size?: number; strokeWidth?: number; className?: string; viewBox?: string }>,
) {
  const [x, y, w, h] = INK[id];
  const side = Math.max(w, h) / FILL / (OPTICAL[id] ?? 1);
  const viewBox = [x + w / 2 - side / 2, y + h / 2 - side / 2, side, side].map((n) => +n.toFixed(3)).join(" ");
  const strokeScale = side / 24;
  // A plain function rather than a named component, so this module keeps exporting data
  // only (fast refresh); call sites still render it as `<Icon />`.
  const boxedIcon = ({ size = 24, strokeWidth = 2, className }: { size?: number; strokeWidth?: number; className?: string }) =>
    createElement(Raw, { size, strokeWidth: +(strokeWidth * strokeScale).toFixed(3), className, viewBox });
  return boxedIcon;
}

