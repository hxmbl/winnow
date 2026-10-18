import { describe, expect, it } from "vitest";
import {
  SETUP_PROGRESS_KEY,
  clearSetupProgress,
  doneSummary,
  isWorthResuming,
  loadSetupProgress,
  markDone,
  parseSetupProgress,
  saveSetupProgress,
} from "./setupProgress";
import { WEB_CREDENTIALS_KEY } from "../core/session/credentials";

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("setup progress", () => {
  it("round-trips the step, the ticks and the client ID draft", () => {
    const store = memory();
    saveSetupProgress({ step: 2, done: ["project", "apis"], kind: "web", clientId: " 123-abc.apps.googleusercontent.com " }, store);
    expect(loadSetupProgress("web", store)).toEqual({
      step: 2,
      done: ["project", "apis"],
      kind: "web",
      clientId: "123-abc.apps.googleusercontent.com",
    });
  });

  it("never keeps a secret, whatever it is handed", () => {
    const store = memory();
    const sneaky = { step: 4, done: [], kind: "web", clientId: "x", clientSecret: "s3cret" } as Parameters<typeof saveSetupProgress>[0];
    saveSetupProgress(sneaky, store);
    expect(store.map.get(SETUP_PROGRESS_KEY)).not.toContain("s3cret");
  });

  it("keeps its own key, apart from the client's", () => {
    expect(SETUP_PROGRESS_KEY).not.toBe(WEB_CREDENTIALS_KEY);
    expect(SETUP_PROGRESS_KEY.startsWith("winnow.google.")).toBe(true);
  });

  it("drops a record with nothing to resume", () => {
    const store = memory();
    store.setItem(SETUP_PROGRESS_KEY, "{}");
    saveSetupProgress({ step: 0, done: [], kind: "web", clientId: "  " }, store);
    expect(store.map.has(SETUP_PROGRESS_KEY)).toBe(false);
    expect(isWorthResuming(null)).toBe(false);
  });

  it("ignores a record made for the other build", () => {
    const store = memory();
    saveSetupProgress({ step: 3, done: ["project"], kind: "desktop", clientId: "" }, store);
    expect(loadSetupProgress("web", store)).toBeNull();
    expect(loadSetupProgress("desktop", store)?.step).toBe(3);
  });

  it("survives junk: bad JSON, unknown steps, out-of-range indexes", () => {
    expect(parseSetupProgress("{not json", "web")).toBeNull();
    expect(parseSetupProgress("null", "web")).toBeNull();
    expect(parseSetupProgress(JSON.stringify({ kind: "web", step: 99, done: ["apis", "bogus", 4, "apis"] }), "web")).toEqual({
      step: 4,
      done: ["apis"],
      kind: "web",
      clientId: "",
    });
  });

  it("clears, and storage that throws is never an error", () => {
    const store = memory();
    saveSetupProgress({ step: 1, done: [], kind: "web", clientId: "" }, store);
    clearSetupProgress(store);
    expect(store.map.size).toBe(0);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadSetupProgress("web", broken)).toBeNull();
    expect(() => saveSetupProgress({ step: 1, done: [], kind: "web", clientId: "" }, broken)).not.toThrow();
    expect(() => clearSetupProgress(broken)).not.toThrow();
  });

  it("ticks steps in walkthrough order and summarises them", () => {
    expect(markDone(["consent"], "project")).toEqual(["project", "consent"]);
    expect(markDone(["project"], "project")).toEqual(["project"]);
    expect(doneSummary([])).toBe("0 of 5 done");
    expect(doneSummary(["project", "apis"])).toBe("2 of 5 done");
  });
});
