import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GLIDE_MAX_VIEWPORTS,
  KEY_SCROLL_DURATION,
  KEY_SCROLL_STEP,
  clamp,
  easeOutCubic,
  glideable,
  positionAt,
  retarget,
  retargetTo,
  smoothScrollTarget,
  smoothScrollTo,
} from "./keyScroll";
import { computeOffsets, revealTarget, rowClearance } from "./windowing";

describe("easeOutCubic", () => {
  it("starts at 0, ends at 1 and clamps outside", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-0.5)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it("eases out: quick at first, slow at the end, never backwards", () => {
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    // More than half the distance in the first quarter.
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.5);
    let last = 0;
    for (let i = 1; i <= 20; i += 1) {
      const v = easeOutCubic(i / 20);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});

describe("clamp", () => {
  it("keeps a value inside the range", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(7, 0, 10)).toBe(7);
  });
});

describe("retarget", () => {
  it("keeps the step distance and the chosen curve length", () => {
    expect(KEY_SCROLL_STEP).toBe(120);
    expect(KEY_SCROLL_DURATION).toBeGreaterThanOrEqual(120);
    expect(KEY_SCROLL_DURATION).toBeLessThanOrEqual(180);
  });

  it("starts a glide from where the content is", () => {
    const glide = retarget(null, 300, 120, 1000, 5000, false);
    expect(glide).toEqual({ from: 300, to: 420, start: 1000, duration: KEY_SCROLL_DURATION });
  });

  it("adds a press to the distance still to go instead of restarting", () => {
    const first = retarget(null, 0, 120, 0, 5000, false);
    // Halfway through, a second press: the target moves on by a step from the old
    // target, and the curve picks up from where the content is now.
    const mid = positionAt(first, KEY_SCROLL_DURATION / 2).top;
    const second = retarget(first, mid, 120, KEY_SCROLL_DURATION / 2, 5000, false);
    expect(second.to).toBe(240);
    expect(second.from).toBe(mid);
    expect(positionAt(second, KEY_SCROLL_DURATION / 2).top).toBe(mid);
  });

  it("accumulates a held key's repeats", () => {
    let glide = retarget(null, 0, 120, 0, 10_000, false);
    for (let i = 1; i <= 9; i += 1) {
      const now = i * 33;
      glide = retarget(glide, positionAt(glide, now).top, 120, now, 10_000, false);
    }
    expect(glide.to).toBe(1200);
  });

  it("lets a press the other way cancel out", () => {
    const down = retarget(null, 500, 120, 0, 5000, false);
    const up = retarget(down, positionAt(down, 40).top, -120, 40, 5000, false);
    expect(up.to).toBe(500);
  });

  it("clamps at the top and the bottom", () => {
    expect(retarget(null, 50, -120, 0, 5000, false).to).toBe(0);
    expect(retarget(null, 4950, 120, 0, 5000, false).to).toBe(5000);
    // Pressing on past the bottom does not bank distance to scroll back through.
    let glide = retarget(null, 4900, 120, 0, 5000, false);
    glide = retarget(glide, 4950, 120, 10, 5000, false);
    glide = retarget(glide, 4990, 120, 20, 5000, false);
    expect(glide.to).toBe(5000);
    expect(retarget(glide, 5000, -120, 30, 5000, false).to).toBe(4880);
  });

  it("treats a body that fits as having nowhere to go", () => {
    expect(retarget(null, 0, 120, 0, -20, false).to).toBe(0);
  });

  it("lands at once under reduced motion", () => {
    const glide = retarget(null, 100, 120, 0, 5000, true);
    expect(glide.duration).toBe(0);
    expect(positionAt(glide, 0)).toEqual({ top: 220, done: true });
  });
});

describe("positionAt", () => {
  it("follows the curve and arrives on time", () => {
    const glide = retarget(null, 0, 120, 0, 5000, false);
    expect(positionAt(glide, 0)).toEqual({ top: 0, done: false });
    expect(positionAt(glide, KEY_SCROLL_DURATION / 2).top).toBeCloseTo(105);
    expect(positionAt(glide, KEY_SCROLL_DURATION)).toEqual({ top: 120, done: true });
    expect(positionAt(glide, KEY_SCROLL_DURATION * 3)).toEqual({ top: 120, done: true });
  });

  it("goes up as smoothly as down", () => {
    const glide = retarget(null, 600, -120, 0, 5000, false);
    expect(positionAt(glide, KEY_SCROLL_DURATION / 2).top).toBeCloseTo(495);
  });
});

