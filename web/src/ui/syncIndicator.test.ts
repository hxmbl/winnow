import { describe, expect, it } from "vitest";
import {
  FADE_MS,
  SHOW_DELAY_MS,
  badgePhaseMs,
  badgePlacement,
  nextBadgePhase,
  previewStatus,
  syncBadge,
  type BadgePhase,
} from "./syncIndicator";

describe("syncBadge", () => {
  it("is nothing while nothing waits", () => {
    expect(syncBadge({ waiting: 0, sends: 0, state: "idle" }, true)).toBeNull();
    expect(syncBadge({ waiting: 0, sends: 0, state: "replaying" }, true)).toBeNull();
  });

  it("spins while a change is on its way, labelled for screen readers as the bar was", () => {
    expect(syncBadge({ waiting: 1, sends: 0, state: "replaying" }, true)).toEqual({
      label: "Syncing 1 change…",
      busy: true,
      waiting: 1,
      state: "replaying",
    });
    expect(syncBadge({ waiting: 3, sends: 1, state: "idle" }, true)).toMatchObject({ label: "Syncing 3 changes…", busy: true });
  });

  it("is a still cloud while changes wait, saying why", () => {
    expect(syncBadge({ waiting: 2, sends: 0, state: "offline" }, true)).toMatchObject({ label: "Offline: 2 changes waiting", busy: false });
    expect(syncBadge({ waiting: 2, sends: 0, state: "replaying" }, false)).toMatchObject({ label: "Offline: 2 changes waiting", busy: false });
    expect(syncBadge({ waiting: 1, sends: 0, state: "backoff" }, true)).toMatchObject({ label: "Can't reach Gmail: 1 change waiting", busy: false });
    expect(syncBadge({ waiting: 1, sends: 0, state: "auth" }, true)).toMatchObject({ label: "Sign in again: 1 change waiting", busy: false });
  });
});

describe("nextBadgePhase", () => {
  const run = (events: ("on" | "off" | "timer")[]): BadgePhase =>
    events.reduce<BadgePhase>((phase, event) => nextBadgePhase(phase, event), "hidden");

  it("waits before showing, so a quick sync never flashes it", () => {
    expect(run(["on"])).toBe("waiting");
    expect(run(["on", "off"])).toBe("hidden");
    expect(run(["on", "off", "timer"])).toBe("hidden");
    expect(run(["on", "timer"])).toBe("shown");
  });

  it("fades out when the queue empties, and comes straight back if it fills again mid-fade", () => {
    expect(run(["on", "timer", "off"])).toBe("leaving");
    expect(run(["on", "timer", "off", "timer"])).toBe("hidden");
    expect(run(["on", "timer", "off", "on"])).toBe("shown");
  });

  it("ignores repeats", () => {
    expect(run(["on", "on", "timer", "on"])).toBe("shown");
    expect(run(["off", "off"])).toBe("hidden");
    expect(run(["timer"])).toBe("hidden");
  });

  it("times only the delay and the fade", () => {
    expect(badgePhaseMs("waiting")).toBe(SHOW_DELAY_MS);
    expect(badgePhaseMs("leaving")).toBe(FADE_MS);
    expect(badgePhaseMs("shown")).toBeNull();
    expect(badgePhaseMs("hidden")).toBeNull();
    expect(SHOW_DELAY_MS).toBeGreaterThanOrEqual(300);
  });
});

describe("badgePlacement", () => {
  it("sits beside the pill when there is one, and where it rests when not", () => {
    expect(badgePlacement(true)).toBe("beside");
    expect(badgePlacement(false)).toBe("centre");
  });
});

describe("previewStatus", () => {
  it("is honoured only under automation", () => {
    expect(previewStatus({ waiting: 1, state: "replaying" }, false)).toBeNull();
    expect(previewStatus({ waiting: 1, state: "replaying" }, true)).toEqual({ waiting: 1, sends: 0, state: "replaying" });
  });

  it("refuses anything that isn't a queue status", () => {
    expect(previewStatus(null, true)).toBeNull();
    expect(previewStatus("syncing", true)).toBeNull();
    expect(previewStatus({ waiting: -1, state: "idle" }, true)).toBeNull();
    expect(previewStatus({ waiting: 1, state: "spinning" }, true)).toBeNull();
  });
});
