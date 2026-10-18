/**
 * Swipe actions on a phone's message list, as pure logic.
 *
 * Gmail's feel: the row follows the finger, a coloured backdrop names what letting go
 * will do, and past a commit line (or on a fast fling) letting go does it. Everything
 * that decides *whether* a touch is a swipe lives here, with no DOM, so the rules that
 * keep it from fighting the system are unit-tested rather than found on a real phone:
 *
 *   - **Edge exclusion.** A touch that starts within `EDGE_PX` of either side of the
 *     screen is Android's back gesture, never a swipe.
 *   - **Axis lock.** Nothing is decided until the finger has moved `AXIS_LOCK_PX`. Then
 *     the gesture is horizontal (a swipe) or vertical (a scroll) for the rest of the
 *     touch, and a scroll never turns into a swipe halfway.
 *   - **Commit.** Past `COMMIT_FRACTION` of the row's width, or a fling faster than
 *     `FLING_VELOCITY` that has travelled at least `FLING_MIN_PX` the same way.
 *   - **Directions.** A direction whose action makes no sense in this mailbox is
 *     disabled: the row does not move that way at all.
 *
 * Directions are physical ("left" is the finger moving toward the left edge). Winnow has
 * no right-to-left layout, so nothing is mirrored; `rtl` exists so that a future one only
 * has to pass `true`.
 */

/** A touch starting this close (px) to either screen edge belongs to the system. */
export const EDGE_PX = 24;
/** How far (px) the finger travels before the gesture is a swipe or a scroll for good. */
export const AXIS_LOCK_PX = 10;
/** The share of the row's width past which letting go commits. */
export const COMMIT_FRACTION = 0.38;
/** A release at least this fast (px/ms) commits, even short of the line. */
export const FLING_VELOCITY = 0.6;
/** But only after this much travel (px), so a flick that barely moved does nothing. */
export const FLING_MIN_PX = 40;
/** How far back (ms) the release velocity looks. */
export const VELOCITY_WINDOW_MS = 100;

export type SwipeDirection = "left" | "right";

/**
 * What a direction does. `trash` and `discard` remove the row (with Undo), `restore`
 * moves it back to the Inbox from the Trash, and the read pair snap back toggled.
 */
export type SwipeAction = "trash" | "discard" | "restore" | "markRead" | "markUnread";

export type SwipeActions = { left: SwipeAction | null; right: SwipeAction | null };

/** Whether the action takes the row out of the list (and so animates it away). */
export function removesRow(action: SwipeAction): boolean {
  return action === "trash" || action === "discard" || action === "restore";
}

/**
 * What each direction does in a mailbox, for a row in a given read state.
 *
 *   - Everywhere but the two below: left is Trash, right toggles read.
 *   - **Trash**: left restores to the Inbox (deleting forever by a swipe is too easy to
 *     do by accident); right still toggles read.
 *   - **Drafts**: left discards the draft, with Undo; right does nothing, since a draft
 *     has no read state.
 */
export function swipeActionsFor(mailbox: string, unread: boolean): SwipeActions {
  const read: SwipeAction = unread ? "markRead" : "markUnread";
  if (mailbox === "drafts") return { left: "discard", right: null };
  if (mailbox === "trash") return { left: "restore", right: read };
  return { left: "trash", right: read };
}

/** The words the backdrop shows for an action. */
export const SWIPE_LABEL: Record<SwipeAction, string> = {
  trash: "Trash",
  discard: "Discard",
  restore: "Restore",
  markRead: "Mark read",
  markUnread: "Mark unread",
};

/** True when a touch at `x` is in either system edge zone of a screen `width` wide. */
export function inEdgeZone(x: number, width: number, edge = EDGE_PX): boolean {
  return x < edge || x > width - edge;
}

export type Axis = "pending" | "horizontal" | "vertical";

/**
 * Lock the axis once the finger has moved far enough. Horizontal only when the motion
 * is mostly sideways; a tie is a scroll, because scrolling is the commoner intent and
 * the cheaper one to get wrong.
 */
export function lockAxis(dx: number, dy: number, lock = AXIS_LOCK_PX): Axis {
  if (Math.hypot(dx, dy) < lock) return "pending";
  return Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
}

/** The direction a horizontal offset points, in the reading direction's terms. */
export function directionOf(dx: number, rtl = false): SwipeDirection | null {
  if (dx === 0) return null;
  const physical: SwipeDirection = dx < 0 ? "left" : "right";
  if (!rtl) return physical;
  return physical === "left" ? "right" : "left";
}

