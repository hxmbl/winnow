import { describe, expect, it } from "vitest";
import {
  AXIS_LOCK_PX,
  COMMIT_FRACTION,
  EDGE_PX,
  isLongPressMenu,
  swipesWith,
  FLING_MIN_PX,
  FLING_VELOCITY,
  SwipeGesture,
  VelocityTracker,
  directionOf,
  inEdgeZone,
  lockAxis,
  pastThreshold,
  releaseOutcome,
  removesRow,
  rowOffset,
  swipeActionsFor,
  type SwipeActions,
} from "./swipe";

const BOTH: SwipeActions = { left: "trash", right: "markRead" };
const LEFT_ONLY: SwipeActions = { left: "discard", right: null };
const SCREEN = 390;
const ROW = 380;

/** A gesture from the middle of the screen, moved through `points` 16ms apart. */
function drive(points: [number, number][], actions = BOTH, startX = 200, startY = 300) {
  const gesture = new SwipeGesture({ x: startX, y: startY, at: 0 }, ROW, actions, { screenWidth: SCREEN });
  let last = null as ReturnType<SwipeGesture["move"]> | null;
  points.forEach(([dx, dy], i) => {
    last = gesture.move(startX + dx, startY + dy, (i + 1) * 16);
  });
  return { gesture, last: last! };
}

describe("edge exclusion", () => {
  it("leaves both system edges to Android's back gesture", () => {
    expect(inEdgeZone(0, SCREEN)).toBe(true);
    expect(inEdgeZone(EDGE_PX - 1, SCREEN)).toBe(true);
    expect(inEdgeZone(SCREEN - EDGE_PX + 1, SCREEN)).toBe(true);
    expect(inEdgeZone(EDGE_PX, SCREEN)).toBe(false);
    expect(inEdgeZone(SCREEN / 2, SCREEN)).toBe(false);
  });

  it("ignores a whole touch that starts in an edge zone", () => {
    const { gesture, last } = drive([[-40, 0], [-200, 0]], BOTH, 10);
    expect(last.phase).toBe("ignored");
    expect(gesture.release()).toBeNull();
    const right = drive([[-40, 0], [-200, 0]], BOTH, SCREEN - 5);
    expect(right.last.phase).toBe("ignored");
  });
});

describe("axis lock", () => {
  it("decides nothing inside the lock distance", () => {
    expect(lockAxis(AXIS_LOCK_PX - 1, 0)).toBe("pending");
    expect(lockAxis(5, 5)).toBe("pending");
    expect(drive([[-6, 2]]).last.phase).toBe("pending");
  });

  it("is horizontal for sideways motion and vertical otherwise, ties included", () => {
    expect(lockAxis(-12, 3)).toBe("horizontal");
    expect(lockAxis(3, 12)).toBe("vertical");
    expect(lockAxis(10, 10)).toBe("vertical");
  });

  it("never turns a scroll into a swipe later in the touch", () => {
    const { gesture, last } = drive([[0, 14], [-150, 20], [-300, 20]]);
    expect(last.phase).toBe("ignored");
    expect(gesture.swiping).toBe(false);
    expect(gesture.release()).toBeNull();
  });

  it("keeps a locked swipe a swipe when the finger drifts vertically", () => {
    const { last } = drive([[-14, 0], [-60, 40], [-90, 80]]);
    expect(last).toMatchObject({ phase: "swiping", offset: -90, direction: "left" });
  });
});

describe("threshold", () => {
  it("commits past the line, springs back short of it", () => {
    expect(pastThreshold(ROW * COMMIT_FRACTION, ROW)).toBe(true);
    expect(pastThreshold(ROW * COMMIT_FRACTION - 1, ROW)).toBe(false);
    expect(pastThreshold(-ROW * COMMIT_FRACTION, ROW)).toBe(true);
    expect(pastThreshold(100, 0)).toBe(false);
  });

  it("arms the gesture once past the line, and disarms coming back", () => {
    const line = Math.ceil(ROW * COMMIT_FRACTION);
    const steps: [number, number][] = [];
    for (let dx = -12; dx >= -line - 10; dx -= 8) steps.push([dx, 0]);
    const { gesture, last } = drive(steps);
    expect(last).toMatchObject({ phase: "swiping", direction: "left", armed: true });
    // Then held still for a moment, so there is no fling either way.
    const held = gesture.move(200 - line - 10, 300, 2_000);
    expect(held).toMatchObject({ armed: true });
    expect(gesture.move(200 - 40, 300, 2_200)).toMatchObject({ armed: false });
  });

  it("a slow short drag springs back", () => {
    const g = new SwipeGesture({ x: 200, y: 300, at: 0 }, ROW, BOTH, { screenWidth: SCREEN });
    g.move(185, 300, 100);
    g.move(150, 300, 400);
    g.move(140, 300, 900);
    expect(g.release()).toBeNull();
  });

  it("a slow long drag commits in its direction", () => {
    const g = new SwipeGesture({ x: 200, y: 300, at: 0 }, ROW, BOTH, { screenWidth: SCREEN });
    g.move(215, 300, 100);
    g.move(300, 300, 600);
    g.move(360, 300, 1_400);
    expect(g.release()).toBe("right");
  });
});