// ── The message list's reveal on j / k ─────────────────────────────────────

describe("retargetTo", () => {
  it("glides from where the list is to the row's scroll top", () => {
    expect(retargetTo(200, 680, 1000, 5000, false)).toEqual({
      from: 200,
      to: 680,
      start: 1000,
      duration: KEY_SCROLL_DURATION,
    });
  });

  it("replaces the target mid-glide rather than adding to it, with no jump", () => {
    const first = retargetTo(0, 600, 0, 5000, false);
    const now = KEY_SCROLL_DURATION / 3;
    const mid = positionAt(first, now).top;
    // `j` again a third of the way in: the next row's top is the new end.
    const second = retargetTo(mid, 1200, now, 5000, false);
    expect(second.to).toBe(1200);
    expect(second.from).toBe(mid);
    expect(positionAt(second, now).top).toBe(mid);
    // Still moving forward on the very next frame, and lands on time from the press.
    expect(positionAt(second, now + 16).top).toBeGreaterThan(mid);
    expect(positionAt(second, now + KEY_SCROLL_DURATION)).toEqual({ top: 1200, done: true });
  });

  it("follows rapid presses without lagging behind the last one", () => {
    let glide = retargetTo(0, 600, 0, 50_000, false);
    let at = 0;
    for (let i = 2; i <= 10; i += 1) {
      at += 30;
      glide = retargetTo(positionAt(glide, at).top, i * 600, at, 50_000, false);
    }
    expect(glide.to).toBe(6000);
    expect(positionAt(glide, at + KEY_SCROLL_DURATION)).toEqual({ top: 6000, done: true });
  });

  it("turns round smoothly when k follows j", () => {
    const down = retargetTo(1000, 1600, 0, 5000, false);
    const mid = positionAt(down, 50).top;
    const up = retargetTo(mid, 1000, 50, 5000, false);
    expect(positionAt(up, 50).top).toBe(mid);
    expect(positionAt(up, 50 + KEY_SCROLL_DURATION).top).toBe(1000);
  });

  it("clamps to the scrollable range", () => {
    expect(retargetTo(100, -50, 0, 5000, false).to).toBe(0);
    expect(retargetTo(100, 9000, 0, 5000, false).to).toBe(5000);
    expect(retargetTo(100, 300, 0, -10, false)).toMatchObject({ from: 0, to: 0 });
  });

  it("lands at once under reduced motion", () => {
    const glide = retargetTo(100, 700, 0, 5000, true);
    expect(positionAt(glide, 0)).toEqual({ top: 700, done: true });
  });
});

describe("glideable", () => {
  it("glides a screen or two, and jumps anything further", () => {
    expect(GLIDE_MAX_VIEWPORTS).toBe(2);
    expect(glideable(0, 800, 800)).toBe(true);
    expect(glideable(1600, 0, 800)).toBe(true);
    expect(glideable(0, 1601, 800)).toBe(false);
    expect(glideable(0, 1, 0)).toBe(false);
  });
});

describe("rowClearance", () => {
  // A 600px viewport with an 80px band of floating chrome over its top.
  it("is 0 for a row fully in view", () => {
    expect(rowClearance(80, 160, 80, 600)).toBe(0);
    expect(rowClearance(520, 600, 80, 600)).toBe(0);
  });

  it("scrolls up to bring a row out from under the chrome", () => {
    expect(rowClearance(40, 120, 80, 600)).toBe(-40);
    expect(rowClearance(-200, -120, 80, 600)).toBe(-280);
  });

  it("scrolls down just enough to show a row's bottom", () => {
    expect(rowClearance(560, 640, 80, 600)).toBe(40);
  });

  it("never pushes a row taller than the view under the chrome", () => {
    expect(rowClearance(300, 1200, 80, 600)).toBe(220);
  });
});

