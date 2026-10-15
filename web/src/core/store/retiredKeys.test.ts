import { describe, expect, it } from "vitest";
import { RETIRED_STORAGE_KEYS, dropRetiredKeys } from "./retiredKeys";

/** A `Storage` stand-in: a map, plus whatever `removeItem` should do instead. */
function fakeStorage(seed: Record<string, string>) {
  const items = new Map(Object.entries(seed));
  return {
    items,
    removeItem(key: string) {
      items.delete(key);
    },
  };
}

describe("retired storage keys", () => {
  it("retires the hidden-buckets list", () => {
    expect(RETIRED_STORAGE_KEYS).toContain("winnow.mutedFilters.v1");
  });

  it("deletes the hidden-buckets list an earlier build wrote, and nothing else", () => {
    const storage = fakeStorage({
      "winnow.mutedFilters.v1": JSON.stringify(["newsletters", "promotional"]),
      "winnow.activeFilters.v1": JSON.stringify(["builtin:important"]),
      "winnow.preferences.v1": "{}",
    });
    dropRetiredKeys(() => storage);
    expect(storage.items.has("winnow.mutedFilters.v1")).toBe(false);
    expect([...storage.items.keys()].sort()).toEqual(["winnow.activeFilters.v1", "winnow.preferences.v1"]);
  });

  it("is a no-op when there is nothing to delete", () => {
    const storage = fakeStorage({ "winnow.preferences.v1": "{}" });
    dropRetiredKeys(() => storage);
    expect([...storage.items.keys()]).toEqual(["winnow.preferences.v1"]);
  });

  it("never throws, whether storage is missing, unreachable or refuses", () => {
    expect(() => dropRetiredKeys(() => undefined)).not.toThrow();
    expect(() => dropRetiredKeys(() => null)).not.toThrow();
    expect(() =>
      dropRetiredKeys(() => {
        throw new Error("SecurityError");
      }),
    ).not.toThrow();
    expect(() =>
      dropRetiredKeys(() => ({
        removeItem() {
          throw new Error("QuotaExceededError");
        },
      })),
    ).not.toThrow();
  });
});