describe("fling", () => {
  it("commits a fast short flick that travelled far enough", () => {
    expect(releaseOutcome({ offset: -FLING_MIN_PX, width: ROW, velocity: -FLING_VELOCITY, actions: BOTH })).toBe("left");
    expect(releaseOutcome({ offset: FLING_MIN_PX + 5, width: ROW, velocity: 1.2, actions: BOTH })).toBe("right");
  });

  it("not one that barely moved, or one going back toward the start", () => {
    expect(releaseOutcome({ offset: -(FLING_MIN_PX - 1), width: ROW, velocity: -2, actions: BOTH })).toBeNull();
    expect(releaseOutcome({ offset: -80, width: ROW, velocity: 1.5, actions: BOTH })).toBeNull();
  });

  it("cancels a commit flung back from past the line", () => {
    expect(releaseOutcome({ offset: -ROW * 0.6, width: ROW, velocity: 1.2, actions: BOTH })).toBeNull();
    expect(releaseOutcome({ offset: -ROW * 0.6, width: ROW, velocity: 0.1, actions: BOTH })).toBe("left");
  });

  it("measures release velocity over the recent window only", () => {
    const tracker = new VelocityTracker();
    tracker.add(0, 0);
    tracker.add(5, 500);
    tracker.add(5, 900);
    tracker.add(85, 1_000);
    expect(tracker.velocity()).toBeCloseTo(80 / 100, 1);
    tracker.reset();
    expect(tracker.velocity()).toBe(0);
  });

  it("commits a real fast gesture end to end", () => {
    const g = new SwipeGesture({ x: 200, y: 300, at: 0 }, ROW, BOTH, { screenWidth: SCREEN });
    g.move(188, 300, 16);
    g.move(165, 300, 32);
    g.move(140, 300, 48);
    expect(g.release()).toBe("left");
  });
});

describe("directions per mailbox", () => {
  it("is Trash left and read right in ordinary mail", () => {
    expect(swipeActionsFor("inbox", true)).toEqual({ left: "trash", right: "markRead" });
    expect(swipeActionsFor("archive", false)).toEqual({ left: "trash", right: "markUnread" });
    expect(swipeActionsFor("sent", false).left).toBe("trash");
    expect(swipeActionsFor("spam", true).left).toBe("trash");
  });

  it("restores from the Trash and discards in Drafts, with no read swipe there", () => {
    expect(swipeActionsFor("trash", true)).toEqual({ left: "restore", right: "markRead" });
    expect(swipeActionsFor("drafts", false)).toEqual({ left: "discard", right: null });
    expect(removesRow("trash") && removesRow("discard") && removesRow("restore")).toBe(true);
    expect(removesRow("markRead") || removesRow("markUnread")).toBe(false);
  });

  it("does not move the row in a disabled direction", () => {
    expect(rowOffset(80, LEFT_ONLY)).toBe(0);
    expect(rowOffset(-80, LEFT_ONLY)).toBe(-80);
    const { gesture, last } = drive([[20, 0], [250, 0]], LEFT_ONLY);
    expect(last).toMatchObject({ phase: "swiping", offset: 0, direction: null, armed: false });
    expect(gesture.release()).toBeNull();
  });

  it("ignores every touch when no direction is enabled", () => {
    expect(drive([[-100, 0]], { left: null, right: null }).last.phase).toBe("ignored");
  });

  it("mirrors for a right-to-left layout when asked", () => {
    expect(directionOf(-10)).toBe("left");
    expect(directionOf(-10, true)).toBe("right");
    expect(directionOf(0)).toBeNull();
    expect(rowOffset(-80, { left: null, right: "markRead" }, true)).toBe(-80);
  });
});

describe("S Pen and other styluses", () => {
  it("swipes with a finger or a stylus tip, not a mouse", () => {
    expect(swipesWith({ pointerType: "touch", buttons: 1 })).toBe(true);
    expect(swipesWith({ pointerType: "pen", buttons: 1 })).toBe(true);
    expect(swipesWith({ pointerType: "mouse", buttons: 1 })).toBe(false);
  });

  it("not with the side button or the eraser held", () => {
    expect(swipesWith({ pointerType: "pen", buttons: 1 | 2 })).toBe(false);
    expect(swipesWith({ pointerType: "pen", buttons: 32 })).toBe(false);
  });

  it("treats a stylus long-press as select, but a side-button press as a right-click", () => {
    const menu = (pointerType: string, button: number) =>
      isLongPressMenu({ button, nativeEvent: Object.assign(new Event("contextmenu"), { pointerType }) });
    expect(menu("touch", 0)).toBe(true);
    expect(menu("pen", 0)).toBe(true);
    expect(menu("pen", 2)).toBe(false);
    expect(menu("mouse", 2)).toBe(false);
  });
});
