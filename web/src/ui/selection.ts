/**
 * Multi-row selection, as pure functions.
 *
 * The list owns the gestures (pointer events, timers) and this file owns what they
 * mean, so the rules are unit-tested rather than only exercised by the smoke run:
 *
 *   - **Drag** (desktop): mouse down on a row and drag across others; every row between
 *     where the drag started and where the pointer is now is selected, on top of what was
 *     already selected when the drag began if ⌘/Ctrl was held, otherwise instead of it.
 *     A press that never moves is a click and opens the message.
 *   - **Shift-click** selects the range from the last anchor; **⌘/Ctrl-click** toggles one.
 *   - **Long-press** (phone): holding a row still for `LONG_PRESS_MS` enters select mode
 *     with that row selected; in select mode a tap toggles. Moving more than
 *     `TOUCH_SLOP` first is a scroll, and cancels the press.
 *
 * Ids are the rows' representative message ids, the same ids `onSelect` opens.
 */

export type Selection = ReadonlySet<number>;

export const EMPTY_SELECTION: Selection = new Set<number>();

/** How long a finger must rest on a row before it selects. */
export const LONG_PRESS_MS = 450;
/** How far a finger may wander (px) and still be a press rather than a scroll. */
export const TOUCH_SLOP = 10;
/** How far a mouse must move (px) with the button down before a press becomes a drag. */
export const DRAG_THRESHOLD = 5;

/** The ids from `a` to `b` inclusive, in list order, whichever comes first. */
export function rangeBetween(order: readonly number[], a: number, b: number): number[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return j >= 0 ? [b] : i >= 0 ? [a] : [];
  const [from, to] = i <= j ? [i, j] : [j, i];
  return order.slice(from, to + 1);
}

/** The selection with `id` flipped. */
export function toggleId(selection: Selection, id: number): Selection {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** A drag from `anchor` to `current`, added to `base` (empty unless ⌘/Ctrl was held). */
export function dragSelection(
  base: Selection,
  order: readonly number[],
  anchor: number,
  current: number,
): Selection {
  const next = new Set(base);
  for (const id of rangeBetween(order, anchor, current)) next.add(id);
  return next;
}

/**
 * Shift-click: the range from the anchor to `id`, replacing the selection — or added to
 * it with ⌘/Ctrl, as file managers do. With no anchor it selects just `id`.
 */
export function shiftSelection(
  selection: Selection,
  order: readonly number[],
  anchor: number | null,
  id: number,
  additive: boolean,
): Selection {
  const next = new Set(additive ? selection : []);
  for (const each of anchor === null ? [id] : rangeBetween(order, anchor, id)) next.add(each);
  return next;
}

/** The selection with ids that are no longer in the list dropped (same object if none). */
export function pruneSelection(selection: Selection, order: readonly number[]): Selection {
  if (selection.size === 0) return selection;
  const live = new Set(order);
  let changed = false;
  const next = new Set<number>();
  for (const id of selection) {
    if (live.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : selection;
}

/** The ids in list order, for a batch action that should run top to bottom. */
export function orderedSelection(selection: Selection, order: readonly number[]): number[] {
  return order.filter((id) => selection.has(id));
}

/**
 * The phone's long-press, as a tiny state machine with the clock passed in.
 *
 * `down` arms it; `move` disarms it past the slop; `tick` (from a timer) fires it once
 * the hold is long enough. `up` reports whether the press fired, so the click that the
 * browser sends after the finger lifts can be swallowed.
 */
export class LongPress {
  private start: { x: number; y: number; at: number; id: number } | null = null;
  private fired = false;

  constructor(
    private readonly holdMs = LONG_PRESS_MS,
    private readonly slop = TOUCH_SLOP,
  ) {}

  down(id: number, x: number, y: number, at: number): void {
    this.start = { x, y, at, id };
    this.fired = false;
  }

  /** False once the finger has moved far enough to be a scroll. */
  move(x: number, y: number): boolean {
    if (!this.start) return false;
    if (Math.hypot(x - this.start.x, y - this.start.y) > this.slop) this.start = null;
    return this.start !== null;
  }

  /** The id to select if the hold has just become long enough, once. */
  tick(at: number): number | null {
    if (!this.start || this.fired) return null;
    if (at - this.start.at < this.holdMs) return null;
    this.fired = true;
    return this.start.id;
  }

  /** Whether this press fired; resets for the next. */
  up(): boolean {
    const fired = this.fired;
    this.start = null;
    this.fired = false;
    return fired;
  }

  cancel(): void {
    this.start = null;
    this.fired = false;
  }
}

/** How close (px) to the list's top or bottom edge a drag starts scrolling it. */
export const EDGE_SCROLL_ZONE = 40;
/** The fastest a drag scrolls the list, in px per frame. */
export const EDGE_SCROLL_MAX = 24;

/**
 * How far to scroll the list this frame for a drag at `y`, given the list's box.
 *
 * Zero in the middle; inside the edge zone it ramps up with depth, and past the edge
 * (the pointer dragged out above or below the list, or out of the window) it runs at
 * full speed. Negative scrolls up.
 */
export function edgeScrollSpeed(
  y: number,
  top: number,
  bottom: number,
  zone = EDGE_SCROLL_ZONE,
  max = EDGE_SCROLL_MAX,
): number {
  const near = Math.min(zone, Math.max(0, (bottom - top) / 4));
  if (y < top + near) return -Math.min(max, Math.ceil(((top + near - y) / Math.max(1, near)) * max));
  if (y > bottom - near) return Math.min(max, Math.ceil(((y - (bottom - near)) / Math.max(1, near)) * max));
  return 0;
}

/**
 * The row a drag is over when the pointer is not over any row: past the last row, above
 * the first, or over a day heading. The nearest mounted row by vertical distance, so a
 * drag carried past the end of the list selects through to its last row rather than
 * freezing wherever the rows ran out. Null when nothing is mounted.
 */
export function nearestRow(rows: readonly { id: number; top: number; bottom: number }[], y: number): number | null {
  let best: number | null = null;
  let distance = Infinity;
  for (const row of rows) {
    const d = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0;
    if (d < distance) {
      distance = d;
      best = row.id;
    }
  }
  return best;
}

/**
 * What an avatar drag adds to. A drag from a row's body replaces the selection (unless
 * ⌘/Ctrl is held); a drag from an avatar adds to it, because the avatar is the row's
 * checkbox once anything is selected — "Select" from the sender menu, then drag down
 * the avatars to add the rest.
 */
export function avatarDragBase(selection: Selection, additive: boolean): Selection {
  return additive || selection.size > 0 ? selection : EMPTY_SELECTION;
}

/** Whether two selections hold the same ids, so a drag frame that changes nothing is not a re-render. */
export function sameSelection(a: Selection, b: Selection): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
