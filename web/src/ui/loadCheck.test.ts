import { describe, expect, it } from "vitest";
import {
  LOAD_CHECK_EVERY,
  LOAD_COUNT_KEY,
  countLoad,
  countsLoads,
  loadCheckDue,
  parseLoadCount,
  type LoadCheckInput,
} from "./loadCheck";
import type { UpdateChannel, UpdateRuntime } from "../core/updates/updates";

const runtime = (channel: UpdateChannel): UpdateRuntime => ({ channel, version: "1.5.5", arch: "aarch64" });

/**
 * Loads `1..loads` the way `useUpdates` runs them: count the load, start the check when
 * due, and reset the count once a check has run. `when(load)` overrides the conditions
 * of one load. Returns the loads that started a check.
 */
function simulate(
  loads: number,
  base: Omit<LoadCheckInput, "count">,
  when: (load: number) => Partial<Omit<LoadCheckInput, "count">> = () => ({}),
): number[] {
  let count = 0;
  const fired: number[] = [];
  for (let load = 1; load <= loads; load += 1) {
    if (!countsLoads(base.runtime)) continue;
    count = countLoad(count);
    if (loadCheckDue({ ...base, ...when(load), count })) {
      fired.push(load);
      count = 0;
    }
  }
  return fired;
}

const native = { runtime: runtime("android"), auto: true, online: true, automated: false, inFlight: false };

describe("the every-tenth-load update check", () => {
  it("is every 10 loads, one named constant", () => {
    expect(LOAD_CHECK_EVERY).toBe(10);
    expect(LOAD_COUNT_KEY.startsWith("winnow.")).toBe(true);
  });

  it("fires on the 10th and 20th load, and on no other", () => {
    expect(simulate(25, native)).toEqual([10, 20]);
    expect(simulate(9, native)).toEqual([]);
  });

  it("fires on every native build", () => {
    for (const channel of ["macos", "appimage", "deb", "android", "manual"] as const) {
      expect(simulate(20, { ...native, runtime: runtime(channel) })).toEqual([10, 20]);
    }
  });

  it("never counts or fires on the web build, the Docker image, or before the runtime is known", () => {
    for (const r of [runtime("web"), runtime("docker"), null]) {
      expect(countsLoads(r)).toBe(false);
      expect(simulate(30, { ...native, runtime: r })).toEqual([]);
      expect(loadCheckDue({ ...native, runtime: r, count: LOAD_CHECK_EVERY })).toBe(false);
    }
  });

  it("never stacks on a check already running; the due load waits for a later one", () => {
    expect(loadCheckDue({ ...native, count: LOAD_CHECK_EVERY, inFlight: true })).toBe(false);
    expect(simulate(20, native, (load) => (load === 10 ? { inFlight: true } : {}))).toEqual([11]);
  });

  it("waits out being offline, then checks", () => {
    expect(simulate(20, native, (load) => (load >= 10 && load <= 12 ? { online: false } : {}))).toEqual([13]);
  });

  it("respects automatic checks being off, and automation that did not opt in", () => {
    expect(simulate(30, { ...native, auto: false })).toEqual([]);
    expect(simulate(30, { ...native, automated: true })).toEqual([]);
  });

  it("caps the count, so a long time offline is one check, not many", () => {
    let count = 0;
    for (let i = 0; i < 1000; i += 1) count = countLoad(count);
    expect(count).toBe(LOAD_CHECK_EVERY);
  });

  it("reads a stored count defensively", () => {
    expect(parseLoadCount("7")).toBe(7);
    expect(parseLoadCount(" 3 ")).toBe(3);
    for (const raw of [null, undefined, "", "-1", "1.5", "abc", "1e3", "9999999999"]) expect(parseLoadCount(raw)).toBe(0);
  });
});