describe("revealTarget", () => {
  // Ten 100px rows.
  const offsets = computeOffsets(10, Array(10).fill(100), () => 100);
  const desktop = { contentTop: 0, coveredTop: 0, clientHeight: 400, scrollHeight: 1000 };
  const phone = { contentTop: 120, coveredTop: 100, clientHeight: 400, scrollHeight: 1120 };

  it("leaves a row already in view alone", () => {
    expect(revealTarget(offsets, 2, 0, desktop)).toBeNull();
    expect(revealTarget(offsets, 3, 0, desktop)).toBeNull();
  });

  it("puts an off-screen row at the top, clamped at the end", () => {
    expect(revealTarget(offsets, 4, 0, desktop)).toBe(400);
    expect(revealTarget(offsets, 1, 300, desktop)).toBe(100);
    expect(revealTarget(offsets, 9, 0, desktop)).toBe(600);
  });

  it("lands below the floating chrome on a phone", () => {
    // Row 4 sits at 120 + 400 = 520 in the scroller; its top goes just under the band.
    expect(revealTarget(offsets, 4, 0, phone)).toBe(420);
    expect(revealTarget(offsets, 1, 0, phone)).toBeNull();
  });

  it("judges from the glide's destination, so j mid-glide aims at the next row", () => {
    // A glide to 400 is in flight (rows 4–7 on arrival). Pressing j for row 5 asks
    // nothing more of it, though row 5 is still below the view at the current spot.
    expect(revealTarget(offsets, 5, 400, desktop)).toBeNull();
    expect(revealTarget(offsets, 5, 120, desktop)).toBe(500);
    // Row 8 is past the destination's bottom: the glide is retargeted on to it.
    expect(revealTarget(offsets, 8, 400, desktop)).toBe(600);
  });
});

describe("smoothScrollTo (the list's driver)", () => {
  let clock = 0;
  let queue: ((now: number) => void)[] = [];
  const frame = (ms = 16) => {
    clock += ms;
    const run = queue;
    queue = [];
    for (const cb of run) cb(clock);
  };
  const scroller = () => ({ scrollTop: 0, scrollHeight: 5000, clientHeight: 800 }) as unknown as HTMLElement;
  const setup = (reduce = false) => {
    clock = 0;
    queue = [];
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (cb: (now: number) => void) => queue.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("matchMedia", () => ({ matches: reduce }));
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("eases to the target, then runs onDone once", () => {
    setup();
    const el = scroller();
    let done = 0;
    expect(smoothScrollTo(el, 600, () => (done += 1))).toBe(true);
    expect(el.scrollTop).toBe(0);
    expect(smoothScrollTarget(el)).toBe(600);
    frame();
    expect(el.scrollTop).toBeGreaterThan(0);
    expect(el.scrollTop).toBeLessThan(600);
    for (let i = 0; i < 12; i += 1) frame();
    expect(el.scrollTop).toBe(600);
    expect(done).toBe(1);
    expect(smoothScrollTarget(el)).toBeNull();
  });

  it("retargets mid-glide from where it is, and only the latest onDone runs", () => {
    setup();
    const el = scroller();
    const calls: string[] = [];
    smoothScrollTo(el, 600, () => calls.push("first"));
    frame();
    frame();
    const mid = el.scrollTop;
    smoothScrollTo(el, 1200, () => calls.push("second"));
    frame(1);
    expect(el.scrollTop).toBeGreaterThanOrEqual(mid);
    for (let i = 0; i < 12; i += 1) frame();
    expect(el.scrollTop).toBe(1200);
    expect(calls).toEqual(["second"]);
  });

  it("stops when a wheel or touch moves the list mid-glide", () => {
    setup();
    const el = scroller();
    let done = 0;
    smoothScrollTo(el, 600, () => (done += 1));
    frame();
    el.scrollTop += 300;
    const wheeled = el.scrollTop;
    for (let i = 0; i < 12; i += 1) frame();
    expect(el.scrollTop).toBe(wheeled);
    expect(done).toBe(0);
    expect(smoothScrollTarget(el)).toBeNull();
  });

  it("jumps under reduced motion, and for a move of more than two screens", () => {
    setup(true);
    const calm = scroller();
    let done = 0;
    expect(smoothScrollTo(calm, 600, () => (done += 1))).toBe(false);
    expect(calm.scrollTop).toBe(600);
    expect(done).toBe(1);

    setup(false);
    const far = scroller();
    expect(smoothScrollTo(far, 2000)).toBe(false);
    expect(far.scrollTop).toBe(2000);
  });
});