/**
 * Where the row is drawn for a finger offset `dx`: on the finger in an enabled
 * direction, and pinned at 0 in a disabled one.
 */
export function rowOffset(dx: number, actions: SwipeActions, rtl = false): number {
  const direction = directionOf(dx, rtl);
  if (!direction || !actions[direction]) return 0;
  return dx;
}

/** Whether an offset is past the commit line for a row `width` wide. */
export function pastThreshold(offset: number, width: number, fraction = COMMIT_FRACTION): boolean {
  return width > 0 && Math.abs(offset) >= width * fraction;
}

/**
 * What letting go does: the direction to commit, or null to spring back.
 *
 * `velocity` is px/ms along x (negative is leftward). A fling commits only in the
 * direction the row has actually been pulled, so flicking back toward the start
 * cancels rather than firing the other side.
 */
export function releaseOutcome({
  offset,
  width,
  velocity,
  actions,
  rtl = false,
}: {
  offset: number;
  width: number;
  velocity: number;
  actions: SwipeActions;
  rtl?: boolean;
}): SwipeDirection | null {
  const direction = directionOf(offset, rtl);
  if (!direction || !actions[direction]) return null;
  if (pastThreshold(offset, width)) {
    // Past the line but flung back toward the start: the user changed their mind.
    if (Math.sign(velocity) === -Math.sign(offset) && Math.abs(velocity) >= FLING_VELOCITY) return null;
    return direction;
  }
  const fling =
    Math.abs(velocity) >= FLING_VELOCITY && Math.sign(velocity) === Math.sign(offset) && Math.abs(offset) >= FLING_MIN_PX;
  return fling ? direction : null;
}

/** Velocity over the last `VELOCITY_WINDOW_MS`, from timestamped x samples. */
export class VelocityTracker {
  private samples: { x: number; at: number }[] = [];

  add(x: number, at: number): void {
    this.samples.push({ x, at });
    const cutoff = at - VELOCITY_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[0]!.at < cutoff) this.samples.shift();
  }

  /** px/ms; 0 with fewer than two samples or no elapsed time. */
  velocity(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.at <= first.at) return 0;
    return (last.x - first.x) / (last.at - first.at);
  }

  reset(): void {
    this.samples = [];
  }
}

export type SwipeMove =
  /** Not decided yet: nothing moves. */
  | { phase: "pending" }
  /** A scroll (or an ignored touch): leave it to the browser for the rest of the touch. */
  | { phase: "ignored" }
  /** A swipe: draw the row at `offset`; `armed` is past the commit line. */
  | { phase: "swiping"; offset: number; direction: SwipeDirection | null; armed: boolean };

/**
 * One touch, from down to up. Feed it pointer positions; it says what to draw and, on
 * release, what to do. The component owns the DOM; this owns every decision.
 */
export class SwipeGesture {
  private readonly velocity = new VelocityTracker();
  private axis: Axis = "pending";
  private offset = 0;
  private readonly ignored: boolean;
  private readonly rtl: boolean;

  constructor(
    private readonly start: { x: number; y: number; at: number },
    private readonly width: number,
    private readonly actions: SwipeActions,
    { screenWidth, rtl = false }: { screenWidth: number; rtl?: boolean },
  ) {
    this.rtl = rtl;
    this.ignored = inEdgeZone(start.x, screenWidth) || (!actions.left && !actions.right);
    this.velocity.add(start.x, start.at);
  }

  /** True once this touch is a swipe. */
  get swiping(): boolean {
    return this.axis === "horizontal" && !this.ignored;
  }

  move(x: number, y: number, at: number): SwipeMove {
    if (this.ignored || this.axis === "vertical") return { phase: "ignored" };
    const dx = x - this.start.x;
    const dy = y - this.start.y;
    this.velocity.add(x, at);
    if (this.axis === "pending") {
      this.axis = lockAxis(dx, dy);
      if (this.axis === "pending") return { phase: "pending" };
      if (this.axis === "vertical") return { phase: "ignored" };
    }
    this.offset = rowOffset(dx, this.actions, this.rtl);
    return {
      phase: "swiping",
      offset: this.offset,
      direction: this.offset === 0 ? null : directionOf(this.offset, this.rtl),
      armed: this.offset !== 0 && pastThreshold(this.offset, this.width),
    };
  }

  /** The direction to commit, or null to spring back (or when this was never a swipe). */
  release(): SwipeDirection | null {
    if (!this.swiping) return null;
    return releaseOutcome({
      offset: this.offset,
      width: this.width,
      velocity: this.velocity.velocity(),
      actions: this.actions,
      rtl: this.rtl,
    });
  }
}
