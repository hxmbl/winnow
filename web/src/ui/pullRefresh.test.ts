import { describe, expect, it } from "vitest";
import {
  PULL_MAX,
  PULL_THRESHOLD,
  crossedThreshold,
  pastPullThreshold,
  phaseFor,
  pullAllowed,
  pullDistance,
  pullIntent,
  pullRotation,
} from "./pullRefresh";
import { AXIS_LOCK_PX, lockAxis } from "./swipe";

const ready = { connected: true, scrollTop: 0, menuOpen: false, selecting: false, overlay: false, syncing: false };

describe("pull to refresh", () => {
  it("has a ~70px threshold and a ceiling above it", () => {
    expect(PULL_THRESHOLD).toBe(70);
    expect(PULL_MAX).toBeGreaterThan(PULL_THRESHOLD);
  });

  it("follows the finger at a resistance, monotonic, never past the ceiling", () => {
    expect(pullDistance(-40)).toBe(0);
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(100)).toBeCloseTo(55);
    let last = 0;
    for (let dy = 0; dy <= 2000; dy += 10) {
      const d = pullDistance(dy);
      expect(d).toBeGreaterThanOrEqual(last);
      expect(d).toBeLessThanOrEqual(PULL_MAX);
      last = d;
    }
  });

  it("arms at the threshold and ticks when it is crossed, either way", () => {
    const at = PULL_THRESHOLD / 0.55;
    expect(pastPullThreshold(pullDistance(at - 2))).toBe(false);
    expect(pastPullThreshold(pullDistance(at + 2))).toBe(true);
    expect(crossedThreshold(60, 72)).toBe(true);
    expect(crossedThreshold(72, 60)).toBe(true);
    expect(crossedThreshold(20, 60)).toBe(false);
    expect(crossedThreshold(80, 100)).toBe(false);
    expect(phaseFor(0)).toBe("idle");
    expect(phaseFor(30)).toBe("pulling");
    expect(phaseFor(70)).toBe("armed");
  });

  it("turns the sync icon with the pull: a full turn at the threshold", () => {
    expect(pullRotation(0)).toBe(0);
    expect(pullRotation(35)).toBe(180);
    expect(pullRotation(70)).toBe(360);
  });

  it("locks the axis exactly as the swipes do, so the two never both claim a touch", () => {
    expect(pullIntent(2, 4)).toBe("pending");
    expect(pullIntent(30, 8)).toBe("swipe");
    expect(pullIntent(-30, 8)).toBe("swipe");
    expect(pullIntent(4, 30)).toBe("pull");
    expect(pullIntent(4, -30)).toBe("scroll");
    // A tie is vertical, as in swipe.ts.
    expect(pullIntent(20, 20)).toBe("pull");
    for (const [dx, dy] of [[11, 3], [3, 11], [-8, 8], [9, -2], [0, AXIS_LOCK_PX]]) {
      const axis = lockAxis(dx, dy);
      const intent = pullIntent(dx, dy);
      expect(axis === "horizontal", `${dx},${dy}`).toBe(intent === "swipe");
    }
  });

  it("starts only at the very top, with an account, and nothing else on screen", () => {
    expect(pullAllowed(ready)).toBe(true);
    expect(pullAllowed({ ...ready, scrollTop: 1 })).toBe(false);
    expect(pullAllowed({ ...ready, connected: false })).toBe(false);
    expect(pullAllowed({ ...ready, menuOpen: true })).toBe(false);
    expect(pullAllowed({ ...ready, selecting: true })).toBe(false);
    expect(pullAllowed({ ...ready, overlay: true })).toBe(false);
    expect(pullAllowed({ ...ready, syncing: true })).toBe(false);
  });
});
