import { describe, expect, it } from "vitest";
import { withReleaseSuffix } from "./buildVersion";
import { isNewer } from "./updates";

describe("the version a build reports", () => {
  it("carries a pre-release tag that extends the native version", () => {
    expect(withReleaseSuffix("1.6.0", "1.6.0-beta.2")).toBe("1.6.0-beta.2");
    expect(withReleaseSuffix("1.6.0", "v1.6.0-beta.2")).toBe("1.6.0-beta.2");
  });

  it("ignores no tag, the bare version, and a tag for another release", () => {
    expect(withReleaseSuffix("1.6.0", "")).toBe("1.6.0");
    expect(withReleaseSuffix("1.6.0", undefined)).toBe("1.6.0");
    expect(withReleaseSuffix("1.6.0", "1.6.0")).toBe("1.6.0");
    expect(withReleaseSuffix("1.6.0", "1.5.5-beta")).toBe("1.6.0");
    expect(withReleaseSuffix("1.6.0", "1.6.00-beta")).toBe("1.6.0");
    expect(withReleaseSuffix("1.6.0", "1.6.0-beta <x>")).toBe("1.6.0");
  });

  it("lets a beta install see the final release as newer", () => {
    expect(isNewer("1.6.0", withReleaseSuffix("1.6.0", "1.6.0-beta.2"))).toBe(true);
    expect(isNewer("1.6.0-beta.3", withReleaseSuffix("1.6.0", "1.6.0-beta.2"))).toBe(true);
    expect(isNewer("1.6.0", withReleaseSuffix("1.6.0", ""))).toBe(false);
  });
});
