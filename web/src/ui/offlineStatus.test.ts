import { describe, expect, it } from "vitest";
import { offlineStatusText } from "./offlineStatus";

describe("offlineStatusText", () => {
  it("is silent when nothing waits", () => {
    expect(offlineStatusText({ waiting: 0, sends: 0, state: "idle" }, false)).toBeNull();
    expect(offlineStatusText({ waiting: 0, sends: 0, state: "auth" }, true)).toBeNull();
  });

  it("counts the changes, singular and plural", () => {
    expect(offlineStatusText({ waiting: 1, sends: 0, state: "offline" }, false)).toBe("Offline: 1 change waiting");
    expect(offlineStatusText({ waiting: 3, sends: 1, state: "offline" }, false)).toBe("Offline: 3 changes waiting");
  });

  it("says why they wait", () => {
    expect(offlineStatusText({ waiting: 2, sends: 0, state: "idle" }, false)).toBe("Offline: 2 changes waiting");
    expect(offlineStatusText({ waiting: 2, sends: 0, state: "auth" }, true)).toBe("Sign in again: 2 changes waiting");
    expect(offlineStatusText({ waiting: 2, sends: 0, state: "backoff" }, true)).toBe("Can't reach Gmail: 2 changes waiting");
    expect(offlineStatusText({ waiting: 2, sends: 0, state: "replaying" }, true)).toBe("Syncing 2 changes…");
  });
});
