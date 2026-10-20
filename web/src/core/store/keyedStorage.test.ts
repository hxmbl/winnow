import { describe, expect, it } from "vitest";
import { keyedStorage, memoryBacking, storageKey } from "./keyedStorage";

describe("the keyed storage helper", () => {
  it("keeps one key per feature, in one place", () => {
    expect(storageKey("snooze")).toBe("winnow.snooze.v1");
    expect(keyedStorage("scheduledSend", () => null).key).toBe("winnow.scheduledSend.v1");
  });

  it("reads back what it wrote, and forgets on clear", () => {
    const backing = memoryBacking();
    const slot = keyedStorage("snooze", () => backing);
    expect(slot.read()).toBeNull();
    expect(slot.write({ a: 1 })).toBe(true);
    expect(backing.dump()).toEqual({ "winnow.snooze.v1": '{"a":1}' });
    expect(slot.read()).toEqual({ a: 1 });
    slot.clear();
    expect(slot.read()).toBeNull();
  });

  it("reads a corrupt value as nothing, and survives storage that throws", () => {
    const backing = memoryBacking();
    backing.setItem("winnow.snooze.v1", "{not json");
    expect(keyedStorage("snooze", () => backing).read()).toBeNull();
    const throwing = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: (): void => {
        throw new Error("quota");
      },
      removeItem: (): void => {
        throw new Error("denied");
      },
    };
    const slot = keyedStorage("snooze", () => throwing);
    expect(slot.read()).toBeNull();
    expect(slot.write({})).toBe(false);
    expect(() => slot.clear()).not.toThrow();
    expect(keyedStorage("snooze", () => null).write({})).toBe(false);
  });
});
