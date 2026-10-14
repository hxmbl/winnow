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
